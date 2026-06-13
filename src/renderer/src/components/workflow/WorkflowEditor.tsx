import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps
} from '@xyflow/react'
import type { WorkflowDef, WorkflowNode, WorkflowNodeType, WorkflowNodeStatus, AgentEvent } from '../../../../shared/types'
import { validateWorkflow, hasBlockingErrors, type WorkflowIssue } from '../../../../shared/workflows'
import { RunHistory } from './RunHistory'

const api = window.deepcode

interface FieldDef {
  key: string
  label: string
  kind: 'text' | 'textarea' | 'json'
}
interface NodeDef {
  icon: string
  label: string
  fields: FieldDef[]
}
// per-type metadata that drives the palette + the config drawer
const NODE_DEFS: Record<WorkflowNodeType, NodeDef> = {
  trigger: {
    icon: '▶️',
    label: 'Trigger',
    fields: [
      { key: 'mode', label: 'Start: manual | cron', kind: 'text' },
      { key: 'cron', label: 'Cron (Min Std Tag Mon Wochentag) — z.B. 0 9 * * *', kind: 'text' }
    ]
  },
  agent: {
    icon: '🧠',
    label: 'Agent-Step',
    fields: [
      { key: 'prompt', label: 'Prompt (nutzt {{var}})', kind: 'textarea' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  tool: {
    icon: '🔧',
    label: 'Tool',
    fields: [
      { key: 'tool', label: 'Tool-Name (z.B. read_file)', kind: 'text' },
      { key: 'args', label: 'Argumente (JSON)', kind: 'json' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  shell: {
    icon: '⌨️',
    label: 'Shell',
    fields: [
      { key: 'command', label: 'Befehl (nutzt {{var}})', kind: 'textarea' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  http: {
    icon: '🌐',
    label: 'HTTP',
    fields: [
      { key: 'url', label: 'URL (nutzt {{var}})', kind: 'text' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  condition: {
    icon: '🔀',
    label: 'Bedingung',
    fields: [{ key: 'expression', label: 'Ausdruck (z.B. {{last}} contains ok)', kind: 'text' }]
  },
  switch: {
    icon: '🔱',
    label: 'Switch',
    fields: [
      { key: 'input', label: 'Wert (nutzt {{var}}, Default {{last}})', kind: 'text' },
      { key: 'cases', label: 'Fälle (kommagetrennt, z.B. ok,error,retry)', kind: 'text' }
    ]
  },
  transform: {
    icon: '✨',
    label: 'Transform',
    fields: [
      { key: 'mode', label: 'Modus: template | extract | set', kind: 'text' },
      { key: 'template', label: 'Template (mode=template)', kind: 'textarea' },
      { key: 'pattern', label: 'Regex (mode=extract)', kind: 'text' },
      { key: 'value', label: 'Wert (mode=set)', kind: 'text' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  subworkflow: {
    icon: '🧩',
    label: 'Sub-Workflow',
    fields: [{ key: 'workflowId', label: 'Workflow-ID', kind: 'text' }]
  },
  delay: {
    icon: '⏱️',
    label: 'Warten',
    fields: [{ key: 'seconds', label: 'Sekunden warten (max 3600)', kind: 'text' }]
  },
  notify: {
    icon: '🔔',
    label: 'Benachrichtigung',
    fields: [
      { key: 'title', label: 'Titel', kind: 'text' },
      { key: 'message', label: 'Nachricht (nutzt {{var}})', kind: 'textarea' }
    ]
  },
  output: {
    icon: '📤',
    label: 'Output',
    fields: [{ key: 'template', label: 'Ausgabe-Template (Default {{last}})', kind: 'textarea' }]
  }
}
const PALETTE: WorkflowNodeType[] = ['agent', 'tool', 'shell', 'http', 'condition', 'switch', 'transform', 'delay', 'notify', 'subworkflow', 'output']

interface WfData extends Record<string, unknown> {
  node: WorkflowNode
  status?: WorkflowNodeStatus
  output?: string // last run output (shown inline so data flow is visible)
  error?: string // last run error
  invalid?: boolean // failed pre-run validation
  invalidMsg?: string
}

const STATUS_DOT: Record<WorkflowNodeStatus, string> = {
  pending: '',
  running: '⏳',
  done: '✅',
  failed: '❌',
  skipped: '⏭',
  cancelled: '🚫'
}

// fallback so an unknown/future node type can't crash the canvas
const FALLBACK_DEF = { icon: '⬚', label: 'Unbekannt', fields: [] }

function WfNodeView({ data, selected }: NodeProps): JSX.Element {
  const d = data as WfData
  const def = NODE_DEFS[d.node.type] ?? FALLBACK_DEF
  return (
    <div className={'wf-node' + (selected ? ' sel' : '') + (d.invalid ? ' invalid' : '') + (d.status ? ' st-' + d.status : '')}>
      {d.node.type !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <div className="wf-node-head">
        <span className="wf-ic">{def.icon}</span>
        <span className="wf-ttl">{d.node.label || def.label}</span>
        {d.status && <span className="wf-st">{STATUS_DOT[d.status]}</span>}
      </div>
      {/* a cron-triggered start shows its schedule so "runs automatically" is visible */}
      {d.node.type === 'trigger' && d.node.config?.mode === 'cron' && d.node.config?.cron ? (
        <div className="wf-node-out" title="Cron-Zeitplan">⏰ {String(d.node.config.cron)}</div>
      ) : null}
      {/* surface validation, the error, or the data flowing out — not just a dot */}
      {d.invalid && d.invalidMsg ? (
        <div className="wf-node-out err" title={d.invalidMsg}>⚠ {d.invalidMsg}</div>
      ) : d.error ? (
        <div className="wf-node-out err" title={d.error}>⚠ {d.error.slice(0, 120)}</div>
      ) : d.output ? (
        <div className="wf-node-out" title={d.output}>{d.output.slice(0, 120)}</div>
      ) : null}
      {d.node.type === 'condition' ? (
        <>
          <Handle id="true" type="source" position={Position.Bottom} style={{ left: '28%' }} />
          <Handle id="false" type="source" position={Position.Bottom} style={{ left: '72%' }} />
          <div className="wf-branches"><span className="t">✓ true</span><span className="f">✗ false</span></div>
        </>
      ) : d.node.type === 'switch' ? (
        (() => {
          // dedup + drop a user case literally named 'default' so no two handles share an id
          const cases = [
            ...new Set(
              String(d.node.config?.cases ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter((c) => c && c !== 'default')
            )
          ]
          const handles = [...cases, 'default']
          return (
            <>
              {handles.map((h, i) => (
                <Handle key={h} id={h} type="source" position={Position.Bottom} style={{ left: `${((i + 1) / (handles.length + 1)) * 100}%` }} />
              ))}
              <div className="wf-branches">
                {handles.map((h) => (
                  <span key={h} className={h === 'default' ? 'f' : 't'}>{h}</span>
                ))}
              </div>
            </>
          )
        })()
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  )
}

export function WorkflowEditor({
  workflow,
  onBack,
  onSaved
}: {
  workflow: WorkflowDef
  onBack: () => void
  onSaved: () => void
}): JSX.Element {
  const nodeTypes = useMemo(() => ({ wf: WfNodeView }), [])
  // normalize a possibly hand-edited/corrupt def so .map can't crash the canvas on mount
  const initNodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  const initEdges = Array.isArray(workflow.edges) ? workflow.edges : []
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WfData>>(
    initNodes.map((n, i) => ({
      id: n.id,
      type: 'wf',
      position: { x: n.x ?? 250, y: n.y ?? 80 + i * 120 },
      data: { node: n }
    }))
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    initEdges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, animated: true }))
  )
  const [selId, setSelId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [saved, setSaved] = useState(true)
  const [jsonErr, setJsonErr] = useState<Record<string, string>>({})
  // terminal run result/error shown as a banner — so a run's outcome is actually visible
  const [runBanner, setRunBanner] = useState<{ kind: 'done' | 'error' | 'cancelled'; text?: string } | null>(null)
  const [issues, setIssues] = useState<WorkflowIssue[]>([])
  const [showRuns, setShowRuns] = useState(false)
  const [colorMode, setColorMode] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  )
  const idc = useRef(1)
  // the config field the user last focused — so a clicked variable chip inserts at its caret
  const focusedFieldRef = useRef<{ key: string; el: HTMLInputElement | HTMLTextAreaElement } | null>(null)
  // runId lives in a ref, not state: we subscribe to the event stream ONCE and match
  // against runIdRef.current. Re-subscribing on every runId change (the old approach)
  // risked dropping the first events of a run during the React re-render gap.
  const runIdRef = useRef<string | null>(null)

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, animated: true }, eds))
    setSaved(false)
  }, [setEdges])

  // live per-node status + output/error from the executor's workflow_* events (subscribe once)
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'workflow_node' && e.runId === runIdRef.current) {
        setNodes((ns) =>
          ns.map((n) =>
            n.id === e.nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    status: e.status,
                    // carry the actual data flowing out / the failure reason onto the node
                    ...(e.output !== undefined ? { output: e.output } : {}),
                    ...(e.error !== undefined ? { error: e.error } : {})
                  }
                }
              : n
          )
        )
      } else if (e.type === 'workflow_run' && e.runId === runIdRef.current && e.status !== 'start') {
        setRunning(false)
        if (e.status === 'error') setRunBanner({ kind: 'error', text: e.message })
        else if (e.status === 'cancelled') setRunBanner({ kind: 'cancelled' })
        else setRunBanner({ kind: 'done' })
      }
    })
    return off
  }, [setNodes])

  // a clicked variable chip must never insert into a field from a PREVIOUS node — drop the
  // captured field whenever the selected node changes (re-set on the next field focus).
  useEffect(() => {
    focusedFieldRef.current = null
  }, [selId])

  // keep the React Flow chrome in sync if the app theme is toggled while the editor is open
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const el = document.documentElement
    const obs = new MutationObserver(() => setColorMode(el.getAttribute('data-theme') === 'light' ? 'light' : 'dark'))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  function addNode(type: WorkflowNodeType): void {
    const id = `n${Date.now()}_${idc.current++}`
    const node: WorkflowNode = { id, type, config: {} }
    setNodes((ns) => [
      ...ns,
      { id, type: 'wf', position: { x: 260, y: 100 + ns.length * 60 }, data: { node } }
    ])
    setSelId(id)
    setSaved(false)
  }

  function updateConfig(key: string, value: unknown): void {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selId ? { ...n, data: { ...n.data, node: { ...n.data.node, config: { ...n.data.node.config, [key]: value } } } } : n
      )
    )
    // editing a switch's cases must prune edges wired to a case that no longer exists,
    // else a dangling sourceHandle silently dead-ends the run.
    if (key === 'cases' && selId && nodes.find((n) => n.id === selId)?.data.node.type === 'switch') {
      const live = new Set([
        ...String(value)
          .split(',')
          .map((s) => s.trim())
          .filter((c) => c && c !== 'default'),
        'default'
      ])
      setEdges((es) => es.filter((e) => e.source !== selId || !e.sourceHandle || live.has(e.sourceHandle)))
    }
    setSaved(false)
  }
  function updateLabel(value: string): void {
    setNodes((ns) => ns.map((n) => (n.id === selId ? { ...n, data: { ...n.data, node: { ...n.data.node, label: value } } } : n)))
    setSaved(false)
  }

  // variables available AT a node = 'last' + the outputVar of every upstream (ancestor) node.
  // Lets the data picker show only what actually reaches this node, like n8n — but clearer.
  function upstreamVars(nodeId: string): string[] {
    const rev = new Map<string, string[]>()
    for (const e of edges) (rev.get(e.target) ?? rev.set(e.target, []).get(e.target)!).push(e.source)
    const anc = new Set<string>()
    const stack = [nodeId]
    while (stack.length) {
      const c = stack.pop()!
      for (const s of rev.get(c) ?? []) if (!anc.has(s)) (anc.add(s), stack.push(s))
    }
    anc.delete(nodeId) // a loop-back edge can re-add the start node — it isn't its own ancestor
    const vars = new Set<string>(['last'])
    for (const n of nodes) {
      const ov = n.data.node.config?.outputVar
      if (anc.has(n.id) && typeof ov === 'string' && ov.trim()) vars.add(ov.trim())
    }
    return [...vars]
  }

  // insert {{name}} at the caret of the last-focused config field
  function insertVar(name: string): void {
    const f = focusedFieldRef.current
    if (!f || !selId) return
    const node = nodes.find((n) => n.id === selId)?.data.node
    // bail if the captured field isn't a real field of the CURRENTLY selected node — stops
    // writing a phantom config key (+ a setSelectionRange on a detached element) after the
    // user switched nodes without re-focusing a field.
    const fieldKeys = node ? (NODE_DEFS[node.type] ?? FALLBACK_DEF).fields.map((fd) => fd.key) : []
    if (!fieldKeys.includes(f.key)) return
    const token = `{{${name}}}`
    const cur = String((node?.config || {})[f.key] ?? '')
    const start = f.el.selectionStart ?? cur.length
    const end = f.el.selectionEnd ?? start
    updateConfig(f.key, cur.slice(0, start) + token + cur.slice(end))
    requestAnimationFrame(() => {
      try {
        f.el.focus()
        const p = start + token.length
        f.el.setSelectionRange(p, p)
      } catch {
        /* ignore */
      }
    })
  }

  function toDef(): WorkflowDef {
    return {
      ...workflow,
      nodes: nodes.map((n) => ({ ...n.data.node, x: n.position.x, y: n.position.y })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined }))
    }
  }

  async function save(): Promise<void> {
    await api.saveWorkflow(toDef())
    setSaved(true)
    onSaved()
  }

  // validate the current graph; mark invalid nodes; return the issues
  function validate(): WorkflowIssue[] {
    const iss = validateWorkflow(toDef())
    setIssues(iss)
    setNodes((ns) =>
      ns.map((n) => {
        const e = iss.find((i) => i.nodeId === n.id && i.severity === 'error')
        return { ...n, data: { ...n.data, invalid: !!e, invalidMsg: e?.message } }
      })
    )
    return iss
  }

  async function run(): Promise<void> {
    // never start an invalid workflow — show WHY and which nodes, instead of a dead-end run
    const iss = validate()
    if (hasBlockingErrors(iss)) {
      const n = iss.filter((i) => i.severity === 'error').length
      setRunBanner({ kind: 'error', text: `Validierung: ${n} Problem(e) — siehe markierte Knoten.` })
      return
    }
    await save()
    // Generate the runId HERE and set the ref BEFORE invoking, so it's already in place
    // when the executor's synchronous 'start' + first-node 'running' events arrive over
    // IPC (those are emitted before runWorkflow's reply resolves — a post-await assignment
    // would miss them). crypto.randomUUID matches the server-side safeId slug rule.
    const id = crypto.randomUUID()
    runIdRef.current = id
    setRunBanner(null)
    setIssues([])
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: undefined, output: undefined, error: undefined, invalid: false, invalidMsg: undefined } })))
    setRunning(true)
    try {
      await api.runWorkflow(workflow.id, id)
    } catch {
      runIdRef.current = null
      setRunning(false) // start itself failed → never stuck on the Stop button
    }
  }
  async function cancel(): Promise<void> {
    if (runIdRef.current) await api.cancelWorkflow(runIdRef.current)
    setRunning(false)
  }

  const selected = nodes.find((n) => n.id === selId)?.data.node
  const selDef = selected ? NODE_DEFS[selected.type] ?? FALLBACK_DEF : null

  function handleBack(): void {
    if (!saved && !window.confirm('Ungespeicherte Änderungen verwerfen und zurückgehen?')) return
    onBack()
  }

  return (
    <div className="wf-editor">
      <div className="wf-toolbar">
        <button className="btn ghost sm" onClick={handleBack}>← Zurück</button>
        <strong className="wf-name">{workflow.name}</strong>
        <span className="wf-palette">
          {PALETTE.map((t) => (
            <button key={t} className="btn ghost sm" onClick={() => addNode(t)} title={`${NODE_DEFS[t].label} hinzufügen`}>
              {NODE_DEFS[t].icon} {NODE_DEFS[t].label}
            </button>
          ))}
        </span>
        <span className="spacer" />
        {!saved && <span className="wf-dirty" title="Ungespeicherte Änderungen">●</span>}
        <button className="btn ghost sm" onClick={() => { const i = validate(); setRunBanner(hasBlockingErrors(i) ? { kind: 'error', text: `${i.filter((x) => x.severity === 'error').length} Problem(e) gefunden.` } : { kind: 'done', text: i.length ? `${i.length} Hinweis(e).` : 'Alles gut.' }) }}>✓ Prüfen</button>
        <button
          className={'btn ghost sm' + (showRuns ? ' on' : '')}
          onClick={() => setShowRuns((s) => { const next = !s; if (next) setSelId(null); return next })}
        >🕘 Verlauf</button>
        <button className="btn ghost sm" onClick={save}>Speichern</button>
        {running ? (
          <button className="btn ghost sm" onClick={cancel}>⏹ Stop</button>
        ) : (
          <button className="btn sm" onClick={run}>▶ Ausführen</button>
        )}
      </div>
      <div className="wf-canvas-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={(c) => {
            onNodesChange(c)
            if (c.some((x) => x.type === 'position' || x.type === 'remove')) setSaved(false)
          }}
          onEdgesChange={(c) => {
            onEdgesChange(c)
            if (c.some((x) => x.type === 'remove')) setSaved(false)
          }}
          onNodesDelete={(deleted) => {
            // remove edges connected to a deleted node so no dangling edge corrupts traversal
            const ids = new Set(deleted.map((n) => n.id))
            setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)))
            if (selId && ids.has(selId)) setSelId(null)
            setSaved(false)
          }}
          onConnect={onConnect}
          onNodeClick={(_e, n) => { setSelId(n.id); setShowRuns(false) }}
          onPaneClick={() => setSelId(null)}
          nodeTypes={nodeTypes}
          colorMode={colorMode}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap pannable />
        </ReactFlow>
        {runBanner && (
          <div className={'wf-runbanner ' + runBanner.kind} role="status">
            <span>
              {runBanner.kind === 'done' && '✅ '}
              {runBanner.kind === 'cancelled' && '🚫 '}
              {runBanner.kind === 'error' && '❌ '}
              {runBanner.text ??
                (runBanner.kind === 'done'
                  ? 'Workflow fertig.'
                  : runBanner.kind === 'cancelled'
                    ? 'Workflow abgebrochen.'
                    : 'Workflow fehlgeschlagen.')}
            </span>
            <button className="chip-x" onClick={() => setRunBanner(null)}>✕</button>
          </div>
        )}
        {issues.length > 0 && (
          <div className="wf-issues" role="list">
            <div className="wf-issues-head">
              {issues.filter((i) => i.severity === 'error').length} Fehler · {issues.filter((i) => i.severity === 'warn').length} Hinweise
              <button className="chip-x" onClick={() => setIssues([])}>✕</button>
            </div>
            {issues.map((i, k) => (
              <button
                key={k}
                className={'wf-issue ' + i.severity}
                onClick={() => i.nodeId && setSelId(i.nodeId)}
                title={i.nodeId ? 'Knoten anzeigen' : ''}
              >
                {i.severity === 'error' ? '⛔' : '⚠'} {i.message}
              </button>
            ))}
          </div>
        )}
        {showRuns && <RunHistory workflowId={workflow.id} onClose={() => setShowRuns(false)} />}
        {selected && selDef && (
          <div className="wf-drawer">
            <div className="wf-drawer-head">
              <span>{selDef.icon} {selDef.label}</span>
              <button className="chip-x" onClick={() => setSelId(null)}>✕</button>
            </div>
            <div className="field">
              <label>Beschriftung</label>
              <input value={selected.label ?? ''} onChange={(e) => updateLabel(e.target.value)} placeholder={selDef.label} />
            </div>
            {selId && selDef.fields.length > 0 && (
              <div className="wf-varbar">
                <span className="wf-varbar-label">Variablen einfügen:</span>
                {upstreamVars(selId).map((v) => (
                  <button
                    key={v}
                    className="wf-varchip"
                    onMouseDown={(e) => e.preventDefault()} // keep the field focused + caret
                    onClick={() => insertVar(v)}
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            )}
            {selDef.fields.map((f) => {
              const cfg = selected.config || {}
              if (f.kind === 'json') {
                const errKey = `${selId}:${f.key}`
                const err = jsonErr[errKey]
                return (
                  <div className="field" key={f.key}>
                    <label>{f.label}</label>
                    <textarea
                      className={err ? 'invalid' : ''}
                      value={typeof cfg[f.key] === 'object' ? JSON.stringify(cfg[f.key], null, 2) : String(cfg[f.key] ?? '{}')}
                      onChange={(e) => {
                        const txt = e.target.value
                        try {
                          updateConfig(f.key, JSON.parse(txt || '{}'))
                          setJsonErr((m) => (m[errKey] ? { ...m, [errKey]: '' } : m))
                        } catch (ex) {
                          // keep raw text so the user can keep typing; flag it so a save/run
                          // doesn't silently send invalid JSON (the executor falls back to {}).
                          updateConfig(f.key, txt)
                          setJsonErr((m) => ({ ...m, [errKey]: (ex as Error).message }))
                        }
                      }}
                    />
                    {err && <span className="wf-field-err">⚠ Ungültiges JSON — wird als leer behandelt. ({err})</span>}
                  </div>
                )
              }
              return (
                <div className="field" key={f.key}>
                  <label>{f.label}</label>
                  {f.kind === 'textarea' ? (
                    <textarea
                      value={String(cfg[f.key] ?? '')}
                      onFocus={(e) => (focusedFieldRef.current = { key: f.key, el: e.currentTarget })}
                      onChange={(e) => updateConfig(f.key, e.target.value)}
                    />
                  ) : (
                    <input
                      value={String(cfg[f.key] ?? '')}
                      onFocus={(e) => (focusedFieldRef.current = { key: f.key, el: e.currentTarget })}
                      onChange={(e) => updateConfig(f.key, e.target.value)}
                    />
                  )}
                </div>
              )
            })}
            {['agent', 'tool', 'shell', 'http', 'subworkflow', 'transform'].includes(selected.type) && (
              <div className="wf-adv">
                <div className="wf-adv-head">Fehlerbehandlung</div>
                <div className="row">
                  <div className="field">
                    <label>Wiederholungen (0–10)</label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={Number(selected.config?.retries ?? 0)}
                      onChange={(e) => updateConfig('retries', Math.max(0, Math.min(10, Number(e.target.value) || 0)))}
                    />
                  </div>
                  <div className="field">
                    <label>Pause (s)</label>
                    <input
                      type="number"
                      min={0}
                      max={300}
                      value={Number(selected.config?.retryDelaySec ?? 0)}
                      onChange={(e) => updateConfig('retryDelaySec', Math.max(0, Math.min(300, Number(e.target.value) || 0)))}
                    />
                  </div>
                </div>
                <label className="wf-check">
                  <input
                    type="checkbox"
                    checked={selected.config?.continueOnError === true}
                    onChange={(e) => updateConfig('continueOnError', e.target.checked)}
                  />
                  Bei Fehler fortfahren (Workflow nicht abbrechen)
                </label>
              </div>
            )}
            <p className="wf-hint">
              Variablen: jeder Knoten schreibt sein Ergebnis nach <code>{'{{last}}'}</code> (oder die gesetzte Variable).
              Im Prompt/Template mit <code>{'{{name}}'}</code> einsetzen.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
