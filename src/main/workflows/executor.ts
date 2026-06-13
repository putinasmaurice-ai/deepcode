import { randomUUID } from 'crypto'
import { AgentEvent, WorkflowDef, WorkflowNode, WorkflowRun } from '@shared/types'
import { saveRun } from './store'
import { validateWorkflow, hasBlockingErrors } from '@shared/workflows'

const RUN_MAX_MS = 2 * 60 * 60 * 1000 // hard per-run wall-clock ceiling (delay loops etc.)

// Runs a workflow node-by-node. The executor is decoupled from the engine: the caller
// (ipc) supplies runAgent/runTool/runSubworkflow so we reuse the real agent loop, the
// built-in tools, and recursion without importing them here. Per-node status is streamed
// as AgentEvents so the editor can trace the run live.

export interface WorkflowDeps {
  cwd: string
  signal: AbortSignal
  emit: (e: AgentEvent) => void
  runAgent: (prompt: string, cwd: string) => Promise<string>
  runTool: (name: string, args: Record<string, unknown>, cwd: string) => Promise<{ ok: boolean; content: string }>
  runSubworkflow?: (id: string, vars: Record<string, string>, depth: number) => Promise<string>
  notify?: (title: string, body: string) => void
  depth?: number
}

// abort-aware sleep (delay node) — rejects with AbortError if the run is cancelled
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

// {{var}} substitution against the run's variable bag.
function tmpl(s: unknown, vars: Record<string, string>): string {
  return String(s ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => vars[k] ?? '')
}

// Safe condition evaluation — a tiny comparator, never eval(). Parse the operator
// from the RAW expression first, then substitute variables into each operand, so an
// operator that happens to appear inside a variable's value can't corrupt the parse.
function evalCondition(expr: string, vars: Record<string, string>): boolean {
  const m = expr.match(/^(.*?)\s*(==|!=|contains|>=|<=|>|<)\s*(.*)$/)
  if (m) {
    const a = tmpl(m[1], vars).trim()
    const b = tmpl(m[3], vars).trim()
    switch (m[2]) {
      case '==':
        return a === b
      case '!=':
        return a !== b
      case 'contains':
        return a.includes(b)
      case '>':
        return Number(a) > Number(b)
      case '<':
        return Number(a) < Number(b)
      case '>=':
        return Number(a) >= Number(b)
      case '<=':
        return Number(a) <= Number(b)
    }
  }
  const e = tmpl(expr, vars).trim()
  return !!e && e !== 'false' && e !== '0'
}

const MAX_NODES = 200 // total-step runaway guard
const MAX_VISITS = 25 // max re-entries of a single node (bounded loops)

async function runNode(
  node: WorkflowNode,
  vars: Record<string, string>,
  deps: WorkflowDeps
): Promise<{ output?: string; branch?: string }> {
  const cfg = node.config || {}
  const setVar = (out: string): void => {
    const v = typeof cfg.outputVar === 'string' && cfg.outputVar ? cfg.outputVar : 'last'
    vars[v] = out
    vars.last = out
  }
  switch (node.type) {
    case 'trigger':
      return {}
    case 'agent': {
      const out = await deps.runAgent(tmpl(cfg.prompt, vars), deps.cwd)
      setVar(out)
      return { output: out }
    }
    case 'tool': {
      const name = String(cfg.tool || '')
      // defensive: a config-drawer JSON field kept as raw invalid text must not become
      // garbage args — only accept a real object, else {}
      const raw = cfg.args && typeof cfg.args === 'object' ? (cfg.args as Record<string, unknown>) : {}
      const args: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(raw)) args[k] = typeof val === 'string' ? tmpl(val, vars) : val
      const r = await deps.runTool(name, args, deps.cwd)
      if (!r.ok) throw new Error(r.content.slice(0, 400))
      setVar(r.content)
      return { output: r.content }
    }
    case 'shell': {
      const r = await deps.runTool('run_command', { command: tmpl(cfg.command, vars) }, deps.cwd)
      if (!r.ok) throw new Error(r.content.slice(0, 400))
      setVar(r.content)
      return { output: r.content }
    }
    case 'http': {
      const r = await deps.runTool('web_fetch', { url: tmpl(cfg.url, vars) }, deps.cwd)
      if (!r.ok) throw new Error(r.content.slice(0, 400))
      setVar(r.content)
      return { output: r.content }
    }
    case 'transform': {
      const mode = cfg.mode || 'template'
      let out = ''
      if (mode === 'extract') {
        try {
          const m = new RegExp(String(cfg.pattern || '')).exec(tmpl(cfg.input ?? '{{last}}', vars))
          out = m ? (m[1] ?? m[0]) : ''
        } catch {
          throw new Error('transform: invalid regex')
        }
      } else if (mode === 'set') {
        out = tmpl(cfg.value, vars)
      } else {
        out = tmpl(cfg.template, vars)
      }
      setVar(out)
      return { output: out }
    }
    case 'condition': {
      const ok = evalCondition(String(cfg.expression || ''), vars)
      return { output: String(ok), branch: ok ? 'true' : 'false' }
    }
    case 'switch': {
      // route by exact match of an input value against the configured cases; the matched
      // case (or 'default') is the branch the walk follows via the same-named edge handle.
      const input = tmpl(cfg.input ?? '{{last}}', vars).trim()
      // 'default' is the reserved fallback handle — a user case can't claim it
      const cases = [
        ...new Set(
          String(cfg.cases ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((c) => c && c !== 'default')
        )
      ]
      const matched = cases.find((c) => c === input)
      setVar(input)
      return { output: input, branch: matched ?? 'default' }
    }
    case 'subworkflow': {
      if (!deps.runSubworkflow) throw new Error('sub-workflows unavailable')
      const out = await deps.runSubworkflow(String(cfg.workflowId || ''), vars, (deps.depth ?? 0) + 1)
      setVar(out)
      return { output: out }
    }
    case 'delay': {
      const secs = Math.max(0, Math.min(Number(cfg.seconds) || 0, 3600)) // cap at 1h
      await sleep(secs * 1000, deps.signal)
      return { output: `⏱ ${secs}s` }
    }
    case 'notify': {
      const title = tmpl(cfg.title ?? 'DeepCode', vars).slice(0, 120) || 'DeepCode'
      const body = tmpl(cfg.message ?? '{{last}}', vars).slice(0, 500)
      deps.notify?.(title, body)
      return { output: `🔔 ${title}` }
    }
    case 'output': {
      // the output is surfaced via the node's own workflow_node 'done' event (which the
      // editor shows) — don't emit a generic 'status' that would bleed into the chat bar.
      const text = tmpl(cfg.template ?? '{{last}}', vars)
      setVar(text)
      return { output: text }
    }

    default:
      throw new Error(`Unknown node type: ${(node as WorkflowNode).type}`)
  }
}

