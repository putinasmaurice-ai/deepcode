import { useEffect, useState } from 'react'
import type { NightShiftState, ProjectDef } from '../../../shared/types'

const api = window.deepcode

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  running: '◐',
  done: '✅',
  failed: '❌'
}

export function NightShiftPanel(): JSX.Element {
  const [state, setState] = useState<NightShiftState | null>(null)
  const [projects, setProjects] = useState<ProjectDef[]>([])
  const [prompt, setPrompt] = useState('')
  const [projectId, setProjectId] = useState('')

  async function load(): Promise<void> {
    setState(await api.nightGet())
  }
  useEffect(() => {
    load()
    api.listProjects().then(setProjects)
  }, [])

  // poll while running so statuses move live
  useEffect(() => {
    if (!state?.running) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [state?.running])

  if (!state) return <div className="spinner" />

  async function addTask(): Promise<void> {
    if (!prompt.trim()) return
    const proj = projects.find((p) => p.id === projectId)
    const next: NightShiftState = {
      ...state!,
      tasks: [
        ...state!.tasks,
        {
          id: 'nt-' + Date.now(),
          prompt: prompt.trim(),
          cwd: proj?.cwd || '',
          projectId: proj?.id,
          status: 'pending'
        }
      ]
    }
    setState(await api.nightSave(next))
    setPrompt('')
  }

  async function removeTask(id: string): Promise<void> {
    setState(await api.nightSave({ ...state!, tasks: state!.tasks.filter((t) => t.id !== id) }))
  }

  async function clearDone(): Promise<void> {
    setState(await api.nightSave({ ...state!, tasks: state!.tasks.filter((t) => t.status !== 'done') }))
  }

  async function start(): Promise<void> {
    setState(await api.nightStart())
  }

  const pending = state.tasks.filter((t) => t.status === 'pending').length

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>🌙 Nachtschicht</h1>
        <p className="sub">
          Aufgaben einreihen, die der Agent nacheinander autonom abarbeitet — abends starten, morgens den
          Bericht lesen. Jede Aufgabe läuft als eigener Chat.
        </p>

        <div className="card">
          <h3>Aufgabe einreihen</h3>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="z.B. Führe alle Tests aus und fixe die Fehlschläge."
            />
          </div>
          <div className="row">
            <div className="field">
              <label>Projekt (bestimmt Ordner & Trust)</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">— wählen —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Autonomie</label>
              <select
                value={state.autonomy}
                onChange={async (e) =>
                  setState(await api.nightSave({ ...state, autonomy: e.target.value as 'safe' | 'full' }))
                }
              >
                <option value="safe">Safe — nur lesen</option>
                <option value="full">Full — Dateien & Shell erlaubt</option>
              </select>
            </div>
            <div className="field">
              <label>Start-Zeitpunkt</label>
              <select
                value={state.waitForOffPeak ? 'offpeak' : 'now'}
                onChange={async (e) =>
                  setState(await api.nightSave({ ...state, waitForOffPeak: e.target.value === 'offpeak' }))
                }
              >
                <option value="now">Sofort</option>
                <option value="offpeak">💰 Im Off-Peak-Fenster (bis −75% günstiger)</option>
              </select>
            </div>
          </div>
          <button className="btn" onClick={addTask} disabled={!prompt.trim() || !projectId}>
            Einreihen
          </button>
        </div>

        <div className="card">
          <div className="flex-between">
            <h3>
              Warteschlange ({pending} offen{state.running ? ' · läuft…' : ''})
            </h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {state.running ? (
                <button className="btn danger sm" onClick={() => api.nightStop().then(load)}>
                  Stoppen
                </button>
              ) : (
                <button className="btn sm" onClick={start} disabled={pending === 0}>
                  ▶ Jetzt starten
                </button>
              )}
              <button className="btn ghost sm" onClick={clearDone}>
                Erledigte entfernen
              </button>
            </div>
          </div>
          {state.tasks.length === 0 && <div className="empty">Noch keine Aufgaben eingereiht.</div>}
          {state.tasks.map((t) => (
            <div key={t.id} className="night-task">
              <span className="night-status">{STATUS_ICON[t.status]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{t.prompt}</div>
                {t.summary && <div className="meta" style={{ marginTop: 4 }}>{t.summary.slice(0, 200)}</div>}
                {t.tokens ? (
                  <div className="meta">
                    {t.tokens.toLocaleString()} Tokens · ${(t.cost ?? 0).toFixed(4)}
                  </div>
                ) : null}
              </div>
              {t.status !== 'running' && (
                <span className="chip-x" onClick={() => removeTask(t.id)}>
                  ✕
                </span>
              )}
            </div>
          ))}
        </div>

        {state.lastReportPath && (
          <p className="sub">
            <button className="btn ghost sm" onClick={() => api.nightOpenReport(state.lastReportPath!)}>
              📄 Letzten Bericht öffnen
            </button>
            {state.lastRunAt ? ` (${new Date(state.lastRunAt).toLocaleString()})` : ''}
          </p>
        )}
        <p className="sub">
          ⚠ „Full"-Autonomie führt Datei-Änderungen und Shell-Befehle ohne Rückfrage aus — gefährliche
          Befehle bleiben trotzdem gesperrt, und /rewind kann Änderungen zurücknehmen.
        </p>
      </div>
    </div>
  )
}
