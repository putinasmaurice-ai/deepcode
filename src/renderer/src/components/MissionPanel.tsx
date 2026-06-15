import { useEffect, useRef, useState } from 'react'
import type { AgentEvent, AppSettings } from '../../../shared/types'
import { MissionGraph } from './MissionGraph'

// Locked contract shapes (see shared/types.ts). Mirrored here so the panel compiles
// independently of the parallel main-process build; the runtime objects come over IPC.
export interface MissionTask {
  id: string
  title: string
  instruction: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  // v2: branching plan tree (DAG) — ids of prerequisite tasks that must be 'done' first.
  deps?: string[]
  // v2: per-milestone branch pointer recorded at the verified commit (mission/<id>/m<n>-<slug>).
  branch?: string
  // v2: 'remediation' tasks are inserted live by the overseer's replan loop — marked visually.
  kind?: 'task' | 'remediation'
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
  status: 'planning' | 'ready' | 'running' | 'done' | 'failed' | 'stopped' | 'scheduled'
  tasks: MissionTask[]
  waitForOffPeak?: boolean
  // v2: replanning budget — how many times the overseer may insert remediation tasks before
  // halting loudly, and how many it has already used.
  maxReplans?: number
  replansUsed?: number
  // v2: overnight operator — a scheduled mission auto-starts in the off-peak window (mode
  // 'offpeak') or at a cron minute (mode 'cron'), honoring the same daily-cap + clean-tree guards.
  schedule?: { mode: 'offpeak' | 'cron'; cron?: string }
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
  // arm/disarm the overnight operator THROUGH the guarded main handler (verify-non-empty + cron-
  // non-empty checks + the authoritative status flip to 'scheduled'). Pass null to un-schedule.
  scheduleMission(id: string, schedule: Mission['schedule'] | null): Promise<Mission>
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

// Mission-level event statuses that mean the persisted plan may have CHANGED in a way the live
// fold can't reconstruct from the event alone — a replan inserts brand-new remediation tasks (with
// deps), the run finishes, etc. On any of these we re-fetch getMission so the graph + list +
// inserted tasks + report appear live. 'running' is excluded (it only flips the banner).
const REFETCH_STATUSES = new Set(['done', 'failed', 'stopped', 'scheduled', 'replanning', 'replanned', 'task_done'])

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
    maxReplans: 2,
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