// Walk the graph from the trigger (or a pinned start node), running each node and
// following the matching outgoing edge. Streams per-node + per-run status, persists the
// run for replay, and returns the final WorkflowRun.
export async function runWorkflow(
  def: WorkflowDef,
  deps: WorkflowDeps,
  opts?: { fromNodeId?: string; vars?: Record<string, string>; runId?: string }
): Promise<WorkflowRun> {
  // normalize a possibly hand-edited/corrupt def so a missing array can't crash
  // before we even emit a start event / persist the run
  const wfNodes = Array.isArray(def.nodes) ? def.nodes : []
  const wfEdges = Array.isArray(def.edges) ? def.edges : []
  const run: WorkflowRun = {
    id: opts?.runId ?? randomUUID(),
    workflowId: def.id,
    status: 'running',
    nodes: wfNodes.map((n) => ({ nodeId: n.id, status: 'pending' })),
    vars: { ...(opts?.vars ?? {}) },
    startedAt: Date.now()
  }
  const byId = new Map(wfNodes.map((n) => [n.id, n]))
  deps.emit({ type: 'workflow_run', runId: run.id, workflowId: def.id, status: 'start' })
  saveRun(run)

  // Server-side validation guard — covers EVERY entry point (manual IPC, cron trigger,
  // sub-workflow), not just the editor's client-side check. An invalid workflow must not
  // run unattended and fail silently.
  const issues = validateWorkflow(def)
  if (hasBlockingErrors(issues)) {
    run.status = 'failed'
    run.error = 'Validierung: ' + issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')
    run.endedAt = Date.now()
    try {
      saveRun(run)
    } catch {
      /* ignore */
    }
    deps.emit({ type: 'workflow_run', runId: run.id, workflowId: def.id, status: 'error', message: run.error })
    return run
  }

  let current: WorkflowNode | undefined = opts?.fromNodeId
    ? byId.get(opts.fromNodeId)
    : wfNodes.find((n) => n.type === 'trigger') ?? wfNodes[0]
  // bounded loops: a node may be re-entered (poll/retry patterns) up to MAX_VISITS
  // times — better than silently dropping a loop-back edge — but always bounded.
  const visits = new Map<string, number>()
  let steps = 0

  try {
    while (current && steps++ < MAX_NODES) {
      if (deps.signal.aborted) {
        run.status = 'cancelled'
        break
      }
      // per-run wall-clock ceiling — a delay node on a loop-back could otherwise pin a
      // run for ~25h (MAX_VISITS × 1h); this bounds the whole run, not just one step.
      if (Date.now() - run.startedAt > RUN_MAX_MS) {
        run.status = 'failed'
        run.error = 'Zeitbudget des Workflows überschritten — gestoppt.'
        deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'failed', error: run.error })
        break
      }
      const vc = (visits.get(current.id) ?? 0) + 1
      visits.set(current.id, vc)
      if (vc > MAX_VISITS) {
        // bounded-loop trip: mark the run failed and signal the looping node on the
        // workflow channel only — NEVER a global 'status' event (that would bleed into
        // the open chat's status bar and never clear, the very bug fix #9 removed).
        const rn = run.nodes.find((x) => x.nodeId === current!.id)
        if (rn) {
          rn.status = 'failed'
          rn.error = `Schleifenlimit (${MAX_VISITS}) erreicht`
          rn.endedAt = Date.now()
        }
        deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'failed', error: `Schleifenlimit (${MAX_VISITS}) erreicht — gestoppt.` })
        run.status = 'failed'
        run.error = `Schleifenlimit (${MAX_VISITS}) bei Knoten „${current.id}" erreicht.`
        break
      }
      const rn = run.nodes.find((x) => x.nodeId === current!.id)!
      rn.status = 'running'
      rn.startedAt = Date.now()
      deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'running' })
      saveRun(run)

      const ncfg = current.config || {}
      const maxRetries = Math.max(0, Math.min(Number(ncfg.retries) || 0, 10))
      const retryDelay = Math.max(0, Math.min(Number(ncfg.retryDelaySec) || 0, 300))
      const continueOnError = ncfg.continueOnError === true
      let branch: string | undefined
      let attempt = 0
      let cancelled = false
      let nodeFailed = false
      let hardStop = false // budget exceeded → stop even if continueOnError is set
      for (;;) {
        try {
          const res = await runNode(current, run.vars!, deps)
          branch = res.branch
          rn.output = res.output?.slice(0, 20_000)
          rn.status = 'done'
          rn.endedAt = Date.now()
          deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'done', output: rn.output?.slice(0, 2000) })
          break
        } catch (e) {
          // a user cancel that interrupts an in-flight node arrives as an AbortError —
          // it must read as 'cancelled' (not 'failed'), and it overrides retry.
          if (deps.signal.aborted || (e as Error).name === 'AbortError') {
            cancelled = true
            break
          }
          if (attempt < maxRetries) {
            attempt++
            deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'running', output: `↻ Versuch ${attempt}/${maxRetries}…` })
            if (retryDelay > 0) {
              // a cancel DURING the backoff must read as cancelled, not failed
              try {
                await sleep(retryDelay * 1000, deps.signal)
              } catch {
                cancelled = true
                break
              }
            }
            // the retry backoff must still respect the per-run wall-clock ceiling
            if (Date.now() - run.startedAt > RUN_MAX_MS) {
              rn.status = 'failed'
              rn.error = 'Zeitbudget des Workflows überschritten — gestoppt.'
              rn.endedAt = Date.now()
              deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'failed', error: rn.error })
              nodeFailed = true
              hardStop = true
              run.error = rn.error
              break
            }
            continue
          }
          rn.status = 'failed'
          rn.error = (e as Error).message
          rn.endedAt = Date.now()
          deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'failed', error: rn.error })
          nodeFailed = true
          break
        }
      }
      if (cancelled) {
        rn.status = 'cancelled'
        rn.endedAt = Date.now()
        deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'cancelled' })
        run.status = 'cancelled'
        break
      }
      // a failed node stops the run UNLESS "continue on error" is set (then we follow the
      // default edge with the prior {{last}} and carry on). A hardStop (budget) always stops.
      if (nodeFailed && (!continueOnError || hardStop)) {
        run.status = 'failed'
        break
      }
      saveRun(run)

      const outgoing = wfEdges.filter((e) => e.source === current!.id)
      // branched node (condition/switch): take the matching handle, else fall back to a
      // 'default' handle if one is wired; unbranched: the plain (handle-less) edge.
      const next = branch
        ? outgoing.find((e) => e.sourceHandle === branch) ?? outgoing.find((e) => e.sourceHandle === 'default')
        : outgoing.find((e) => !e.sourceHandle) ?? outgoing[0]
      current = next ? byId.get(next.target) : undefined
    }
    // exited with a node still pending → we hit the MAX_NODES step cap, not a natural
    // end. That's a runaway, not a success — fail it so callers/subworkflows can't read
    // run.vars.last as a valid result.
    if (current && run.status === 'running') {
      run.status = 'failed'
      run.error = `Schritt-Limit (${MAX_NODES}) erreicht — Workflow gestoppt.`
      deps.emit({ type: 'workflow_node', runId: run.id, nodeId: current.id, status: 'failed', error: run.error })
    }
    if (run.status === 'running') run.status = 'done'
  } catch (e) {
    // an unexpected throw inside the walk (e.g. a persistence/emit failure, not a node
    // error — those are caught per-node above) must not fall through to a clean 'done'.
    if (run.status === 'running') {
      run.status = 'failed'
      run.error = (e as Error).message
    }
  } finally {
    run.endedAt = Date.now()
    try {
      saveRun(run) // a persistence failure here must not suppress the terminal event
    } catch {
      /* ignore */
    }
    deps.emit({
      type: 'workflow_run',
      runId: run.id,
      workflowId: def.id,
      // map all terminal states (cancelled must not look like a clean success)
      status: run.status === 'failed' ? 'error' : run.status === 'cancelled' ? 'cancelled' : 'done',
      message: run.error
    })
  }
  return run
}
