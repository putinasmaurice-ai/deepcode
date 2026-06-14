import { useEffect, useState } from 'react'
import type { SwarmBranch, AgentEvent } from '../../../shared/types'

const api = window.deepcode

// Merge-gate for swarm mode: review each swarm/* branch a swarm run produced, see its diff, and
// merge it into the current branch (conflicts are aborted safely) or discard it.
export function SwarmPanel(): JSX.Element {
  const [branches, setBranches] = useState<SwarmBranch[] | null>(null)
  const [diff, setDiff] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  // The swarm IPC resolves its cwd to settings.defaultCwd (homedir fallback), NOT the active
  // project — show that directory so the user knows where merge/discard actually run.
  const [cwd, setCwd] = useState('')

  const load = (): void => {
    api.swarmBranches().then(setBranches)
  }
  useEffect(() => {
    load()
    api.getSettings().then((s: { defaultCwd?: string }) => setCwd(s?.defaultCwd ?? ''))
    // refresh when a swarm run finishes while the panel is open
    const off = api.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'swarm_run' && e.status === 'done') load()
    })
    return off
  }, [])

  const toggleDiff = async (b: string): Promise<void> => {
    if (diff[b] !== undefined) {
      setDiff((d) => {
        const n = { ...d }
        delete n[b]
        return n
      })
      return
    }
    setDiff((d) => ({ ...d, [b]: '… lädt' }))
    const text = await api.swarmDiff(b)
    setDiff((d) => ({ ...d, [b]: text }))
  }

  const merge = async (b: string): Promise<void> => {
    if (!window.confirm(`„${b}" in den aktuellen Branch mergen?`)) return
    setBusy(b)
    setMsg('')
    const r = await api.swarmMerge(b)
    setBusy('')
    setMsg(r.output)
    if (r.ok) {
      // the branch survives a merge, but its diff vs HEAD is now stale (empty) — drop the cache
      setDiff((d) => {
        const n = { ...d }
        delete n[b]
        return n
      })
      load()
    }
  }
  const del = async (b: string): Promise<void> => {
    if (!window.confirm(`Branch „${b}" endgültig löschen (verwerfen)?`)) return
    setBusy(b)
    setMsg('')
    const r = await api.swarmDeleteBranch(b)
    setBusy('')
    setMsg(r.output)
    if (r.ok) load()
  }

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>🐝 Schwarm — Merge-Gate</h1>
        <p className="sub">
          Branches aus <code>/swarm</code>-Läufen prüfen und in den aktuellen Branch mergen (Konflikte werden sicher
          abgebrochen) oder verwerfen. Quelle sind die <code>swarm/*</code>-Branches im Arbeitsverzeichnis.
        </p>
        <p className="sub">
          Arbeitsverzeichnis: <code className="swarm-cwd">{cwd || '(noch nicht geladen)'}</code>
          <br />
          Hinweis: Schwarm-Branch-Aktionen (Liste, Diff, Merge, Löschen) laufen in diesem Verzeichnis —
          nicht zwingend im aktuell geöffneten Projekt.
        </p>
        <div className="field" style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost sm" onClick={load}>⟳ Aktualisieren</button>
        </div>
        {msg && <pre className="swarm-msg">{msg}</pre>}
        {!branches && <div className="spinner" />}
        {branches && branches.length === 0 && (
          <div className="empty">Keine <code>swarm/*</code>-Branches. Starte einen Lauf mit <code>/swarm &lt;Aufgabe&gt;</code> im Chat.</div>
        )}
        {branches?.map((b) => (
          <div key={b.branch} className="swarm-card">
            <div className="swarm-head">
              <code className="swarm-branch">{b.branch}</code>
              <span className="swarm-actions">
                <button className="btn ghost sm" onClick={() => toggleDiff(b.branch)} disabled={!!busy}>
                  {diff[b.branch] !== undefined ? 'Diff ausblenden' : 'Diff'}
                </button>
                <button className="btn sm" onClick={() => merge(b.branch)} disabled={!!busy}>
                  {busy === b.branch ? '…' : 'Merge'}
                </button>
                <button className="btn ghost sm" onClick={() => del(b.branch)} disabled={!!busy}>Löschen</button>
              </span>
            </div>
            {b.subject && <div className="swarm-subject">{b.subject}</div>}
            {b.stat && <pre className="swarm-stat">{b.stat}</pre>}
            {diff[b.branch] !== undefined && <pre className="swarm-diff">{diff[b.branch]}</pre>}
          </div>
        ))}
      </div>
    </div>
  )
}
