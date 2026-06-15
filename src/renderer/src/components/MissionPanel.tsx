import { useEffect, useRef, useState } from 'react'
import type { AgentEvent, AppSettings } from '../../../shared/types'

// Locked contract shapes (see shared/types.ts). Mirrored here so the panel compiles
// independently of the parallel main-process build; the runtime objects come over IPC.
export interface MissionTask {
  id: string
  title: string
  instruction: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  commit?: string
  summary?: string
  tokens?: number
  cost?: number
}
export interface Mission {
  id: string
  goal: string
  cwd: string
  projectId?: string
  verifyCommand: string
  branch?: string
  status: 'planning' | 'ready' | 'running' | 'done' | 'failed' | 'stopped'
  tasks: MissionTask[]
  waitForOffPeak?: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  reportPath?: string
}

// Mission IPC surface (added to DeepCodeApi by the ipc/preload agent). Typed locally so this
// panel does not depend on that file landing first.
interface MissionApi {
  listMissions(): Promise<Mission[]>
  getMission(id: string): Promise<Mission | null>
  saveMission(m: Mission): Promise<Mission>
  deleteMission(id: string): Promise<boolean>
  generatePlan(goal: string): Promise<MissionTask[]>
  startMission(id: string): Promise<Mission>
  stopMission(id: string): Promise<boolean>
  getSettings(): Promise<AppSettings>
  getCwdInfo(cwd: string): Promise<{ gitBranch?: string | null; gitDirty?: number }>
  nightOpenReport(path: string): Promise<boolean>
  onAgentEvent(cb: (e: AgentEvent) => void): () => void
}
const api = window.deepcode as unknown as MissionApi

const TASK_ICON: Record<MissionTask['status'], string> = {
  pending: '⏳',
  running: '◐',
  done: '✅',
  failed: '❌'
}

// The overseer emits per-task events with names like 'task_running'/'task_done'/'task_retry' that
// are NOT MissionTask['status'] values. Map them to real statuses before storing, or the icon,
// status CSS class, and the done-counter/progress bar all break mid-run until getMission reloads.
const TASK_EVENT_STATUS: Record<string, MissionTask['status']> = {
  task_running: 'running',
  task_done: 'done',
  task_retry: 'running'
}

function emptyMission(cwd: string): Mission {
  const now = Date.now()
  return {
    id: 'm-' + now,
    goal: '',
    cwd,
    verifyCommand: 'npm test',
    status: 'planning',
    tasks: [],
    waitForOffPeak: false,
    createdAt: now,
    updatedAt: now
  }
}

