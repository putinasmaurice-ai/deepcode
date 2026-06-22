import { useEffect, useRef, useState } from 'react'
import type { AgentEvent, Trace, TraceSpan } from '../../../shared/types'

// idle seconds after which a *model* (llm) producing nothing is flagged as possibly hung. Long
// tools (tests/builds) legitimately emit nothing while they run, so they are NOT flagged — their
// live elapsed time is shown instead.
const STALL_AFTER = 25

const KIND: Record<TraceSpan['kind'], { icon: string; label: string }> = {
  round: { icon: '🔄', label: 'Runde' },
  llm: { icon: '🧠', label: 'Modell' },
  tool: { icon: '🔧', label: 'Tool' },
  subagent: { icon: '🤖', label: 'Subagent' },
  verify: { icon: '✅', label: 'Verify' },
  compact: { icon: '🗜️', label: 'Kompaktierung' }
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function spanText(s: TraceSpan): string {
  const base = `${KIND[s.kind]?.icon ?? '•'} ${s.name}`
  return s.detail ? `${base} · ${s.detail}` : base
}

function stepStatus(s: TraceSpan, now: number): string {
  if (s.status === 'running') return fmtDur(now - s.startedAt) + ' …'
  if (s.status === 'error') return '✗'
  if (s.status === 'cancelled') return 'abgebrochen'
  return fmtDur((s.endedAt ?? s.startedAt) - s.startedAt)
}

// Claude-Code / Codex-style live activity: a per-step feed driven by the engine's `trace` stream
// (each LLM/tool/verify span) PLUS a "time since last event" heartbeat. The heartbeat is the key
// signal — while the model streams, it stays near 0; if everything goes silent it climbs and the
// indicator flips to a stall warning, so "working" and "hung" finally look different.
export function LiveActivity({ sessionId, status }: { sessionId: string; status: string }): JSX.Element {
  const lastEventAt = useRef(Date.now())
  const startedAt = useRef(Date.now())
  const [trace, setTrace] = useState<Trace | null>(null)
  const [, setTick] = useState(0) // forces a re-render so live timers advance

  // fresh heartbeat + cleared feed whenever this becomes the active working turn
  useEffect(() => {
    lastEventAt.current = Date.now()
    startedAt.current = Date.now()
    setTrace(null)
  }, [sessionId])

  useEffect(() => {
    const off = window.deepcode.onAgentEvent((e: AgentEvent) => {
      const sid = 'sessionId' in e ? (e as { sessionId?: string }).sessionId : undefined
      // only events for THIS chat reset the heartbeat (session-less UI events must not mask a stall)
      if (sid && sid !== sessionId) return
      lastEventAt.current = Date.now()
      if (e.type === 'trace' && e.trace.sessionId === sessionId) setTrace(e.trace)
    })
    return off
  }, [sessionId])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])

  const now = Date.now()
  const idle = Math.floor((now - lastEventAt.current) / 1000)
  const total = Math.floor((now - startedAt.current) / 1000)

  const spans = trace?.spans ?? []
  const running = [...spans].reverse().find((s) => s.status === 'running')
  // a silent MODEL (or nothing running yet) is a real hang signal; a long tool/verify is expected
  // to be quiet while it runs, so don't cry wolf on those.
  const stalled = idle >= STALL_AFTER && (!running || running.kind === 'llm')

  const steps = spans.filter((s) => s.kind !== 'round').slice(-8)

  const headText = stalled
    ? `⚠ Seit ${idle}s keine Aktivität — das Modell hängt evtl. Stop drücken oder Modell wechseln.`
    : running
      ? spanText(running)
      : status || 'DeepCode arbeitet…'

  return (
    <div className={'working' + (stalled ? ' stalled' : '')}>
      <div className="working-head">
        <span className="working-dots">
          <i></i>
          <i></i>
          <i></i>
        </span>
        <span className="working-text">{headText}</span>
        <span className="working-secs" title="Gesamtdauer dieses Turns">
          {total}s
        </span>
      </div>
      {steps.length > 0 && (
        <ol className="step-feed">
          {steps.map((s) => (
            <li key={s.id} className={'step step-' + s.status} title={s.error || s.detail || s.name}>
              <span className="step-name">{spanText(s)}</span>
              <span className="step-dur">{stepStatus(s, now)}</span>
            </li>
          ))}
        </ol>
      )}
      {/* keep the engine's own status note visible (retry/verify/compact) when a span is also shown */}
      {!stalled && running && status && status !== headText && <div className="step-note">{status}</div>}
    </div>
  )
}
