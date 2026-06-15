import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@xyflow/react/dist/style.css' // co-located so it loads only with the (lazy) editor
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
import { NeonEdge } from './NeonEdge'
import { RunFx } from './RunFx'
import { WorkflowChat } from './WorkflowChat'

const api = window.deepcode

interface FieldDef {
  key: string
  label: string
  kind: 'text' | 'textarea' | 'json' | 'workflowRef'
  emptyDefault?: string // shown in a json field when unset (e.g. '[]' for array fields)
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
      { key: 'mode', label: 'Start: manual | cron | filewatch', kind: 'text' },
      { key: 'cron', label: 'Cron (Min Std Tag Mon Wochentag) — z.B. 0 9 * * *', kind: 'text' },
      { key: 'path', label: 'Watch-Pfad (filewatch; leer = ganzes Projekt, z.B. src)', kind: 'text' },
      { key: 'glob', label: 'Watch-Filter (filewatch; z.B. *.md — leer = alle)', kind: 'text' }
    ]
  },
  agent: {
    icon: '🧠',
    label: 'Agent-Step',
    fields: [
      { key: 'prompt', label: 'Prompt (nutzt {{var}})', kind: 'textarea' },
      { key: 'model', label: 'Modell (leer = Standard; z.B. openai:gpt-4o, google:gemini-2.5-pro, deepinfra:…)', kind: 'text' },
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
      { key: 'method', label: 'Methode (GET/POST/PUT/PATCH/DELETE — leer = GET)', kind: 'text' },
      { key: 'headers', label: 'Header (JSON, z.B. {"Content-Type":"application/json"})', kind: 'json', emptyDefault: '{}' },
      { key: 'body', label: 'Body (z.B. JSON — nutzt {{var}}/{{secret.NAME}})', kind: 'textarea' },
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
    fields: [{ key: 'workflowId', label: 'Workflow', kind: 'workflowRef' }]
  },
  loop: {
    icon: '🔁',
    label: 'Schleife (forEach)',
    fields: [
      { key: 'listExpr', label: 'Liste (JSON-Array oder Zeilen, nutzt {{var}})', kind: 'textarea' },
      { key: 'listFormat', label: 'Format: auto | json | lines', kind: 'text' },
      { key: 'itemVar', label: 'Item-Variable (Default item)', kind: 'text' },
      { key: 'indexVar', label: 'Index-Variable (Default index)', kind: 'text' },
      { key: 'bodyWorkflowId', label: 'Body-Workflow (pro Item ausgeführt)', kind: 'workflowRef' },
      { key: 'mode', label: 'Modus: sequential | parallel', kind: 'text' },
      { key: 'concurrency', label: 'Parallelität (1–8, nur parallel)', kind: 'text' },
      { key: 'collectAs', label: 'Sammeln als: json | join | last', kind: 'text' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  parallel: {
    icon: '🍴',
    label: 'Parallel',
    fields: [
      { key: 'branches', label: 'Branches (JSON: [{"workflowId":"…","resultVar":"a"}])', kind: 'json', emptyDefault: '[]' },
      { key: 'concurrency', label: 'Parallelität (1–8)', kind: 'text' },
      { key: 'mergeMode', label: 'Zusammenführen: array | object | join', kind: 'text' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  merge: {
    icon: '🪢',
    label: 'Zusammenführen',
    fields: [
      { key: 'inputs', label: 'Variablen (kommagetrennt)', kind: 'text' },
      { key: 'mode', label: 'Modus: array | concat | object | pick', kind: 'text' },
      { key: 'separator', label: 'Trenner (mode=concat)', kind: 'text' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
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
  store: {
    icon: '🗄️',
    label: 'KV-Speicher',
    fields: [
      { key: 'op', label: 'Operation: get / set / incr / has / delete', kind: 'text' },
      { key: 'storeKey', label: 'Schlüssel (nutzt {{var}})', kind: 'text' },
      { key: 'value', label: 'Wert (für set/incr; nutzt {{var}})', kind: 'text' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  code: {
    icon: '🧩',
    label: 'Code (JS)',
    fields: [
      { key: 'code', label: 'JS — verfügbar: vars, last (geparst), input, JSON, Math, Date; mit return <Wert>', kind: 'textarea' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  parse: {
    icon: '🔎',
    label: 'Parsen',
    fields: [
      { key: 'mode', label: 'Modus: json / csv / html', kind: 'text' },
      { key: 'input', label: 'Eingabe (Default {{last}})', kind: 'text' },
      { key: 'path', label: 'JSON-Pfad (nur json, z.B. data.items[0].name)', kind: 'text' },
      { key: 'outputVar', label: 'Ergebnis-Variable', kind: 'text' }
    ]
  },
  channel: {
    icon: '📣',
    label: 'Kanal',
    fields: [
      { key: 'channel', label: 'Kanal: telegram / slack / discord / webhook', kind: 'text' },
      { key: 'url', label: 'Webhook-URL (slack/discord/webhook)', kind: 'text' },
      { key: 'chatId', label: 'Telegram chat_id (leer = {{secret.TELEGRAM_CHAT_ID}})', kind: 'text' },
      { key: 'message', label: 'Nachricht (nutzt {{var}})', kind: 'textarea' }
    ]
  },
  email: {
    icon: '✉️',
    label: 'E-Mail (SMTP)',
    fields: [
      { key: 'host', label: 'SMTP-Host (z.B. smtp.gmail.com)', kind: 'text' },
      { key: 'port', label: 'Port (465 = TLS, 587 = STARTTLS)', kind: 'text' },
      { key: 'secure', label: 'Implizites TLS: true (465) / false (587)', kind: 'text' },
      { key: 'user', label: 'Login-Benutzer (meist die Absender-Adresse)', kind: 'text' },
      { key: 'pass', label: 'Passwort (leer = {{secret.SMTP_PASS}})', kind: 'text' },
      { key: 'from', label: 'Absender (From)', kind: 'text' },
      { key: 'to', label: 'Empfänger (To, kommagetrennt)', kind: 'text' },
      { key: 'subject', label: 'Betreff (nutzt {{var}})', kind: 'text' },
      { key: 'body', label: 'Text (Default {{last}})', kind: 'textarea' }
    ]
  },
  output: {
    icon: '📤',
    label: 'Output',
    fields: [{ key: 'template', label: 'Ausgabe-Template (Default {{last}})', kind: 'textarea' }]
  }
}
const PALETTE: WorkflowNodeType[] = ['agent', 'tool', 'shell', 'http', 'condition', 'switch', 'transform', 'code', 'parse', 'store', 'channel', 'email', 'loop', 'parallel', 'merge', 'delay', 'notify', 'subworkflow', 'output']

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
  // executor emits 'failed'; the locked CSS contract styles .st-error → add it so the
  // red shake fires while keeping the original .st-failed for any existing selectors.
  const statusCls = d.status ? ' st-' + d.status + (d.status === 'failed' ? ' st-error' : '') : ''
  return (
    <div
      className={'wf-node' + (selected ? ' sel' : '') + (d.invalid ? ' invalid' : '') + statusCls}
      data-kind={d.node.type}
    >
      {/* satisfying particle burst the instant a node finishes — keyed on status so it
          fires once per transition; RunFx self-cleans + honors prefers-reduced-motion */}
      {d.status === 'done' && <RunFx kind="burst" trigger={'done'} />}
      {d.node.type !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <div className="wf-node-head">
        <span className="wf-ic">{def.icon}</span>
        <span className="wf-ttl">{d.node.label || def.label}</span>
        {d.status && <span className="wf-st">{STATUS_DOT[d.status]}</span>}
      </div>
      {/* a cron-triggered start shows its schedule so "runs automatically" is visible */}
      {d.node.type === 'trigger' && d.node.config?.mode === 'cron' && d.node.config?.cron ? (
        <div className="wf-node-out" title="Cron-Zeitplan">⏰ {String(d.node.config.cron)}</div>
      ) : d.node.type === 'trigger' && d.node.config?.mode === 'filewatch' ? (
        <div className="wf-node-out" title="Datei-Überwachung">
          👁 {String(d.node.config.path || 'Projekt')}
          {d.node.config?.glob ? ` · ${String(d.node.config.glob)}` : ''}
        </div>
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
  const edgeTypes = useMemo(() => ({ neon: NeonEdge }), [])
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
    initEdges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, type: 'neon', data: {} }))
  )
  const [selId, setSelId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [saved, setSaved] = useState(true)
  // opt-in self-healing for unattended runs (cron/file-watch/chat) — local state since `workflow`
  // is an immutable prop; folded back into the def by toDef().
  const [autoHeal, setAutoHeal] = useState(!!workflow.autoHeal)
  const [jsonErr, setJsonErr] = useState<Record<string, string>>({})
  // terminal run result/error shown as a banner — so a run's outcome is actually visible
  const [runBanner, setRunBanner] = useState<{ kind: 'done' | 'error' | 'cancelled'; text?: string } | null>(null)
  const [issues, setIssues] = useState<WorkflowIssue[]>([])
  // live run-HUD: how many nodes finished / the currently executing node's name, for the
  // "Knoten X/Y · '<name>' läuft" overlay + progress fill. derived only during a run.
  const [hud, setHud] = useState<{ done: number; total: number; current: string | null } | null>(null)
  // pending timer that clears the HUD a moment after a successful run (so the bar visibly fills
  // to 100% — on a branching graph not all nodes execute, so `done` plateaus below `total`).
  const hudClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // a celebratory confetti burst near the output node when the whole run succeeds; the
  // changing trigger (run id) makes RunFx fire exactly once per successful run.
  const [celebrate, setCelebrate] = useState<string | null>(null)
  const [showRuns, setShowRuns] = useState(false)
  // in-tab chat dock — describe/iterate THIS workflow in plain words while the graph
  // builds + animates live. Collapsed by default; toggled from the toolbar.
  const [showChat, setShowChat] = useState(false)
  const [secretNames, setSecretNames] = useState<string[]>([])
  const [wfList, setWfList] = useState<{ id: string; name: string }[]>([])
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
  // live-sync guards: mirror state the (subscribe-once) event handler needs, so a chat-built
  // edit can be reloaded without re-subscribing or pulling stale closure values.
  const syncStateRef = useRef({ nodes, edges, saved: true, running: false })
  syncStateRef.current = { nodes, edges, saved, running }

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, type: 'neon', data: {} }, eds))
    setSaved(false)
  }, [setEdges])

  // secret NAMES (never values) for the picker — only insertable in tool/shell/http args
  useEffect(() => {
    api.secretsList().then(setSecretNames).catch(() => setSecretNames([]))
    // workflows list for the workflowRef <select> (loop body / sub-workflow / parallel)
    api
      .listWorkflows()
      .then((ws) => setWfList(ws.map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => setWfList([]))
  }, [])

  // re-fetch the persisted workflow and, if its graph differs from the canvas, reload it —
  // so a chat agent that built/edited THIS workflow shows up live. Never clobbers a run in
  // progress or unsaved manual edits. Stable identity (refs hold the live state it reads).
  const syncFromDisk = useCallback(() => {
    const s = syncStateRef.current
    if (s.running || !s.saved) return // don't overwrite a live run or pending hand edits
    api
      .getWorkflow(workflow.id)
      .then((def) => {
        if (!def) return
        const sig = (
          ns: { id: string; type?: string; label?: string; config?: unknown }[],
          es: { source: string; target: string; sourceHandle?: string | null }[]
        ): string =>
          JSON.stringify([
            ns.map((n) => [n.id, n.type, n.label ?? '', JSON.stringify(n.config ?? {})]).sort(),
            es.map((e) => [e.source, e.target, e.sourceHandle ?? '']).sort()
          ])
        const diskSig = sig(def.nodes ?? [], def.edges ?? [])
        const liveSig = sig(
          s.nodes.map((n) => ({ id: n.id, type: n.data.node.type, label: n.data.node.label, config: n.data.node.config })),
          s.edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle }))
        )
        if (diskSig === liveSig) return // nothing changed — leave the canvas untouched
        const dn = Array.isArray(def.nodes) ? def.nodes : []
        const de = Array.isArray(def.edges) ? def.edges : []
        // preserve the user's hand-arranged layout: a chat edit re-runs autolayout and may
        // re-supply existing nodes without coordinates, which would otherwise stack the whole
        // graph vertically. Keep the live canvas position for any id still present; only place
        // genuinely NEW nodes (prefer their disk x/y, else the vertical fallback).
        const livePos = new Map(s.nodes.map((n) => [n.id, n.position]))
        setNodes(dn.map((n, i) => ({ id: n.id, type: 'wf', position: livePos.get(n.id) ?? { x: n.x ?? 250, y: n.y ?? 80 + i * 120 }, data: { node: n } })))
        setEdges(de.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, type: 'neon', data: {} })))
        setSaved(true)
      })
      .catch(() => {})
  }, [workflow.id, setNodes, setEdges])

  // live per-node status + output/error from the executor's workflow_* events (subscribe once)
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'workflow_node' && e.runId === runIdRef.current) {
        let curName: string | null = null
        setNodes((ns) =>
          ns.map((n) => {
            if (n.id !== e.nodeId) return n
            if (e.status === 'running') curName = n.data.node.label || NODE_DEFS[n.data.node.type]?.label || 'Knoten'
            return {
              ...n,
              data: {
                ...n.data,
                status: e.status,
                // carry the actual data flowing out / the failure reason onto the node
                ...(e.output !== undefined ? { output: e.output } : {}),
                ...(e.error !== undefined ? { error: e.error } : {})
              }
            }
          })
        )
        // light up the active path: the node's INCOMING edges glow with its status, so the
        // neon flow + traveling packet visibly travel into the node that's executing.
        setEdges((es) => es.map((ed) => (ed.target === e.nodeId ? { ...ed, data: { ...ed.data, status: e.status } } : ed)))
        // drive the run-HUD (done count + currently running node) — terminal statuses advance it
        setHud((h) => {
          const total = h?.total ?? syncStateRef.current.nodes.length
          const advanced = e.status === 'done' || e.status === 'failed' || e.status === 'skipped'
          return {
            total,
            done: Math.min(total, (h?.done ?? 0) + (advanced ? 1 : 0)),
            current: e.status === 'running' ? curName : (h?.current ?? null)
          }
        })
      } else if (e.type === 'workflow_run' && e.runId === runIdRef.current && e.status !== 'start') {
        setRunning(false)
        if (e.status === 'error') {
          setHud(null)
          setRunBanner({ kind: 'error', text: e.message })
        } else if (e.status === 'cancelled') {
          setHud(null)
          setRunBanner({ kind: 'cancelled' })
        } else {
          // success: fill the bar to 100% (branching means done<total during the run), let it
          // read for a moment, then retire it. clear any prior timer so a fast re-run can't be
          // wiped by a stale clear.
          setHud((h) => (h ? { ...h, done: h.total, current: null } : null))
          if (hudClearRef.current) clearTimeout(hudClearRef.current)
          hudClearRef.current = setTimeout(() => setHud(null), 1500)
          setRunBanner({ kind: 'done' })
          setCelebrate(e.runId) // celebratory confetti near the output node
        }
      } else if (e.type === 'turn_done') {
        // a chat agent may have created/edited THIS workflow mid-conversation — re-fetch and,
        // if the persisted graph differs from the canvas, reload it so the change appears live.
        syncFromDisk()
      }
    })
    return off
  }, [setNodes, setEdges, syncFromDisk])

  // auto-retire the celebration layer once the confetti has played (RunFx self-cleans its
  // particles; this clears the wrapper so it can't linger or re-trigger). cancel on unmount.
  useEffect(() => {
    if (!celebrate) return
    const t = setTimeout(() => setCelebrate(null), 1600)
    return () => clearTimeout(t)
  }, [celebrate])

  // clear the pending HUD-retire timer on unmount
  useEffect(() => () => { if (hudClearRef.current) clearTimeout(hudClearRef.current) }, [])

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
      autoHeal,
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
    setCelebrate(null)
    setIssues([])
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: undefined, output: undefined, error: undefined, invalid: false, invalidMsg: undefined } })))
    // clear any leftover edge glow from a previous run so only the live path lights up
    setEdges((es) => es.map((e) => ({ ...e, data: { ...e.data, status: undefined } })))
    if (hudClearRef.current) clearTimeout(hudClearRef.current) // a new run cancels a pending HUD retire
    setHud({ done: 0, total: nodes.length, current: null })
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
    setHud(null)
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
        <label className="wf-autoheal" title="Bei einem Knoten-Fehler repariert der In-Process-Coder den Workflow automatisch (Knoten-Config oder Projektdatei) und lässt ihn ab dem Knoten erneut laufen — nur für unbeaufsichtigte Läufe (Cron/Datei-Watch/Chat).">
          <input type="checkbox" checked={autoHeal} onChange={(e) => { setAutoHeal(e.target.checked); setSaved(false) }} /> 🩹 Auto-Heilung
        </label>
        <button className="btn ghost sm" onClick={() => { const i = validate(); setRunBanner(hasBlockingErrors(i) ? { kind: 'error', text: `${i.filter((x) => x.severity === 'error').length} Problem(e) gefunden.` } : { kind: 'done', text: i.length ? `${i.length} Hinweis(e).` : 'Alles gut.' }) }}>✓ Prüfen</button>
        <button
          className={'btn ghost sm' + (showRuns ? ' on' : '')}
          onClick={() => setShowRuns((s) => { const next = !s; if (next) setSelId(null); return next })}
        >🕘 Verlauf</button>
        <button
          className={'btn ghost sm wf-chat-toggle' + (showChat ? ' on' : '')}
          onClick={() => setShowChat((s) => !s)}
          title="Beschreibe den Workflow in Worten — der Assistent baut + ändert ihn live"
        >💬 Assistent</button>
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
          edgeTypes={edgeTypes}
          colorMode={colorMode}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap pannable />
        </ReactFlow>
        {/* inviting empty-state: a workflow with just the trigger (≤1 node) gets a hero
            instead of a blank canvas, nudging the user to describe it or drag a node */}
        {nodes.length <= 1 && !showRuns && (
          <div className="wf-empty-hero" role="note">
            <div className="wf-empty-orb">✨</div>
            <h3>Beschreibe deinen Workflow</h3>
            <p>oder zieh dir Knoten aus der Palette oben zusammen — verbinde sie und drück ▶ Ausführen.</p>
          </div>
        )}
        {/* live run-HUD: which node is running + how far we are through the graph */}
        {hud && (
          <div className="wf-runhud" role="status" aria-live="polite">
            <div className="wf-runhud-text">
              Knoten {Math.min(hud.done + (hud.current ? 1 : 0), hud.total)}/{hud.total}
              {hud.current ? <> · „{hud.current}" läuft…</> : ' · startet…'}
            </div>
            <div className="wf-runhud-track">
              <div className="wf-runhud-fill" style={{ width: `${hud.total ? (hud.done / hud.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        {/* celebratory confetti near the output/last node when the whole run succeeds */}
        {celebrate && (
          <div className="wf-celebrate-layer" aria-hidden>
            <RunFx kind="confetti" trigger={celebrate} />
          </div>
        )}
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
                {/* secrets — only insertable in deterministic-arg nodes (never agent prompts) */}
                {['tool', 'shell', 'http', 'channel', 'email'].includes(selected.type) &&
                  secretNames.map((s) => (
                    <button
                      key={'secret-' + s}
                      className="wf-varchip secret"
                      title="Verschlüsseltes Secret"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertVar('secret.' + s)}
                    >
                      🔑 {s}
                    </button>
                  ))}
              </div>
            )}
            {selDef.fields.map((f) => {
              const cfg = selected.config || {}
              if (f.kind === 'workflowRef') {
                return (
                  <div className="field" key={f.key}>
                    <label>{f.label}</label>
                    <select value={String(cfg[f.key] ?? '')} onChange={(e) => updateConfig(f.key, e.target.value)}>
                      <option value="">— Workflow wählen —</option>
                      {wfList
                        .filter((w) => w.id !== workflow.id) /* exclude self → no direct self-ref */
                        .map((w) => (
                          <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                    </select>
                  </div>
                )
              }
              if (f.kind === 'json') {
                const errKey = `${selId}:${f.key}`
                const err = jsonErr[errKey]
                return (
                  <div className="field" key={f.key}>
                    <label>{f.label}</label>
                    <textarea
                      className={err ? 'invalid' : ''}
                      value={typeof cfg[f.key] === 'object' ? JSON.stringify(cfg[f.key], null, 2) : String(cfg[f.key] ?? (f.emptyDefault ?? '{}'))}
                      onChange={(e) => {
                        const txt = e.target.value
                        try {
                          updateConfig(f.key, JSON.parse(txt || (f.emptyDefault ?? '{}')))
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
            {['agent', 'tool', 'shell', 'http', 'subworkflow', 'transform', 'loop', 'parallel', 'store', 'code', 'parse', 'channel', 'email'].includes(selected.type) && (
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
        {/* in-tab chat dock — sibling of .react-flow inside the flex .wf-canvas-wrap, so the
            canvas shrinks to the remaining width while the dock sits on the right. Collapsed
            by default; describe/iterate THIS workflow in words and syncFromDisk() reloads the
            canvas live after each turn. */}
        <WorkflowChat
          workflow={workflow}
          onWorkflowChanged={syncFromDisk}
          onClose={() => setShowChat(false)}
          hidden={!showChat}
        />
      </div>
    </div>
  )
}
