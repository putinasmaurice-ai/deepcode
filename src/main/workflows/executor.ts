import { randomUUID } from 'crypto'
import { AgentEvent, WorkflowDef, WorkflowNode, WorkflowRun } from '@shared/types'
import { saveRun } from './store'
import { runPool } from './pool'
import { validateWorkflow, hasBlockingErrors } from '@shared/workflows'

export const RUN_MAX_MS = 2 * 60 * 60 * 1000 // hard per-run wall-clock ceiling (delay loops etc.)

// Runs a workflow node-by-node. The executor is decoupled from the engine: the caller
// (ipc) supplies runAgent/runTool/runSubworkflow so we reuse the real agent loop, the
// built-in tools, and recursion without importing them here. Per-node status is streamed
// as AgentEvents so the editor can trace the run live.

// Tree-wide run context, created ONCE at the top-level run and passed by-reference into
// every sub-run (loop bodies, parallel branches, sub-workflows). Enforces aggregate caps
// that a per-level closure could not (each makeWfDeps level re-creates its closure).
export interface RunContext {
  deadline: number // absolute wall-clock ceiling (top run start + RUN_MAX_MS), inherited
  childRuns: { n: number } // total sub-runs spawned across the whole tree
  maxChildRuns: number // cap on childRuns.n (fan-out bomb guard)
  secrets?: Record<string, string> // decrypted ONCE at the top run, shared by all sub-runs
  maskList?: string[] // built once from secrets; shared
  // NOTE: cycle detection is a per-branch ancestor path threaded in makeWfDeps, NOT here —
  // a shared set would false-trip on concurrent fan-out to the same sub-workflow id.
}

export interface WorkflowDeps {
  cwd: string
  signal: AbortSignal
  emit: (e: AgentEvent) => void
  runAgent: (prompt: string, cwd: string, model?: string) => Promise<string>
  runTool: (name: string, args: Record<string, unknown>, cwd: string) => Promise<{ ok: boolean; content: string }>
  // persistent key/value state for the `store` node (injected by ipc; absent in tests)
  kv?: {
    get: (key: string) => string
    has: (key: string) => boolean
    set: (key: string, value: string) => string
    del: (key: string) => void
    incr: (key: string, by?: number) => number
  }
  // run a sandboxed JS snippet for the `code` node (injected by ipc)
  runCode?: (code: string, context: { vars: Record<string, string>; last: unknown; input: string }) => string
  // send an email over SMTP for the `email` node (injected by ipc; absent in tests)
  sendEmail?: (opts: {
    host: string
    port: number
    secure: boolean
    user?: string
    pass?: string
    from: string
    to: string
    subject: string
    text: string
  }) => Promise<string>
  runSubworkflow?: (id: string, vars: Record<string, string>, depth: number) => Promise<string>
  // like runSubworkflow but returns the child's FULL vars bag (for loop/parallel collection)
  runSubBag?: (id: string, vars: Record<string, string>, depth: number) => Promise<Record<string, string>>
  notify?: (title: string, body: string) => void
  resolveSecret?: (name: string) => string | undefined // {{secret.NAME}} (tool/shell/http only)
  mask?: (s: string) => string // mask secret values out of the PERSISTED run (not the live vars)
  runCtx?: RunContext
  depth?: number
}

// runPool (bounded-concurrency worker pool) lives in ./pool — shared with the swarm orchestrator.

// Mask a COPY of the run for persistence — never the live run.vars (downstream nodes still
// need the real values). Masks error + var values + per-node output/error.
function maskRunForPersist(run: WorkflowRun, mask: (s: string) => string): WorkflowRun {
  return {
    ...run,
    healSeed: undefined, // in-memory only — never write the unmasked replay snapshot to disk
    error: run.error ? mask(run.error) : run.error,
    vars: run.vars ? Object.fromEntries(Object.entries(run.vars).map(([k, v]) => [k, mask(String(v))])) : run.vars,
    nodes: run.nodes.map((n) => ({ ...n, output: n.output ? mask(n.output) : n.output, error: n.error ? mask(n.error) : n.error }))
  }
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

// Resolution context for {{...}} expressions. nodeOutputs lets {{node.<id>}} / {{<id>.path}}
// read an upstream node's output; resolveSecret injects {{secret.NAME}} (tool/shell/http only).
export interface ResolveCtx {
  vars: Record<string, string>
  nodeOutputs?: Map<string, string>
  resolveSecret?: (name: string) => string | undefined
  nodeType?: string
}

const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function stringifyLeaf(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const j = JSON.stringify(v)
    return j === undefined ? '' : j // function/symbol → undefined → '' (not the literal "undefined")
  } catch {
    return ''
  }
}

