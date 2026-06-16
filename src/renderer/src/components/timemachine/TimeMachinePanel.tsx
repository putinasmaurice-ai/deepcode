import { useEffect, useMemo, useState } from 'react'
import type { Session, TimelineTick, TickDetail, TimeMachineFork, ForkResult } from '../../../../shared/types'
import { Timeline } from './Timeline'
import { TickInspector } from './TickInspector'

const api = window.deepcode

// Short, localized date for the session picker label.
function shortDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
  } catch {
    return ''
  }
}

// Zeitmaschine (Flaggschiff #4): fügt die drei persistierten, pro-Turn millisekunden-gestempelten
// Speicher (Trace-Reasoning, FS-Checkpoints, Chat-Verlauf) zu EINER scrubbaren Zeitachse zusammen
// und zweigt jeden Punkt in einen lokalen Branch ab. Dieser Container orchestriert nur — die
// Zeitachsen-Schiene (Timeline) und der Detail-Inspektor (TickInspector) sind Geschwister-Komponenten.
export function TimeMachinePanel(): JSX.Element {
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [ticks, setTicks] = useState<TimelineTick[]>([])
  const [loadingTicks, setLoadingTicks] = useState(false)
  const [selectedTick, setSelectedTick] = useState<number | null>(null)
  const [detail, setDetail] = useState<TickDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [forks, setForks] = useState<TimeMachineFork[]>([])
  const [forking, setForking] = useState(false)
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)

  // Load the session list once (newest first); auto-pick the newest so the panel is never empty-by-default.
  useEffect(() => {
    api.listSessions().then((list) => {
      const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
      setSessions(sorted)
      setSessionId((cur) => cur || sorted[0]?.id || '')
    })
  }, [])

  const refreshForks = (sid: string): void => {
    api.timeMachineForks(sid).then(setForks)
  }

  // When the session changes: rebuild its timeline and auto-select the NEWEST (last) tick.
  useEffect(() => {
    if (!sessionId) {
      setTicks([])
      setSelectedTick(null)
      setForks([])
      return
    }
    setLoadingTicks(true)
    setDetail(null)
    setToast(null)
    api.timeMachineTimeline(sessionId).then((t) => {
      setTicks(t)
      setSelectedTick(t.length ? t[t.length - 1].tick : null)
      setLoadingTicks(false)
    })
    refreshForks(sessionId)
  }, [sessionId])

  // When the selected tick changes: load its fused detail (spinner while loading) + refresh forks.
  useEffect(() => {
    if (!sessionId || selectedTick == null) {
      setDetail(null)
      return
    }
    setLoadingDetail(true)
    setDetail(null)
    api.timeMachineTick(sessionId, selectedTick).then((d) => {
      setDetail(d)
      setLoadingDetail(false)
    })
    refreshForks(sessionId)
  }, [sessionId, selectedTick])

  const selected = useMemo(
    () => (selectedTick == null ? null : ticks.find((t) => t.tick === selectedTick) ?? null),
    [ticks, selectedTick]
  )

  const onFork = async (): Promise<void> => {
    if (!sessionId || selectedTick == null) return
    setForking(true)
    setToast(null)
    try {
      const r: ForkResult = await api.timeMachineFork(sessionId, selectedTick)
      const hint = r.ok && r.branch ? ` — git checkout ${r.branch}` : ''
      setToast({ ok: r.ok, text: r.message + hint })
      refreshForks(sessionId)
    } catch (e) {
      setToast({ ok: false, text: 'Abzweigen fehlgeschlagen: ' + String(e) })
    } finally {
      setForking(false)
    }
  }

  const onDeleteFork = async (branch: string): Promise<void> => {
    if (!sessionId) return
    const r = await api.timeMachineDeleteFork(sessionId, branch)
    setToast({ ok: r.ok, text: r.ok ? `Branch ${branch} gelöscht.` : r.output || 'Löschen fehlgeschlagen.' })
    refreshForks(sessionId)
  }

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>⏳ Zeitmaschine</h1>
        <p className="sub">
          Scrubbe durch jeden Turn — Reasoning, geänderte Dateien und Kosten werden zusammen
          rekonstruiert; zweige jeden Punkt in einen lokalen Branch ab.
        </p>

        {sessions === null ? (
          <div className="spinner" />
        ) : sessions.length === 0 ? (
          <p className="empty">Noch keine Chats — starte einen Chat, um Verlaufspunkte zu erzeugen.</p>
        ) : (
          <>
            <div className="field tm-picker">
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} · {shortDate(s.updatedAt)}
                  </option>
                ))}
              </select>
            </div>

            {toast && (
              <div className={'tm-toast' + (toast.ok ? '' : ' err')} onClick={() => setToast(null)}>
                {toast.ok ? '✅ ' : '⚠️ '}
                {toast.text}
              </div>
            )}

            {loadingTicks ? (
              <div className="spinner" />
            ) : ticks.length === 0 ? (
              <p className="empty">Noch keine Verlaufspunkte — führe ein paar Chat-Turns aus.</p>
            ) : (
              <>
                <Timeline ticks={ticks} selected={selectedTick} onSelect={setSelectedTick} />
                <div className="tm-body">
                  {selected ? (
                    <TickInspector
                      sessionId={sessionId}
                      tick={selected}
                      detail={loadingDetail ? null : detail}
                      forks={forks}
                      forking={forking}
                      onFork={onFork}
                      onDeleteFork={onDeleteFork}
                    />
                  ) : (
                    <p className="empty">Wähle oben einen Punkt auf der Zeitachse.</p>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
