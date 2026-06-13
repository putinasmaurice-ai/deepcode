import { useEffect, useRef, useState } from 'react'
import type { WorkflowDef } from '../../../../shared/types'
import { WORKFLOW_TEMPLATES, instantiateTemplate } from '../../../../shared/workflow-templates'
import { WorkflowEditor } from './WorkflowEditor'

const api = window.deepcode

function uid(): string {
  return 'wf_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

export function WorkflowsPanel(): JSX.Element {
  const [list, setList] = useState<WorkflowDef[]>([])
  const [editing, setEditing] = useState<WorkflowDef | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genText, setGenText] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState('')

  // generation is a multi-second (possibly two-call) LLM round-trip; the panel can unmount
  // (App-level view switch) before it settles — guard the post-await setState against that.
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  function refresh(): void {
    api.listWorkflows().then(setList)
  }
  useEffect(() => {
    refresh()
  }, [])

  async function create(): Promise<void> {
    const id = uid()
    const triggerId = 'n_trigger'
    const def: WorkflowDef = {
      id,
      name: 'Neuer Workflow',
      nodes: [{ id: triggerId, type: 'trigger', label: 'Start', config: {}, x: 250, y: 60 }],
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
      setGenOpen(false)
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
        onBack={() => {
          setEditing(null)
          refresh()
        }}
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
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={create}>+ Neuer Workflow</button>
          <select
            className="btn ghost"
            value=""
            onChange={(e) => {
              createFromTemplate(e.target.value)
              e.target.value = '' // reset so the same template can be picked again
            }}
            title="Einen sofort lauffähigen Starter-Workflow anlegen"
          >
            <option value="">📋 Aus Vorlage…</option>
            {WORKFLOW_TEMPLATES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} · {t.category}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => { setGenOpen((v) => !v); setGenError('') }}>✨ Aus Beschreibung</button>
          <button className="btn ghost" onClick={doImport}>⬆ Importieren</button>
        </div>
        {genOpen && (
          <div className="card" style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong>✨ Workflow aus Beschreibung erzeugen</strong>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
              Beschreibe in einem Satz, was der Workflow tun soll — DeepSeek baut ihn, prüft ihn und öffnet ihn zum Anpassen.
            </p>
            <textarea
              value={genText}
              onChange={(e) => setGenText(e.target.value)}
              placeholder="z. B. „Hole eine URL, fasse den Inhalt zusammen und schicke mir eine Benachrichtigung."
              rows={3}
              disabled={genBusy}
              autoFocus
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate()
              }}
            />
            {genError && <div role="alert" style={{ color: 'var(--danger, #e5484d)', fontSize: 12 }}>{genError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={generate} disabled={genBusy || !genText.trim()}>
                {genBusy ? 'Erzeuge…' : 'Erzeugen'}
              </button>
              <button className="btn ghost" onClick={() => setGenOpen(false)} disabled={genBusy}>Abbrechen</button>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', alignSelf: 'center' }}>Strg/⌘+Enter</span>
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <p style={{ color: 'var(--text-faint)' }}>Noch keine Workflows — lege den ersten an.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map((w) => (
              <div key={w.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => open(w.id)}>
                  <strong>{w.name}</strong>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                    {w.nodes.length} Knoten · {w.edges.length} Verbindungen
                  </div>
                </div>
                <button className="btn ghost sm" onClick={() => open(w.id)}>Öffnen</button>
                <button className="btn ghost sm" onClick={() => rename(w)}>Umbenennen</button>
                <button className="btn ghost sm" onClick={() => api.exportWorkflow(w.id).catch((e) => window.alert(String(e)))}>Export</button>
                <button className="btn ghost sm" onClick={() => remove(w.id, w.name)}>Löschen</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
