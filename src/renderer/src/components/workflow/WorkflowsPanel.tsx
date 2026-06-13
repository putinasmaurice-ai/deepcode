import { useEffect, useState } from 'react'
import type { WorkflowDef } from '../../../../shared/types'
import { WorkflowEditor } from './WorkflowEditor'

const api = window.deepcode

function uid(): string {
  return 'wf_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

export function WorkflowsPanel(): JSX.Element {
  const [list, setList] = useState<WorkflowDef[]>([])
  const [editing, setEditing] = useState<WorkflowDef | null>(null)

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
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button className="btn" onClick={create}>+ Neuer Workflow</button>
          <button className="btn ghost" onClick={doImport}>⬆ Importieren</button>
        </div>
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