// Walk a JSON path into a (possibly JSON-string) base — pure property access, never eval.
// Prototype-pollution keys rejected, depth + size bounded, fail-soft to ''.
function getPath(base: unknown, segs: string[]): string {
  let cur: unknown = base
  for (let i = 0; i < segs.length; i++) {
    if (i > 20 || cur === null || cur === undefined) return ''
    if (typeof cur === 'string') {
      if (cur.length > 256 * 1024) return ''
      try {
        cur = JSON.parse(cur)
      } catch {
        return ''
      }
    }
    const seg = segs[i]
    if (PROTO_KEYS.has(seg)) return ''
    if (Array.isArray(cur)) cur = cur[Number(seg)]
    else if (cur && typeof cur === 'object') cur = Object.prototype.hasOwnProperty.call(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined
    else return ''
  }
  return stringifyLeaf(cur)
}

// Strip HTML to readable text for the `parse` (html) node — dependency-free.
function htmlToText(html: string): string {
  // cap input first: `<[^>]+>` is O(n²) on a long run of '<' with no '>', and a synchronous
  // multi-second stall would freeze the UI on attacker-controlled page text.
  return String(html)
    .slice(0, 200_000)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Minimal CSV → array of row objects (first line = headers). Handles quoted fields with commas
// and "" escapes. Dependency-free; for the `parse` (csv) node.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  const s = String(text).replace(/\r\n?/g, '\n')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  const nonEmpty = rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '')
  if (!nonEmpty.length) return []
  const headers = nonEmpty[0].map((h) => h.trim())
  return nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {}
    headers.forEach((h, i) => (o[h] = r[i] ?? ''))
    return o
  })
}

