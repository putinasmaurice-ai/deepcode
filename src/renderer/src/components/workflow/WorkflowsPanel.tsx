import { useEffect, useRef, useState } from 'react'
import type { WorkflowDef, WorkflowRun } from '../../../../shared/types'
import { WORKFLOW_TEMPLATES, instantiateTemplate } from '../../../../shared/workflow-templates'
import { WorkflowEditor } from './WorkflowEditor'

const api = window.deepcode

function uid(): string {
  return 'wf_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

// Trigger mode lives on the (first) trigger node's config — derive a friendly badge from it.
function triggerOf(w: WorkflowDef): { icon: string; label: string } {
  const t = w.nodes.find((n) => n.type === 'trigger')
  const mode = String((t?.config as Record<string, unknown>)?.mode ?? 'manual')
  if (mode === 'cron') return { icon: '⏰', label: 'Zeitplan' }
  if (mode === 'filewatch') return { icon: '👁', label: 'Datei-Watch' }
  return { icon: '▶', label: 'Manuell' }
}

// Card icon derived from the first non-trigger action node's kind (falls back to a generic gear).
const KIND_ICON: Record<string, string> = {
  agent: '🤖', tool: '🔧', shell: '⌨️', http: '🌐', condition: '🔀', switch: '🔀',
  transform: '✨', notify: '🔔', email: '✉️', channel: '📣', store: '💾', code: '📜',
  parse: '🧩', output: '📤', loop: '🔁', parallel: '🪢', merge: '🔗', delay: '⏳'
}
function iconOf(w: WorkflowDef): string {
  const action = w.nodes.find((n) => n.type !== 'trigger')
  return (action && KIND_ICON[action.type]) || '🕸️'
}

function lastRunHint(r?: WorkflowRun): string {
  if (!r) return ''
  const map: Record<string, string> = { done: '✅ erfolgreich', failed: '❌ fehlgeschlagen', running: '⏳ läuft', cancelled: '🚫 abgebrochen' }
  const ago = Math.max(0, Math.round((Date.now() - r.startedAt) / 60000))
  const when = ago < 1 ? 'gerade eben' : ago < 60 ? `vor ${ago} min` : ago < 1440 ? `vor ${Math.round(ago / 60)} h` : `vor ${Math.round(ago / 1440)} d`
  return `${map[r.status] ?? r.status} · ${when}`
}

export function WorkflowsPanel(): JSX.Element {
  const [list, setList] = useState<WorkflowDef[]>([])
  const [runs, setRuns] = useState<Record<string, WorkflowRun | undefined>>({})
  const [editing, setEditing] = useState<WorkflowDef | null>(null)
  const [genText, setGenText] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState('')
  const [showTemplates, setShowTemplates] = useState(false)

  // generation is a multi-second (possibly two-call) LLM round-trip; the panel can unmount
  // (App-level view switch) before it settles — guard the post-await setState against that.
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  function refresh(): void {
    api.listWorkflows().then((ws) => {
      if (!mounted.current) return
      setList(ws)
      // best-effort last-run hint per card — never blocks the grid render.
      ws.forEach((w) => {
        api
          .listWorkflowRuns(w.id)
          .then((rs) => { if (mounted.current) setRuns((m) => ({ ...m, [w.id]: rs[0] })) })
          .catch(() => {})
      })
    })
  }
  useEffect(() => { refresh() }, [])

  async function create(): Promise<void> {
    const id = uid()
    const def: WorkflowDef = {
      id,
      name: 'Neuer Workflow',
      nodes: [{ id: 'n_trigger', type: 'trigger', label: 'Start', config: {}, x: 250, y: 60 }],
      edges: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await api.saveWorkflow(def)
    refresh()
    setEditing(def)
  }

  async function createFromTemplate(key: string): Promise<void> {
    if (!key) return
    const def = instantiateTemplate(key, uid(), Date.now())
    if (!def) return
    await api.saveWorkflow(def)
    refresh()
    setEditing(def) // open it so the user can tweak before running
  }

  async function generate(): Promise<void> {
    const text = genText.trim()
    if (!text || genBusy) return
    setGenBusy(true)
    setGenError('')
    try {
      const def = await api.generateWorkflow(text)
      if (!mounted.current) return // panel was closed/switched away during the call
      setGenText('')
      refresh()
      if (def) setEditing(def) // open the generated workflow so the user can review/tweak
    } catch (e) {
      if (mounted.current) setGenError(String((e as Error)?.message ?? e))
    } finally {
      if (mounted.current) setGenBusy(false)
    }
  }

  async function remove(id: string, name: string): Promise<void> {
    if (!window.confirm(`Workflow „${name}" löschen?`)) return
    await api.deleteWorkflow(id)
    refresh()
  }

  async function open(id: string): Promise<void> {
    const def = await api.getWorkflow(id)
    if (def) setEditing(def)
  }

  async function rename(def: WorkflowDef): Promise<void> {
    const name = window.prompt('Workflow-Name:', def.name)
    if (!name) return
    await api.saveWorkflow({ ...def, name })
    refresh()
  }

  async function doImport(): Promise<void> {
    try {
      const def = await api.importWorkflow()
      if (def) {
        refresh()
        setEditing(def) // open the freshly imported workflow
      }
    } catch (e) {
      window.alert(String(e))
    }
  }

  if (editing) {
    return (
      <WorkflowEditor
        key={editing.id} // remount on workflow switch so the canvas re-syncs to the new def
        workflow={editing}
        onBack={() => { setEditing(null); refresh() }}
        onSaved={refresh}
      />
    )
  }

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>🕸️ Workflows</h1>
        <p className="sub">
          Baue visuelle Automatisierungen aus Knoten (Agent, Tool, Shell, HTTP, Bedingung, Output) — verdrahtet,
          ausführbar und live nachvollziehbar. Wie n8n, nur klarer.
        </p>

        <div className="wf-hero">
          <h2>✨ Beschreibe deinen Workflow</h2>
          <textarea
            className="wf-hero-input"
            value={genText}
            onChange={(e) => setGenText(e.target.value)}
            placeholder="z. B. „Hole eine URL, fasse den Inhalt zusammen und schicke mir eine Benachrichtigung."
            rows={2}
            disabled={genBusy}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate() }}
          />
          {genError && <div role="alert" className="wf-field-err">{genError}</div>}
          <div className="wf-hero-actions">
            <button className="btn" onClick={generate} disabled={genBusy || !genText.trim()}>
              {genBusy ? '✨ Erzeuge…' : '✨ Erzeugen'}
            </button>
            <button className="btn ghost" onClick={create} disabled={genBusy}>+ Neuer Workflow</button>
            <button className="btn ghost" onClick={() => setShowTemplates((v) => !v)} disabled={genBusy}>
              📋 Aus Vorlage
            </button>
            <button className="btn ghost" onClick={doImport} disabled={genBusy}>⬆ Importieren</button>
            <span className="wf-hint" style={{ marginLeft: 'auto' }}>Strg/⌘+Enter</span>
          </div>
        </div>

        {showTemplates && (
          <div className="wf-card-grid" style={{ marginBottom: 16 }}>
            {WORKFLOW_TEMPLATES.map((t) => (
              <button key={t.key} className="wf-tpl-card" onClick={() => createFromTemplate(t.key)} title={t.description}>
                <span className="wf-tpl-ico">{KIND_ICON[t.nodes.find((n) => n.type !== 'trigger')?.type ?? ''] || '🕸️'}</span>
                <span className="wf-tpl-name">{t.name}</span>
                <span className="wf-tpl-desc">{t.description}</span>
                <span className="wf-card-badge">{t.category}</span>
              </button>
            ))}
          </div>
        )}

        {list.length === 0 ? (
          <div className="wf-empty-hero">
            <div className="wf-empty-orb">🪄</div>
            <h3>Noch keine Workflows</h3>
            <p>Beschreibe oben einen Workflow, wähle eine Vorlage oder starte leer.</p>
          </div>
        ) : (
          <div className="wf-card-grid">
            {list.map((w) => {
              const tr = triggerOf(w)
              const hint = lastRunHint(runs[w.id])
              return (
                <div key={w.id} className="wf-card">
                  <div className="wf-card-main" onClick={() => open(w.id)} role="button" title="Öffnen">
                    <div className="wf-card-head">
                      <span className="wf-card-icon">{iconOf(w)}</span>
                      <strong>{w.name}</strong>
                      <span className="wf-card-badge" title={tr.label}>{tr.icon} {tr.label}</span>
                    </div>
                    {w.description && <p className="wf-hint wf-card-desc">{w.description}</p>}
                    <div className="wf-hint">{w.nodes.length} Knoten · {w.edges.length} Verbindungen{hint ? ` · ${hint}` : ''}</div>
                  </div>
                  <div className="wf-card-actions">
                    <button className="btn ghost sm" onClick={() => open(w.id)}>Öffnen</button>
                    <button className="btn ghost sm" onClick={() => rename(w)}>Umbenennen</button>
                    <button className="btn ghost sm" onClick={() => api.exportWorkflow(w.id).catch((e) => window.alert(String(e)))}>Export</button>
                    <button className="btn ghost sm" onClick={() => remove(w.id, w.name)}>Löschen</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
