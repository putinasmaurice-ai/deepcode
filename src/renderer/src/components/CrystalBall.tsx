import { useEffect, useState } from 'react'
import type { TurnForecast } from '../../../shared/api'
import { offPeakStatus, offPeakEligible } from '../../../shared/offpeak'

const api = window.deepcode

function fmtUsd(n: number): string {
  return '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(3))
}
function fmtDur(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`
}
function fmtCountdown(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// 🔮 Cost & Time Crystal Ball: forecasts the next turn's cost/time from the user's own
// history and nudges toward the DeepSeek off-peak discount window. Sits above the composer.
export function CrystalBall({
  sessionId,
  model,
  busy,
  deferOffPeak,
  onToggleDefer
}: {
  sessionId: string | null
  model?: string // active model id — off-peak only shows for the first-party DeepSeek route
  busy: boolean
  deferOffPeak: boolean
  onToggleDefer: () => void
}): JSX.Element | null {
  const [f, setF] = useState<TurnForecast | null>(null)
  const [now, setNow] = useState(() => new Date())

  // refresh the forecast when idle / session changes (after a turn the average updates)
  useEffect(() => {
    if (!sessionId || busy) return
    let alive = true
    api.forecastTurn(sessionId).then((r) => alive && setF(r))
    return () => {
      alive = false
    }
  }, [sessionId, busy])

  // tick the off-peak countdown every 30s
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  if (!sessionId || !f) return null
  const op = offPeakStatus(now)
  const hasHistory = f.sampleCount > 0
  const ctxK = f.contextTokens >= 1000 ? `${Math.round(f.contextTokens / 1000)}k` : `${f.contextTokens}`

  return (
    <div className="crystal">
      <span className="crystal-ico">🔮</span>
      <span className="crystal-seg" title="Aktuelle Kontextgröße und geschätzte Input-Kosten dieses Turns">
        {ctxK} tok{!f.isLocal && f.estInputCost > 0 ? ` · ≈ ${fmtUsd(f.estInputCost)} Input` : ''}
      </span>
      {hasHistory && (
        <span className="crystal-seg" title={`Schnitt aus deinen letzten ${f.sampleCount} Turns`}>
          Ø {f.isLocal ? '$0' : fmtUsd(f.avgCost)}/Turn · {fmtDur(f.avgDurationMs)}
        </span>
      )}
      <span className="crystal-spacer" />
      {/* off-peak is a DeepSeek first-party perk — only show it when the active model actually qualifies */}
      {offPeakEligible(model) &&
        (op.active ? (
          <span className="crystal-offpeak on" title="DeepSeek Off-Peak-Rabatt ist gerade aktiv">
            🌙 Off-Peak −{Math.round(op.reasonerDiscount * 100)}% aktiv · noch {fmtCountdown(op.minutesUntilChange)}
          </span>
        ) : (
          <>
            <span className="crystal-offpeak" title="DeepSeek senkt die Preise im Off-Peak-Fenster (UTC 16:30–00:30)">
              🌙 −{Math.round(op.reasonerDiscount * 100)}% in {fmtCountdown(op.minutesUntilChange)}
            </span>
            <button
              className={'btn ghost sm' + (deferOffPeak ? ' on' : '')}
              onClick={onToggleDefer}
              title="Die nächste Nachricht erst senden, wenn das günstige Off-Peak-Fenster offen ist (App muss offen bleiben)"
            >
              ⏳ im Off-Peak
            </button>
          </>
        ))}
    </div>
  )
}
