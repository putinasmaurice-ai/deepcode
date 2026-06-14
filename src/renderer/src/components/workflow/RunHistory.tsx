import { useEffect, useState } from 'react'
import type { WorkflowRun, AgentEvent } from '../../../../shared/types'

const api = window.deepcode

const STATUS_ICON: Record<string, string> = {
  running: '⏳',
  done: '✅',
  failed: '❌',
  cancelled: '🚫',
  pending: '·',
  skipped: '⏭'
}

function when(ts: number): string {
  try {
    const d = new Date(ts)
    return d.toLocaleString()
  } catch {
    return ''
  }
}
function dur(a: number, b?: number): string {
  if (!b) return ''
  const s = Math.max(0, Math.round((b - a) / 100) / 10)
  return s < 60 ? `${s}s` : `${Math.round(s / 6) / 10}m`
}

// Past runs of one workflow: pick a run on the left, inspect each node's status + the data
// it produced (or its error) on the right. Makes a run traceable after the fact.
export function RunHistory({ workflowId, onClose }: { workflowId: string; onClose: () => void }): JSX.Element {
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [sel, setSel] = useState<WorkflowRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [healing, setHealing] = useState(false)
  const [healMsg, setHealMsg] = useState('')

  useEffect(() => {
    let alive = true
    api
      .listWorkflowRuns(workflowId)
      .then((r) => {
        if (!alive) return
        setRuns(r)
        setSel(r[0] ?? null)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [workflowId])

  // refresh when a run of THIS workflow finishes while the panel is open
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'workflow_run' && e.workflowId === workflowId && e.status !== 'start') {
        // a heal's FRESH run that succeeds on the first try emits no workflow_heal — clear the
        // spinner on any terminal run for this workflow so it can't hang forever.
        setHealing(false)
        api.listWorkflowRuns(workflowId).then((r) => {
          setRuns(r)
          setSel((cur) => cur ?? r[0] ?? null) // keep the user's current selection
        })
      }
      // self-heal progress: stream the coder's repair steps; on a terminal heal, refresh and
      // jump to the newest (the healed/last replay) run so the user sees the outcome.
      if (e.type === 'workflow_heal' && e.workflowId === workflowId) {
        if (e.message) setHealMsg(e.message)
        if (e.status === 'healed' || e.status === 'failed') {
          setHealing(false)
          api.listWorkflowRuns(workflowId).then((r) => {
            setRuns(r)
            setSel(r[0] ?? null)
          })
        }
      }
    })
    return off
  }, [workflowId])

  const repair = (): void => {
    // the interactive heal RE-RUNS the whole workflow from the start, so any upstream
    // side-effecting nodes (E-Mail/Telegram/HTTP-POST/Shell) fire AGAIN. Make that explicit.
    const ok = window.confirm(
      'Reparieren lässt den Workflow komplett neu laufen und repariert einen Fehler dabei automatisch.\n\n' +
        'Achtung: vorgelagerte Schritte (E-Mail, Telegram, HTTP-POST, Shell) werden dabei ERNEUT ausgeführt.\n\nFortfahren?'
    )
    if (!ok) return
    setHealing(true)
    setHealMsg('Starte Selbstheilung…')
    api.healWorkflow(workflowId).catch(() => {
      setHealing(false)
      setHealMsg('Reparatur konnte nicht gestartet werden.')
    })
  }

  return (
    <div className="wf-runs">
      <div className="wf-runs-head">
        <strong>🕘 Verlauf</strong>
        <button className="chip-x" onClick={onClose}>✕</button>
      </div>
      <div className="wf-runs-body">
        <div className="wf-runs-list">
          {loading && <p className="wf-hint">Lade…</p>}
          {!loading && runs.length === 0 && <p className="wf-hint">Noch keine Läufe.</p>}
          {runs.map((r) => (
            <button
              key={r.id}
              className={'wf-run-item' + (sel?.id === r.id ? ' sel' : '')}
              onClick={() => setSel(r)}
            >
              <span className="wf-run-st">{STATUS_ICON[r.status] ?? '·'}</span>
              <span className="wf-run-when">{when(r.startedAt)}</span>
              <span className="wf-run-dur">{dur(r.startedAt, r.endedAt)}</span>
            </button>
          ))}
        </div>
        <div className="wf-run-detail">
          {sel ? (
            <>
              <div className="wf-run-meta">
                {STATUS_ICON[sel.status]} <b>{sel.status}</b> · {when(sel.startedAt)}
                {sel.error && <div className="wf-field-err">⚠ {sel.error}</div>}
                {sel.status === 'failed' && (
                  <div className="wf-heal-row">
                    <button className="wf-heal-btn" onClick={repair} disabled={healing} title="Der In-Process-Coder repariert den fehlgeschlagenen Knoten und lässt den Workflow erneut laufen">
                      {healing ? '🩹 Repariere…' : '🩹 Reparieren'}
                    </button>
                    {healMsg && <span className="wf-heal-msg">{healMsg}</span>}
                  </div>
                )}
              </div>
              {sel.nodes.map((n) => (
                <div key={n.nodeId} className="wf-run-node">
                  <div className="wf-run-node-head">
                    {STATUS_ICON[n.status] ?? '·'} <code>{n.nodeId}</code>
                    <span className="wf-run-dur">{dur(n.startedAt ?? sel.startedAt, n.endedAt)}</span>
                  </div>
                  {n.error ? (
                    <pre className="wf-run-out err">{n.error}</pre>
                  ) : n.output ? (
                    <pre className="wf-run-out">{n.output.slice(0, 4000)}</pre>
                  ) : null}
                </div>
              ))}
              {sel.vars?.last && (
                <div className="wf-run-node">
                  <div className="wf-run-node-head">📤 Ergebnis (last)</div>
                  <pre className="wf-run-out">{String(sel.vars.last).slice(0, 4000)}</pre>
                </div>
              )}
            </>
          ) : (
            <p className="wf-hint">Wähle links einen Lauf.</p>
          )}
        </div>
      </div>
    </div>
  )
}