export function MissionPanel(): JSX.Element {
  const [missions, setMissions] = useState<Mission[]>([])
  const [draft, setDraft] = useState<Mission | null>(null)
  const [planning, setPlanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [gitDirty, setGitDirty] = useState(0)
  const draftIdRef = useRef<string | null>(null)
  draftIdRef.current = draft?.id ?? null

  async function refresh(): Promise<void> {
    setMissions(await api.listMissions())
  }
  useEffect(() => {
    refresh()
    api.getSettings().then((s) => setDraft((d) => d ?? emptyMission(s.defaultCwd || '')))
  }, [])

  // warn when the target working tree has uncommitted changes (mission commits land on a branch)
  useEffect(() => {
    if (!draft?.cwd) return setGitDirty(0)
    api.getCwdInfo(draft.cwd).then((i) => setGitDirty(i?.gitDirty ?? 0))
  }, [draft?.cwd])

  // LIVE: mission events are session-less — fold status/commit updates into the open draft.
  useEffect(() => {
    const off = api.onAgentEvent((raw: AgentEvent) => {
      const ev = raw as unknown as { type: string; missionId: string; taskId?: string; status: string; message?: string }
      if (ev.type !== 'mission') return
      setDraft((d) => {
        if (!d || d.id !== ev.missionId) return d
        if (!ev.taskId) {
          if (['running', 'done', 'failed', 'stopped'].includes(ev.status)) {
            const next = { ...d, status: ev.status as Mission['status'] }
            if (ev.status !== 'running') api.getMission(d.id).then((m) => m && setDraft(m))
            return next
          }
          return d
        }
        return {
          ...d,
          tasks: d.tasks.map((t) =>
            t.id === ev.taskId
              ? { ...t, status: TASK_EVENT_STATUS[ev.status] ?? t.status, summary: ev.message ?? t.summary }
              : t
          )
        }
      })
    })
    return off
  }, [])

  function patchDraft(p: Partial<Mission>): void {
    setDraft((d) => (d ? { ...d, ...p } : d))
  }

  async function plan(): Promise<void> {
    if (!draft?.goal.trim()) return
    setPlanning(true)
    setError('')
    try {
      const tasks = await api.generatePlan(draft.goal.trim())
      patchDraft({ tasks, status: 'ready' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPlanning(false)
    }
  }

  async function save(): Promise<Mission | null> {
    if (!draft) return null
    try {
      const saved = await api.saveMission({ ...draft, updatedAt: Date.now() })
      setDraft(saved)
      await refresh()
      return saved
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }

  async function start(): Promise<void> {
    const saved = await save()
    if (!saved) return
    setBusy(true)
    setError('')
    try {
      await api.startMission(saved.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function stop(): Promise<void> {
    if (draft) await api.stopMission(draft.id)
  }

  async function open(id: string): Promise<void> {
    const m = await api.getMission(id)
    if (m) {
      setDraft(m)
      setError('')
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm('Mission wirklich löschen?')) return
    await api.deleteMission(id)
    if (draftIdRef.current === id) api.getSettings().then((s) => setDraft(emptyMission(s.defaultCwd || '')))
    await refresh()
  }

  if (!draft) return <div className="spinner" />

  const running = draft.status === 'running' || busy
  const done = draft.tasks.filter((t) => t.status === 'done').length
  const failed = draft.tasks.some((t) => t.status === 'failed')

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>🎯 Mission Control</h1>
        <p className="sub">
          Setze ein Ziel, geh schlafen, wach zu verifizierter, committeter Arbeit auf. Der Overseer
          arbeitet die Aufgaben nacheinander ab — <b>jede gilt erst als erledigt, wenn der
          Verify-Befehl grün ist</b> (nicht wenn die KI das behauptet).
        </p>

        <div className="card">
          <h3>Neue Mission</h3>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Ziel (was am Ende fertig sein soll)</label>
            <textarea
              value={draft.goal}
              onChange={(e) => patchDraft({ goal: e.target.value, status: 'planning' })}
              placeholder="z.B. Migriere die Auth-Schicht auf JWT und decke sie mit Tests ab."
            />
          </div>
          <div className="row">
            <div className="field">
              <label>Arbeitsordner</label>
              <input value={draft.cwd} onChange={(e) => patchDraft({ cwd: e.target.value })} />
              {gitDirty > 0 && (
                <div className="mission-warn">⚠ {gitDirty} unkommittierte Änderung(en) — committe oder stashe sie zuerst.</div>
              )}
            </div>
            <div className="field">
              <label>Verify-Befehl (die maschinelle Abnahme)</label>
              <input
                value={draft.verifyCommand}
                onChange={(e) => patchDraft({ verifyCommand: e.target.value })}
                placeholder="npm test"
              />
              {draft.verifyCommand.trim() ? (
                <div className="mission-hint">Muss grün sein, sonst gilt die Aufgabe als fehlgeschlagen.</div>
              ) : (
                <div className="mission-warn">⚠ Pflichtfeld — ohne maschinelle Abnahme startet keine Mission.</div>
              )}
            </div>
          </div>
          <label className="toggle">
            <span
              className={'switch' + (draft.waitForOffPeak ? ' on' : '')}
              role="switch"
              aria-checked={draft.waitForOffPeak}
              tabIndex={0}
              onClick={() => patchDraft({ waitForOffPeak: !draft.waitForOffPeak })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  patchDraft({ waitForOffPeak: !draft.waitForOffPeak })
                }
              }}
            />
            💰 Erst im Off-Peak-Fenster starten (bis −75% günstiger)
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={plan} disabled={!draft.goal.trim() || planning || running}>
              {planning ? 'Plane…' : '🎯 Plan erzeugen'}
            </button>
            {draft.tasks.length > 0 && !running && (
              <button className="btn ghost" onClick={save}>
                Speichern
              </button>
            )}
            {running ? (
              <button className="btn danger" onClick={stop}>
                ⏹ Stop
              </button>
            ) : (
              <button className="btn" onClick={start} disabled={draft.tasks.length === 0 || !draft.verifyCommand.trim()}>
                ▶ Mission starten
              </button>
            )}
          </div>
          {error && <div className="banner" style={{ marginTop: 12 }}>{error}</div>}
        </div>

        {draft.tasks.length > 0 && (
          <div className="card">
            <div className="flex-between">
              <h3>
                Aufgabenliste ({done}/{draft.tasks.length} erledigt)
                {running ? ' · läuft…' : failed ? ' · gestoppt (Fehler)' : ''}
              </h3>
              {draft.branch && <span className="pill">⎇ {draft.branch}</span>}
            </div>
            <div className="mission-progress">
              <div
                className={'mission-progress-fill' + (failed ? ' failed' : '')}
                style={{ width: `${draft.tasks.length ? (done / draft.tasks.length) * 100 : 0}%` }}
              />
            </div>
            {draft.tasks.map((t, i) => (
              <div key={t.id} className="mission-task">
                <span className={'mission-status status-' + t.status}>{TASK_ICON[t.status]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {running || draft.status === 'done' ? (
                    <div className="mission-task-title">{i + 1}. {t.title}</div>
                  ) : (
                    <input
                      className="mission-task-edit"
                      value={t.title}
                      onChange={(e) =>
                        patchDraft({ tasks: draft.tasks.map((x) => (x.id === t.id ? { ...x, title: e.target.value } : x)) })
                      }
                    />
                  )}
                  {running || draft.status === 'done' ? (
                    <div className="meta mission-instr">{t.instruction}</div>
                  ) : (
                    <textarea
                      className="mission-task-edit instr"
                      value={t.instruction}
                      onChange={(e) =>
                        patchDraft({
                          tasks: draft.tasks.map((x) => (x.id === t.id ? { ...x, instruction: e.target.value } : x))
                        })
                      }
                    />
                  )}
                  {t.summary && <div className="meta">{t.summary.slice(0, 200)}</div>}
                  {(t.commit || t.attempts > 0) && (
                    <div className="meta">
                      {t.commit ? `commit ${t.commit}` : ''}
                      {t.attempts > 1 ? ` · ${t.attempts} Versuche` : ''}
                      {t.tokens ? ` · ${t.tokens.toLocaleString()} tok` : ''}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {failed && (
              <div className="banner" style={{ marginTop: 10 }}>
                Mission gestoppt: eine Aufgabe blieb nach erneutem Versuch rot. Es wird nicht auf einer
                kaputten Basis weitergebaut — prüfe den Verify-Befehl und die letzte Aufgabe.
              </div>
            )}
            {draft.reportPath && (
              <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => api.nightOpenReport(draft.reportPath!)}>
                📄 Bericht öffnen
              </button>
            )}
          </div>
        )}

        <div className="card">
          <h3>Gespeicherte Missionen</h3>
          {missions.length === 0 ? (
            <div className="empty">Noch keine Missionen. Setze oben ein Ziel und erzeuge einen Plan.</div>
          ) : (
            missions.map((m) => (
              <div key={m.id} className="mission-row">
                <span className={'mission-dot status-' + m.status} />
                <div style={{ flex: 1, minWidth: 0 }} role="button" tabIndex={0} onClick={() => open(m.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open(m.id)}>
                  <div className="mission-row-goal">{m.goal.slice(0, 80) || '(ohne Ziel)'}</div>
                  <div className="meta">
                    {m.status} · {m.tasks.filter((t) => t.status === 'done').length}/{m.tasks.length} · {m.verifyCommand}
                  </div>
                </div>
                <span className="chip-x" onClick={() => remove(m.id)}>✕</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
