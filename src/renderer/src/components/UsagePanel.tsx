import { useEffect, useState } from 'react'
import type { UsageSummary } from '../../../shared/types'

const api = window.deepcode

const fmtCost = (c: number): string => '$' + c.toFixed(4)
const fmtTok = (t: number): string => t.toLocaleString()

export function UsagePanel(): JSX.Element {
  const [usage, setUsage] = useState<UsageSummary | null>(null)

  useEffect(() => {
    api.usageSummary().then(setUsage)
  }, [])

  if (!usage) return <div className="spinner" />

  const maxProjCost = Math.max(0.000001, ...usage.perProject.map((p) => p.cost))

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>Kosten & Verbrauch</h1>
        <p className="sub">Token-Verbrauch und geschätzte Kosten — pro Chat, pro Projekt und gesamt.</p>

        <div className="stat-row">
          <div className="stat">
            <div className="stat-value">{fmtCost(usage.total.cost)}</div>
            <div className="stat-label">Gesamtkosten</div>
          </div>
          <div className="stat">
            <div className="stat-value">{fmtTok(usage.total.tokens)}</div>
            <div className="stat-label">Tokens gesamt</div>
          </div>
          <div className="stat">
            <div className="stat-value">{usage.total.sessions}</div>
            <div className="stat-label">Chats</div>
          </div>
        </div>

        <div className="card">
          <h3>Pro Projekt</h3>
          {usage.perProject.length === 0 && <p>Noch keine Daten.</p>}
          {usage.perProject.map((p) => (
            <div key={p.projectId || 'none'} className="usage-row">
              <div className="usage-head">
                <span>{p.name}</span>
                <span className="meta">
                  {fmtTok(p.tokens)} Tokens · {fmtCost(p.cost)} · {p.sessions} Chats
                </span>
              </div>
              <div className="usage-bar">
                <div className="usage-fill" style={{ width: `${Math.max(2, (p.cost / maxProjCost) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>Pro Chat</h3>
          {usage.perSession.filter((s) => s.tokens > 0).length === 0 && (
            <p>Noch keine Chats mit Verbrauch. (Tipp: in jedem Chat zeigt die Topbar den Live-Verbrauch.)</p>
          )}
          {usage.perSession
            .filter((s) => s.tokens > 0)
            .slice(0, 25)
            .map((s) => (
              <div key={s.id} className="usage-row">
                <div className="usage-head">
                  <span>{s.title}</span>
                  <span className="meta">
                    {fmtTok(s.tokens)} Tokens · {fmtCost(s.cost)}
                  </span>
                </div>
              </div>
            ))}
        </div>

        <p className="sub" style={{ marginTop: 14 }}>
          Preise konfigurierbar in den Settings (aktuell pro 1M Tokens). Auch im Chat abrufbar via <code style={{ fontFamily: 'var(--mono)' }}>/cost</code>.
        </p>
      </div>
    </div>
  )
}