// {{...}} resolution. Order: secret. → exact flat var (back-compat) → node-output → var,
// then JSON-path the remaining segments. NEVER throws (a typo must not fail a node).
export function resolve(s: unknown, ctx: ResolveCtx): string {
  return String(s ?? '').replace(/\{\{\s*([\w.$[\]"]+?)\s*\}\}/g, (_m, key: string) => {
    try {
      if (key.startsWith('secret.')) {
        // ALLOWLIST: secrets expand ONLY in deterministic-arg nodes. Anywhere else
        // (transform/condition/switch/output/notify/agent) they resolve to '' — this is the
        // load-bearing guard against laundering a secret into a var and then a prompt.
        if (
          ctx.nodeType !== 'tool' &&
          ctx.nodeType !== 'shell' &&
          ctx.nodeType !== 'http' &&
          ctx.nodeType !== 'channel' &&
          ctx.nodeType !== 'email'
        )
          return ''
        return ctx.resolveSecret?.(key.slice(7)) ?? ''
      }
      // EXACT flat-var match first → preserves {{last}}, {{name}}, and any legacy {{x.a.b}}
      // that was literally a flat key.
      if (Object.prototype.hasOwnProperty.call(ctx.vars, key)) return ctx.vars[key]
      const segs = key.match(/[^.[\]"]+/g) ?? []
      if (!segs.length) return ''
      const head = segs[0]! // safe: length checked above
      let rest = segs.slice(1)
      let base: unknown
      if (head === 'node') {
        base = ctx.nodeOutputs?.get(rest[0] ?? '')
        rest = rest.slice(1)
      } else if (ctx.nodeOutputs?.has(head)) {
        base = ctx.nodeOutputs.get(head)
      } else {
        // own-property only → a bare {{toString}}/{{constructor}}/{{__proto__}} can't pick
        // up an inherited Object.prototype member
        base = Object.prototype.hasOwnProperty.call(ctx.vars, head) ? ctx.vars[head] : undefined
      }
      return rest.length === 0 ? stringifyLeaf(base) : getPath(base, rest)
    } catch {
      return ''
    }
  })
}

// Safe condition evaluation — a tiny comparator, never eval(). Parse the operator
// from the RAW expression first, then substitute variables into each operand, so an
// operator that happens to appear inside a variable's value can't corrupt the parse.
function evalCondition(expr: string, ctx: ResolveCtx): boolean {
  const m = expr.match(/^(.*?)\s*(==|!=|contains|>=|<=|>|<)\s*(.*)$/)
  if (m) {
    const a = resolve(m[1], ctx).trim()
    const b = resolve(m[3], ctx).trim()
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
  const e = resolve(expr, ctx).trim()
  return !!e && e !== 'false' && e !== '0'
}

const MAX_NODES = 200 // total-step runaway guard
const MAX_VISITS = 25 // max re-entries of a single node (bounded loops)
const MAX_LOOP_ITEMS = 100 // forEach iteration cap
const MAX_PARALLEL_BRANCHES = 8 // parallel branch cap

// Parse a loop list source into items. 'json' parses an array (an object → [object]);
// 'lines' splits on newlines/commas; 'auto' tries JSON first, else lines.
function parseList(raw: string, format: string): unknown[] {
  const s = (raw ?? '').trim()
  if (!s) return []
  const asLines = (): unknown[] => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
  if (format === 'lines') return asLines()
  if (format === 'json' || format === 'auto') {
    try {
      const j = JSON.parse(s)
      if (Array.isArray(j)) return j
      // valid JSON that is NOT an array (object/number/string) → wrap as a single item
      // for BOTH formats; only a JSON.parse THROW falls back to asLines() (auto only).
      return j === null || j === undefined ? [] : [j]
    } catch {
      if (format === 'json') return []
    }
  }
  return asLines()
}

async function runNode(
  node: WorkflowNode,
  vars: Record<string, string>,
  deps: WorkflowDeps,
  nodeOutputs?: Map<string, string>,
  onProgress?: (output: string) => void
): Promise<{ output?: string; branch?: string }> {
  const cfg = node.config || {}
  // resolution context: enables {{node.<id>}} / JSON-path / {{secret.NAME}} in this node's
  // config. nodeType gates secrets (banned in agent prompts).
  const rctx: ResolveCtx = { vars, nodeOutputs, resolveSecret: deps.resolveSecret, nodeType: node.type }
  const setVar = (out: string): void => {
    const v = typeof cfg.outputVar === 'string' && cfg.outputVar ? cfg.outputVar : 'last'
    vars[v] = out
    vars.last = out
  }
  switch (node.type) {
    case 'trigger':
      return {}
    case 'agent': {
      // mask the resolved prompt: even though {{secret.*}} won't expand here, a secret a
      // prior tool/shell node echoed into a var ({{last}}) would otherwise reach the LLM AND
      // be persisted in the throwaway session in plaintext. Mask it before runAgent.
      const prompt = resolve(cfg.prompt, rctx)
      // optional per-node model override (e.g. "openai:gpt-4o", "google:gemini-2.5-pro",
      // "deepinfra:…") so each step can use a different provider; empty → the session/default model.
      const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : undefined
      const out = await deps.runAgent(deps.mask ? deps.mask(prompt) : prompt, deps.cwd, model)
      setVar(out)
      return { output: out }
    }
    case 'tool': {
      const name = String(cfg.tool || '')
      // defensive: a config-drawer JSON field kept as raw invalid text must not become
      // garbage args — only accept a real object, else {}
      const raw = cfg.args && typeof cfg.args === 'object' ? (cfg.args as Record<string, unknown>) : {}
      const args: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(raw)) args[k] = typeof val === 'string' ? resolve(val, rctx) : val
      const r = await deps.runTool(name, args, deps.cwd)
      // publish the output to {{last}} BEFORE a possible throw, so that with continueOnError a
      // downstream node sees this node's ACTUAL output (incl. the failure text), not stale {{last}}.
      setVar(r.content)
      if (!r.ok) throw new Error(r.content.slice(0, 400))
      return { output: r.content }
    }
    case 'shell': {
      const r = await deps.runTool('run_command', { command: resolve(cfg.command, rctx) }, deps.cwd)
      setVar(r.content) // see 'tool' — carry real output into {{last}} even on a continued failure
      if (!r.ok) throw new Error(r.content.slice(0, 400))
      return { output: r.content }
    }
    case 'http': {
      const url = resolve(cfg.url, rctx)
      const method = String(cfg.method || 'GET').toUpperCase()
      const hasHeaders = cfg.headers !== undefined && cfg.headers !== ''
      const hasBody = cfg.body !== undefined && cfg.body !== ''
      let r: { ok: boolean; content: string }
      if (method === 'GET' && !hasHeaders && !hasBody) {
        // plain GET → keep web_fetch (HTML→readable text). secrets resolve in this http node.
        r = await deps.runTool('web_fetch', { url }, deps.cwd)
      } else {
        // full request (POST/PUT/… or custom headers/body) → web_request. Headers are a JSON object
        // or string; resolve() expands {{secret.*}} (allowed in http nodes) into the real values.
        let headers: Record<string, unknown> | undefined
        if (hasHeaders) {
          try {
            headers = JSON.parse(resolve(typeof cfg.headers === 'string' ? cfg.headers : JSON.stringify(cfg.headers), rctx))
          } catch {
            headers = undefined // malformed header JSON → send none rather than crash the node
          }
        }
        const body = hasBody
          ? resolve(typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body), rctx)
          : undefined
        r = await deps.runTool('web_request', { url, method, headers, body }, deps.cwd)
      }
      setVar(r.content) // see 'tool' — carry real output into {{last}} even on a continued failure
      if (!r.ok) throw new Error(r.content.slice(0, 400))
      return { output: r.content }
    }
    case 'transform': {
      const mode = cfg.mode || 'template'
      let out = ''
      if (mode === 'extract') {
        // ReDoS guard: reject overlong patterns (complexity proxy) BEFORE compiling, and cap the
        // resolved input — {{last}} can carry attacker-influenced text and exec() runs on the main thread.
        const pattern = String(cfg.pattern || '')
        if (pattern.length > 1000) throw new Error('transform: Regex-Muster zu lang (max. 1000 Zeichen)')
        try {
          const m = new RegExp(pattern).exec(resolve(cfg.input ?? '{{last}}', rctx).slice(0, 200_000))
          out = m ? (m[1] ?? m[0]) : ''
        } catch {
          throw new Error('transform: invalid regex')
        }
      } else if (mode === 'set') {
        out = resolve(cfg.value, rctx)
      } else {
        out = resolve(cfg.template, rctx)
      }
      setVar(out)
      return { output: out }
    }
    case 'store': {
      if (!deps.kv) throw new Error('store: KV-Speicher nicht verfügbar')
      const op = String(cfg.op || 'get')
      const key = resolve(cfg.storeKey ?? '', rctx).trim()
      if (!key) throw new Error('store: kein Schlüssel angegeben')
      let out = ''
      if (op === 'set') out = deps.kv.set(key, resolve(cfg.value ?? '{{last}}', rctx))
      else if (op === 'incr') out = String(deps.kv.incr(key, Number(resolve(cfg.value ?? '1', rctx)) || 1))
      else if (op === 'delete') deps.kv.del(key)
      else if (op === 'has') out = String(deps.kv.has(key))
      else out = deps.kv.get(key) // get
      setVar(out)
      return { output: out }
    }
    case 'code': {
      if (!deps.runCode) throw new Error('code: Ausführung nicht verfügbar')
      // expose vars + the parsed-or-raw {{last}} + {{input}} to the snippet
      const lastRaw = vars.last ?? ''
      let last: unknown = lastRaw
      try {
        last = JSON.parse(lastRaw)
      } catch {
        /* keep the raw string */
      }
      const out = deps.runCode(String(cfg.code ?? ''), { vars: { ...vars }, last, input: vars.input ?? '' })
      setVar(out)
      return { output: out }
    }
    case 'parse': {
      const mode = String(cfg.mode || 'json')
      const input = resolve(cfg.input ?? '{{last}}', rctx)
      let out = ''
      if (mode === 'csv') {
        out = JSON.stringify(parseCsv(input))
      } else if (mode === 'html') {
        out = htmlToText(input)
      } else {
        let parsed: unknown
        try {
          parsed = JSON.parse(input)
        } catch {
          throw new Error('parse: Eingabe ist kein gültiges JSON')
        }
        const path = String(cfg.path ?? '').trim()
        out = path ? getPath(parsed, path.match(/[^.[\]"]+/g) ?? []) : stringifyLeaf(parsed)
      }
      setVar(out)
      return { output: out }
    }
    case 'channel': {
      const channel = String(cfg.channel || 'webhook')
      const message = resolve(cfg.message ?? '{{last}}', rctx)
      const headers = { 'Content-Type': 'application/json' }
      let url = ''
      let body = ''
      if (channel === 'telegram') {
        const token = resolve('{{secret.TELEGRAM_BOT_TOKEN}}', rctx).trim()
        if (!token) throw new Error('channel(telegram): TELEGRAM_BOT_TOKEN-Secret fehlt')
        const chatId = resolve(String(cfg.chatId || '').trim() || '{{secret.TELEGRAM_CHAT_ID}}', rctx)
        url = `https://api.telegram.org/bot${token}/sendMessage`
        body = JSON.stringify({ chat_id: chatId, text: message })
      } else if (channel === 'slack' || channel === 'discord' || channel === 'webhook') {
        url = resolve(cfg.url ?? '', rctx)
        // slack/webhook expect {text}; discord expects {content}
        body = JSON.stringify(channel === 'discord' ? { content: message } : { text: message })
      } else {
        throw new Error(`channel: unbekannter Kanal „${channel}"`)
      }
      if (!url) throw new Error('channel: keine Ziel-URL/kein Token')
      const r = await deps.runTool('web_request', { url, method: 'POST', headers, body }, deps.cwd)
      setVar(r.content)
      if (!r.ok) throw new Error(r.content.slice(0, 400))
      return { output: r.content }
    }
    case 'email': {
      if (!deps.sendEmail) throw new Error('email: SMTP-Versand nicht verfügbar')
      // password comes from an encrypted secret; default {{secret.SMTP_PASS}} so the
      // user only has to store the token once (never inline in the node config/run record).
      const out = await deps.sendEmail({
        host: resolve(cfg.host ?? '', rctx).trim(),
        port: Number(resolve(cfg.port ?? '', rctx)) || 0,
        secure: cfg.secure === true || String(cfg.secure) === 'true',
        user: resolve(cfg.user ?? '', rctx).trim() || undefined,
        pass: resolve(cfg.pass ?? '{{secret.SMTP_PASS}}', rctx) || undefined,
        from: resolve(cfg.from ?? '', rctx).trim(),
        to: resolve(cfg.to ?? '', rctx).trim(),
        subject: resolve(cfg.subject ?? '', rctx),
        text: resolve(cfg.body ?? '{{last}}', rctx)
      })
      setVar(out)
      return { output: out }
    }
    case 'condition': {
      const ok = evalCondition(String(cfg.expression || ''), rctx)
      return { output: String(ok), branch: ok ? 'true' : 'false' }
    }
    case 'switch': {
      // route by exact match of an input value against the configured cases; the matched
      // case (or 'default') is the branch the walk follows via the same-named edge handle.
      const input = resolve(cfg.input ?? '{{last}}', rctx).trim()
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
    case 'loop': {
      if (!deps.runSubBag) throw new Error('loop: sub-runs unavailable')
      const bodyId = String(cfg.bodyWorkflowId || '')
      if (!bodyId) throw new Error('loop: kein Body-Workflow gesetzt')
      const cap = Math.max(0, Math.min(Number(cfg.maxItems) || MAX_LOOP_ITEMS, MAX_LOOP_ITEMS))
      const parsed = parseList(resolve(cfg.listExpr ?? '{{last}}', rctx), String(cfg.listFormat || 'auto'))
      const items = parsed.slice(0, cap)
      // a silent partial result looks complete — warn (visibly in the editor/run) when the input
      // list was longer than the cap so the user knows only the first `cap` items ran.
      if (parsed.length > items.length) {
        onProgress?.(`⚠ Liste auf ${items.length} von ${parsed.length} Einträgen begrenzt (Limit ${MAX_LOOP_ITEMS}).`)
      }
      const itemVar = String(cfg.itemVar || 'item')
      const indexVar = String(cfg.indexVar || 'index')
      const continueItemOnError = cfg.continueItemOnError === true
      const childVars = (it: unknown, i: number): Record<string, string> => {
        const iv = typeof it === 'object' && it !== null ? JSON.stringify(it) : String(it)
        return { ...vars, [itemVar]: iv, [indexVar]: String(i), last: iv }
      }
      const total = items.length
      let done = 0
      const tick = (): void => onProgress?.(`${++done}/${total} fertig…`)
      const runItem = (it: unknown, i: number): Promise<string> =>
        deps
          .runSubBag!(bodyId, childVars(it, i), (deps.depth ?? 0) + 1)
          .then((bag) => {
            tick()
            return bag.last ?? ''
          })
          .catch((e: Error) => {
            // never swallow a cancel; otherwise honour continue-item-on-error
            if (deps.signal.aborted || e.name === 'AbortError') throw e
            if (continueItemOnError) {
              tick()
              return `__ERR__:${e.message}`
            }
            throw e
          })
      let results: string[]
      if (String(cfg.mode || 'sequential') === 'parallel') {
        results = await runPool(
          items.map((it, i) => () => runItem(it, i)),
          Math.max(1, Math.min(Number(cfg.concurrency) || 4, 8)),
          deps.signal,
          deps.runCtx?.deadline
        )
      } else {
        results = []
        for (let i = 0; i < items.length; i++) {
          if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          // honour the absolute deadline here too (thrown OUTSIDE runItem's catch, so
          // continueItemOnError can't mask it into an __ERR__ sentinel and keep going)
          if (deps.runCtx?.deadline && Date.now() > deps.runCtx.deadline) throw new Error('Zeitbudget des Workflows überschritten — gestoppt.')
          results.push(await runItem(items[i], i))
        }
      }
      const collectAs = String(cfg.collectAs || 'json')
      const out =
        collectAs === 'join'
          ? results.join(String(cfg.joinSep ?? '\n'))
          : collectAs === 'last'
            ? (results.at(-1) ?? '')
            : JSON.stringify(results)
      setVar(out.slice(0, 20_000))
      return { output: out.slice(0, 20_000) }
    }
    case 'parallel': {
      if (!deps.runSubBag) throw new Error('parallel: sub-runs unavailable')
      const raw = Array.isArray(cfg.branches) ? (cfg.branches as Array<Record<string, unknown>>) : []
      const branches = raw
        .map((b) => ({ workflowId: String(b?.workflowId || ''), resultVar: String(b?.resultVar || ''), label: b?.label ? String(b.label) : undefined }))
        .filter((b) => b.workflowId)
        .slice(0, MAX_PARALLEL_BRANCHES)
      if (!branches.length) throw new Error('parallel: keine Branches konfiguriert')
      const continueOnBranchError = cfg.errorMode !== 'failFast'
      const total = branches.length
      let done = 0
      const tasks = branches.map((b) => () =>
        deps
          .runSubBag!(b.workflowId, { ...vars }, (deps.depth ?? 0) + 1)
          .then((bag) => {
            onProgress?.(`${++done}/${total} fertig…`)
            return bag.last ?? ''
          })
          .catch((e: Error) => {
            if (deps.signal.aborted || e.name === 'AbortError') throw e
            if (continueOnBranchError) {
              onProgress?.(`${++done}/${total} fertig…`)
              return `__ERR__:${e.message}`
            }
            throw e
          })
      )
      const vals = await runPool(tasks, Math.max(1, Math.min(Number(cfg.concurrency) || branches.length, 8)), deps.signal, deps.runCtx?.deadline)
      // write each branch result to its named var so a downstream merge/expression can read it
      branches.forEach((b, i) => {
        if (b.resultVar) vars[b.resultVar] = vals[i] ?? ''
      })
      const mergeMode = String(cfg.mergeMode || 'array')
      let out: string
      if (mergeMode === 'object') out = JSON.stringify(Object.fromEntries(branches.map((b, i) => [b.label || b.resultVar || `branch${i}`, vals[i] ?? ''])))
      else if (mergeMode === 'join') out = vals.join(String(cfg.joinSep ?? '\n'))
      else out = JSON.stringify(vals)
      setVar(out.slice(0, 20_000))
      return { output: out.slice(0, 20_000) }
    }
    case 'merge': {
      // pure transform: combine already-computed vars (no sub-runs)
      const inputs = String(cfg.inputs || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const vals = inputs.map((name) => vars[name] ?? '')
      const mode = String(cfg.mode || 'array')
      let out: string
      if (mode === 'concat') out = vals.join(String(cfg.separator ?? '\n'))
      else if (mode === 'object') out = JSON.stringify(Object.fromEntries(inputs.map((n, i) => [n, vals[i]])))
      else if (mode === 'pick') out = vals.find((v) => v && v.trim()) ?? '' // first non-empty
      else out = JSON.stringify(vals)
      setVar(out.slice(0, 20_000))
      return { output: out.slice(0, 20_000) }
    }
    case 'delay': {
      const secs = Math.max(0, Math.min(Number(cfg.seconds) || 0, 3600)) // cap at 1h
      await sleep(secs * 1000, deps.signal)
      return { output: `⏱ ${secs}s` }
    }
    case 'notify': {
      // mask BEFORE slice so a laundered secret in {{last}} can't reach the OS toast / history
      const m = deps.mask ?? ((x: string): string => x)
      const title = m(resolve(cfg.title ?? 'DeepCode', rctx)).slice(0, 120) || 'DeepCode'
      const body = m(resolve(cfg.message ?? '{{last}}', rctx)).slice(0, 500)
      deps.notify?.(title, body)
      return { output: `🔔 ${title}` }
    }
    case 'output': {
      // the output is surfaced via the node's own workflow_node 'done' event (which the
      // editor shows) — don't emit a generic 'status' that would bleed into the chat bar.
      const text = resolve(cfg.template ?? '{{last}}', rctx)
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
  opts?: { fromNodeId?: string; vars?: Record<string, string>; runId?: string; seedOutputs?: Record<string, string> }
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
  // persist a SECRET-MASKED copy; the live `run` keeps real values for downstream templating.
  // Persistence is a best-effort side-effect for replay/UI — NEVER part of the run's control
  // flow. A transient write failure (e.g. a Windows EPERM when an AV/indexer briefly locks the
  // tmp→rename of the same run file across rapid node checkpoints) must not abort the walk nor
  // get caught by the outer try and overwrite the run's real terminal status/error.
  const persist = (r: WorkflowRun): void => {
    try {
      saveRun(deps.mask ? maskRunForPersist(r, deps.mask) : r)
    } catch {
      /* best-effort snapshot — the terminal persist in `finally` is the authoritative one */
    }
  }
  deps.emit({ type: 'workflow_run', runId: run.id, workflowId: def.id, status: 'start' })
  persist(run)

  // Server-side validation guard — covers EVERY entry point (manual IPC, cron trigger,
  // sub-workflow), not just the editor's client-side check. An invalid workflow must not
  // run unattended and fail silently.
  const issues = validateWorkflow(def)
  if (hasBlockingErrors(issues)) {
    run.status = 'failed'
    run.error = 'Validierung: ' + issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')
    run.endedAt = Date.now()
    try {
      persist(run)
    } catch {
      /* ignore */
    }
    deps.emit({ type: 'workflow_run', runId: run.id, workflowId: def.id, status: 'error', message: run.error })
    return run
  }

  let current: WorkflowNode | undefined = opts?.fromNodeId
    ? byId.get(opts.fromNodeId)
    : wfNodes.find((n) => n.type === 'trigger') ?? wfNodes[0]
  // fail fast if a replay/resume targets a node that no longer exists — otherwise the walk
  // never enters and the run flips to a false 'done' having executed ZERO nodes (which every
  // caller, incl. self-heal, would read as success). Also hardens the public runWorkflow IPC.
  if (opts?.fromNodeId && !current) {
    run.status = 'failed'
    run.error = `Resume-Knoten „${opts.fromNodeId}" existiert nicht mehr.`
    run.endedAt = Date.now()
    try {
      persist(run)
    } catch {
      /* ignore */
    }
    deps.emit({ type: 'workflow_run', runId: run.id, workflowId: def.id, status: 'error', message: run.error })
    return run
  }
  // bounded loops: a node may be re-entered (poll/retry patterns) up to MAX_VISITS
  // times — better than silently dropping a loop-back edge — but always bounded.
  const visits = new Map<string, number>()
  // per-node outputs (in-memory only, never persisted) so {{node.<id>}} / {{<id>.path}}
  // can reference an upstream node's result. On a self-heal REPLAY (fromNodeId set) it's
  // seeded from the failed run's upstream outputs, so a mid-graph resume still resolves
  // {{node.<earlier-id>}} instead of silently getting ''.
  const nodeOutputs = new Map<string, string>(Object.entries(opts?.seedOutputs ?? {}))
  let steps = 0

  try {
    while (current && steps++ < MAX_NODES) {
      if (deps.signal.aborted) {
        run.status = 'cancelled'
        break
      }
      // wall-clock ceiling. Children inherit the TOP run's ABSOLUTE deadline via runCtx, so
      // nested loops/parallel can't extend the budget; falls back to a per-run cap if no ctx.
      const deadline = deps.runCtx?.deadline ?? run.startedAt + RUN_MAX_MS
      if (Date.now() > deadline) {
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
      persist(run)

      const ncfg = current.config || {}
      const maxRetries = Math.max(0, Math.min(Number(ncfg.retries) || 0, 10))
      const retryDelay = Math.max(0, Math.min(Number(ncfg.retryDelaySec) || 0, 300))
      const continueOnError = ncfg.continueOnError === true
      let branch: string | undefined
      let attempt = 0
      let cancelled = false
      let nodeFailed = false
      let hardStop = false // budget exceeded → stop even if continueOnError is set
      // throttled progress heartbeat for long fan-out nodes (loop/parallel) — the editor
      // already renders a node's 'running' output, so a slow loop shows N/total live.
      let lastBeat = 0
      const nid = current.id
      const onProgress = (out: string): void => {
        const now = Date.now()
        if (now - lastBeat < 250) return
        lastBeat = now
        deps.emit({ type: 'workflow_node', runId: run.id, nodeId: nid, status: 'running', output: out })
      }
      // snapshot the vars the node SEES as input (before it runs / poisons {{last}} with an
      // error) — a self-heal replay resumes from here with this exact unmasked input state.
      const inputSnapshot = { ...run.vars }
      for (;;) {
        try {
          const res = await runNode(current, run.vars!, deps, nodeOutputs, onProgress)
          branch = res.branch
          rn.output = res.output?.slice(0, 20_000)
          nodeOutputs.set(current.id, (res.output ?? '').slice(0, 100_000)) // for {{node.<id>}}
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
            if (Date.now() > (deps.runCtx?.deadline ?? run.startedAt + RUN_MAX_MS)) {
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
      // a failed node stops the run UNLESS "continue on error" is set (then we follow the default
      // edge and carry on — tool/shell/http nodes publish their output to {{last}} even on failure,
      // so the next node sees the real error text). A hardStop (budget) always stops.
      if (nodeFailed && (!continueOnError || hardStop)) {
        run.status = 'failed'
        // a genuine node failure (not a time/budget hardStop) is repairable — leave the
        // in-memory seed a self-heal needs to resume from exactly this node + input state.
        if (!hardStop) {
          run.healSeed = {
            fromNodeId: current.id,
            vars: inputSnapshot,
            seedOutputs: Object.fromEntries(nodeOutputs)
          }
        }
        break
      }
      persist(run)

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
      persist(run) // a persistence failure here must not suppress the terminal event
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