  // LIVE: mission events are session-less — fold status/commit updates into the open draft, then
  // re-fetch getMission on the structure-changing statuses (replan inserts, finish) so the graph,
  // list and the freshly-inserted remediation tasks all appear live.
  useEffect(() => {
    const off = api.onAgentEvent((raw: AgentEvent) => {
      const ev = raw as unknown as { type: string; missionId: string; taskId?: string; status: string; message?: string }
      if (ev.type !== 'mission') return
      // PURE updater: fold the status/task change only — no IPC, no nested setDraft (an impure updater
      // double-fires under StrictMode and the nested replace can clobber edits).
      setDraft((d) => {
        if (!d || d.id !== ev.missionId) return d
        if (!ev.taskId) {
          if (['running', 'done', 'failed', 'stopped', 'scheduled'].includes(ev.status)) {
            return { ...d, status: ev.status as Mission['status'] }
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
      // Side effects OUTSIDE the updater. On structure-changing statuses (a replan inserted tasks
      // with deps, a task verified+committed, the run finished) pull the authoritative mission so the
      // DAG/graph + inserted remediation tasks appear live — guarded by the ref so a stale event for a
      // mission the user has since navigated away from can't replace the current draft. The list is
      // also refreshed (status/lastRun changed).
      if (REFETCH_STATUSES.has(ev.status)) {
        if (draftIdRef.current === ev.missionId) {
          api.getMission(ev.missionId).then((m) => {
            if (m && draftIdRef.current === m.id) setDraft(m)
          })
        }
        refresh()
      }
    })
    return off
  }, [])

  function patchDraft(p: Partial<Mission>): void {
    setDraft((d) => (d ? { ...d, ...p } : d))
  }

  // toggle the overnight schedule: none = run only when started manually; offpeak = auto-run in the
  // DeepSeek off-peak window; cron = auto-run at a cron minute. Routed THROUGH the guarded
  // scheduleMission handler (NOT the generic saveMission) so the main process enforces verify-non-
  // empty + cron-non-empty and owns the authoritative status flip to 'scheduled'. We reflect the
  // schedule selection in the draft immediately (responsive UI + the cron input appears); the
  // authoritative arming happens on save() / via armSchedule below.
  function setSchedule(mode: 'none' | 'offpeak' | 'cron'): void {
    if (mode === 'none') patchDraft({ schedule: undefined })
    else if (mode === 'offpeak') patchDraft({ schedule: { mode: 'offpeak' } })
    else patchDraft({ schedule: { mode: 'cron', cron: draft?.schedule?.cron || '0 2 * * *' } })
  }

  // Arm/disarm the schedule through the guarded handler and reflect the returned mission (whose
  // status the MAIN process sets — never the renderer). Surfaces the handler's validation errors
  // (empty verify, empty cron) so a "scheduled" mission can never silently fail to fire.
  async function armSchedule(saved: Mission): Promise<Mission | null> {
    try {
      const armed = await api.scheduleMission(saved.id, saved.schedule ?? null)
      setDraft(armed)
      await refresh()
      return armed
    } catch (err) {
      setError((err as Error).message)
      return null
    }
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

  // Persist the plan via the generic save, then reconcile the schedule THROUGH the guarded handler so
  // it (not the renderer) owns the status flip + validates verify/cron. `arm` is false for a manual
  // start (we just need the plan saved; arming would flip status to 'scheduled' and block the start).
  async function save(arm = true): Promise<Mission | null> {
    if (!draft) return null
    try {
      const saved = await api.saveMission({ ...draft, status: draft.status === 'scheduled' ? 'ready' : draft.status, updatedAt: Date.now() })
      setDraft(saved)
      await refresh()
      if (arm) return (await armSchedule(saved)) ?? saved
      return saved
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }

  async function start(): Promise<void> {
    // don't arm on a manual start — that would flip the mission to 'scheduled' instead of running it.
    const saved = await save(false)
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
  const editable = !running && draft.status !== 'done'
  const done = draft.tasks.filter((t) => t.status === 'done').length
  const failed = draft.tasks.some((t) => t.status === 'failed')
  const finished = draft.status === 'done' || draft.status === 'failed' || draft.status === 'stopped'
  const scheduleMode = draft.schedule?.mode ?? 'none'

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>🎯 Mission Control</h1>
        <p className="sub">
          Setze ein Ziel, geh schlafen, wach zu verifizierter, committeter Arbeit auf. Der Overseer
          arbeitet einen <b>Plan-Baum</b> ab — jede freie Aufgabe (alle Abhängigkeiten erledigt)
          wird als eigener Agent-Lauf ausgeführt und gilt <b>erst als erledigt, wenn der
          Verify-Befehl grün ist</b> (nicht wenn die KI das behauptet). Schlägt sie endgültig fehl,
          plant der Overseer im Rahmen seines Budgets nach — sonst hält er laut an.
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

          {/* v2: replan budget — how often the overseer may insert remediation tasks before halting */}
          <div className="field" style={{ maxWidth: 320 }}>
            <label>Nachplanungs-Budget (max. Reparatur-Runden)</label>
            <input
              type="number"
              min={0}
              max={5}
              value={draft.maxReplans ?? 2}
              disabled={!editable}
              onChange={(e) => patchDraft({ maxReplans: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })}
            />
            <div className="mission-hint">
              0 = bei endgültigem Fehlschlag sofort anhalten. Höher = der Overseer plant Reparatur-Aufgaben
              ein (mit Abhängigkeiten, ebenfalls verify-pflichtig), bevor er die Aufgabe erneut versucht.
              {typeof draft.replansUsed === 'number' && draft.replansUsed > 0 && (
                <> · bisher genutzt: {draft.replansUsed}</>
              )}
            </div>
          </div>

          {/* v2: overnight operator — unattended scheduled auto-start */}
          <div className="mission-schedule">
            <div className="mission-schedule-head">🌙 Übernacht-Operator (unbeaufsichtigt)</div>
            <div className="mission-schedule-modes">
              {(
                [
                  ['none', 'Nur manuell starten'],
                  ['offpeak', '💰 Off-Peak-Fenster'],
                  ['cron', '⏰ Cron-Zeitplan']
                ] as const
              ).map(([mode, label]) => (
                <label key={mode} className={'mission-schedule-opt' + (scheduleMode === mode ? ' on' : '')}>
                  <input
                    type="radio"
                    name="mission-schedule"
                    checked={scheduleMode === mode}
                    disabled={!editable}
                    onChange={() => setSchedule(mode)}
                  />
                  {label}
                </label>
              ))}
            </div>
            {scheduleMode === 'cron' && (
              <div className="field" style={{ maxWidth: 280, marginTop: 8 }}>
                <label>Cron (Min Std Tag Mon Wochentag) — z.B. 0 2 * * *</label>
                <input
                  value={draft.schedule?.cron ?? ''}
                  disabled={!editable}
                  onChange={(e) => patchDraft({ schedule: { mode: 'cron', cron: e.target.value } })}
                  placeholder="0 2 * * *"
                />
              </div>
            )}
            {scheduleMode !== 'none' && (
              <div className="mission-hint">
                Läuft <b>automatisch & unbeaufsichtigt</b> zur geplanten Zeit — die App muss dafür geöffnet
                bleiben. Es gelten dieselben Schutzregeln wie beim manuellen Start: sauberer Arbeitsbaum,
                Tagesbudget und genau eine Mission gleichzeitig. Speichern, damit der Zeitplan greift.
              </div>
            )}
          </div>

          {/* keep the v1 off-peak hold for manual starts (independent of the schedule above) */}
          <label className="toggle">
            <span
              className={'switch' + (draft.waitForOffPeak ? ' on' : '')}
              role="switch"
              aria-checked={draft.waitForOffPeak}
              tabIndex={0}
              onClick={() => editable && patchDraft({ waitForOffPeak: !draft.waitForOffPeak })}
              onKeyDown={(e) => {
                if (editable && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  patchDraft({ waitForOffPeak: !draft.waitForOffPeak })
                }
              }}
            />
            💰 Beim manuellen Start erst im Off-Peak-Fenster loslegen (bis −75% günstiger)
          </label>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={plan} disabled={!draft.goal.trim() || planning || running}>
              {planning ? 'Plane…' : '🎯 Plan erzeugen'}
            </button>
            {draft.tasks.length > 0 && !running && (
              <button className="btn ghost" onClick={() => save()}>
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

        {/* v2: VISUAL COMMAND CENTER — the live plan DAG. Re-renders from the mission prop, so the
            event-driven setDraft above animates nodes (status) + edges (deps) as the mission runs. */}
        {draft.tasks.length > 0 && (
          <div className="card">
            <div className="flex-between">
              <h3>
                Plan-Baum ({done}/{draft.tasks.length} erledigt)
                {running ? ' · läuft…' : draft.status === 'scheduled' ? ' · geplant' : failed ? ' · gestoppt (Fehler)' : ''}
              </h3>
              {draft.branch && <span className="pill">⎇ {draft.branch}</span>}
            </div>
            <div className="mission-progress">
              <div
                className={'mission-progress-fill' + (failed ? ' failed' : '')}
                style={{ width: `${draft.tasks.length ? (done / draft.tasks.length) * 100 : 0}%` }}
              />
            </div>
            <div className="mission-graph-wrap">
              <MissionGraph mission={draft} />
            </div>
          </div>
        )}

        {draft.tasks.length > 0 && (
          <div className="card">
            <div className="flex-between">
              <h3>Aufgaben</h3>
              {draft.replansUsed ? <span className="pill">🔁 {draft.replansUsed} Nachplanung(en)</span> : null}
            </div>
            {draft.tasks.map((t, i) => {
              const depTitles = (t.deps ?? [])
                .map((id) => draft.tasks.find((x) => x.id === id)?.title)
                .filter(Boolean) as string[]
              return (
                <div key={t.id} className={'mission-task' + (t.kind === 'remediation' ? ' remediation' : '')}>
                  <span className={'mission-status status-' + t.status}>{TASK_ICON[t.status]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mission-task-head">
                      {!editable ? (
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
                      {t.kind === 'remediation' && (
                        <span className="mission-tag remediation" title="Vom Overseer beim Nachplanen eingefügt">🔁 Reparatur</span>
                      )}
                    </div>
                    {!editable ? (
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
                    {depTitles.length > 0 && (
                      <div className="meta mission-deps">↳ braucht zuerst: {depTitles.join(' · ')}</div>
                    )}
                    {t.summary && <div className="meta">{t.summary.slice(0, 200)}</div>}
                    {(t.commit || t.branch || t.attempts > 0) && (
                      <div className="meta">
                        {t.commit ? `commit ${t.commit}` : ''}
                        {t.branch ? ` · ⎇ ${t.branch}` : ''}
                        {t.attempts > 1 ? ` · ${t.attempts} Versuche` : ''}
                        {t.tokens ? ` · ${t.tokens.toLocaleString()} tok` : ''}
                        {t.cost ? ` · $${t.cost.toFixed(4)}` : ''}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {failed && (
              <div className="banner" style={{ marginTop: 10 }}>
                Mission gestoppt: eine Aufgabe blieb auch nach Nachplanung rot (oder das Budget war
                erschöpft). Es wird nicht auf einer kaputten Basis weitergebaut — prüfe den
                Verify-Befehl und die letzte Aufgabe.
              </div>
            )}
          </div>
        )}

        {/* v2: MORNING REPORT — after a run finished, surface per-task status/commit/branch/cost with
            the reviewable per-milestone stack and approve(keep)/rewind guidance. */}
        {finished && draft.tasks.length > 0 && (
          <div className="card mission-report">
            <h3>
              {draft.status === 'done' ? '✅ Morgen-Bericht' : draft.status === 'failed' ? '❌ Morgen-Bericht (gestoppt)' : '⏹ Morgen-Bericht (angehalten)'}
            </h3>
            <p className="sub" style={{ marginTop: 4 }}>
              {draft.status === 'done'
                ? 'Alle Aufgaben sind verifiziert (Verify grün) und committet.'
                : 'Lauf beendet — prüfe die offenen Aufgaben unten.'}
            </p>
            <div className="mission-report-rows">
              {draft.tasks.map((t, i) => (
                <div key={t.id} className="mission-report-row">
                  <span className={'mission-status status-' + t.status}>{TASK_ICON[t.status]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mission-task-title">{i + 1}. {t.title}{t.kind === 'remediation' ? ' (🔁 Reparatur)' : ''}</div>
                    <div className="meta">
                      {t.status}
                      {t.commit ? ` · commit ${t.commit}` : ''}
                      {t.branch ? ` · ⎇ ${t.branch}` : ''}
                      {typeof t.cost === 'number' ? ` · $${t.cost.toFixed(4)}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mission-review-hint">
              <b>Überprüfen:</b> Jede verifizierte Aufgabe ist ein eigener Commit, gestapelt auf
              {draft.branch ? <> <code>{draft.branch}</code></> : <> dem Missions-Branch</>}, mit einem
              lokalen Meilenstein-Branch (<code>mission/{draft.id}--m…</code>) als Lesezeichen am Commit. So gehst du den
              Stapel durch:
              <ul>
                <li><b>Behalten (approve):</b> <code>git merge {draft.branch ?? `mission/${draft.id}`}</code> in deinen Hauptzweig.</li>
                <li><b>Zurückrollen (rewind) eines Meilensteins:</b> <code>git revert &lt;commit&gt;</code> oder den
                  Meilenstein-Branch verwerfen — die anderen bleiben unberührt.</li>
              </ul>
              Alles bleibt <b>lokal</b> — es wird nichts gepusht und kein PR erstellt.
            </div>
            {draft.reportPath && (
              <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => api.nightOpenReport(draft.reportPath!)}>
                📄 Vollständigen Bericht öffnen
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
                    {m.schedule?.mode === 'offpeak' ? ' · 🌙 Off-Peak' : m.schedule?.mode === 'cron' ? ` · ⏰ ${m.schedule.cron ?? ''}` : ''}
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
