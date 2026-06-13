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
        api.listWorkflowRuns(workflowId).then((r) => {
          setRuns(r)
          setSel((cur) => cur ?? r[0] ?? null) // keep the user's current selection
        })
      }
    })
    return off
  }, [workflowId])

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
