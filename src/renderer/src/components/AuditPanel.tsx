import { useEffect, useState } from 'react'

const api = window.deepcode

interface AuditEntry {
  time: string
  kind: string
  detail: string
}

const KIND_ICON: Record<string, string> = {
  run_command: '💻',
  background_job: '⏳',
  hook: '🪝'
}

export function AuditPanel(): JSX.Element {
  const [items, setItems] = useState<AuditEntry[] | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    api.listAudit().then(setItems)
  }, [])

  if (!items) return <div className="spinner" />

  const shown = items.filter(
    (e) =>
      !filter ||
      e.detail.toLowerCase().includes(filter.toLowerCase()) ||
      e.kind.toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <div className="panel">
      <div className="panel-inner">
        <div className="flex-between">
          <h1>Audit-Log</h1>
          <button className="btn ghost sm" onClick={() => api.listAudit().then(setItems)}>
            ↻ Aktualisieren
          </button>
        </div>
        <p className="sub">
          Jeder ausgeführte Shell-Befehl, Hintergrund-Job und Hook wird hier protokolliert
          (~/.deepcode/audit.log).
        </p>
        <div className="field">
          <input
            placeholder="Filtern…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {shown.length === 0 && <div className="empty">Keine Einträge{filter ? ' für diesen Filter' : ''}.</div>}
        {shown.slice(0, 200).map((e, i) => (
          <div key={i} className="audit-row">
            <span className="audit-time">{e.time.replace('T', ' ').slice(0, 19)}</span>
            <span className="audit-kind">
              {KIND_ICON[e.kind] ?? '•'} {e.kind}
            </span>
            <span className="audit-detail">{e.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
