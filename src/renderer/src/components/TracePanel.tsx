import { useEffect, useMemo, useState } from 'react'
import type { Trace, TraceSpan, AgentEvent } from '../../../shared/types'

const api = window.deepcode

const STATUS_ICON: Record<string, string> = {
  running: '⏳',
  ok: '✅',
  error: '❌',
  cancelled: '🚫'
}
const KIND_ICON: Record<string, string> = {
  round: '🔄',
  llm: '🧠',
  tool: '🔧',
  subagent: '🤖',
  verify: '⚙️',
  compact: '🗜️'
}

function when(ts: number): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}
function dur(a?: number, b?: number): string {
  if (!a || !b) return ''
  const s = Math.max(0, Math.round((b - a) / 100) / 10)
  return s < 60 ? `${s}s` : `${Math.round(s / 6) / 10}m`
}
function usd(n?: number): string {
  if (!n) return ''
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`
}

// Flatten the flat span list into a depth-ordered tree (DFS by parentId, preserving the
// chronological insertion order within each parent) so the UI can indent the nesting.
function flatten(spans: TraceSpan[]): { span: TraceSpan; depth: number }[] {
  const children = new Map<string, TraceSpan[]>()
  for (const s of spans) {
    const key = s.parentId ?? '__root__'
    if (!children.has(key)) children.set(key, [])
    children.get(key)!.push(s)
  }
  const out: { span: TraceSpan; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (key: string, depth: number): void => {
    for (const s of children.get(key) ?? []) {
      if (seen.has(s.id)) continue // guard against a corrupt cyclic parentId
      seen.add(s.id)
      out.push({ span: s, depth })
      walk(s.id, depth + 1)
    }
  }
  walk('__root__', 0)
  // any span not reached by the walk (parent missing/pruned, OR a corrupt file with a
  // duplicate id) still gets shown once at the root — emit by object identity, not id, so a
  // duplicate-id span isn't silently dropped.
  const emitted = new Set(out.map((o) => o.span))
  for (const s of spans) if (!emitted.has(s)) out.push({ span: s, depth: 0 })
  return out
}

// Observability: browse past chat turns as a correlated tree — each LLM call (with cost),
// each tool call (with duration / ok-error), nested subagents, verify + compaction.
export function TracePanel(): JSX.Element {
  const [traces, setTraces] = useState<Trace[] | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    api.listTraces().then((t) => {
      setTraces(t)
      setSelId((cur) => cur ?? t[0]?.id ?? null)
    })
  }, [])

  // refresh the list whenever a turn finishes while the panel is open
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'turn_done') {
        api.listTraces().then((t) => {
          setTraces(t)
          // keep the user's selection IF it still exists in the list; else fall back to newest
          setSelId((cur) => (cur && t.some((x) => x.id === cur) ? cur : t[0]?.id ?? null))
        })
      }
    })
    return off
  }, [])

  const shown = useMemo(
    () =>
      (traces ?? []).filter(
        (t) => !filter || t.title.toLowerCase().includes(filter.toLowerCase()) || t.model.toLowerCase().includes(filter.toLowerCase())
      ),
    [traces, filter]
  )
  const sel = useMemo(() => (traces ?? []).find((t) => t.id === selId) ?? null, [traces, selId])
  const rows = useMemo(() => (sel ? flatten(sel.spans) : []), [sel])

  if (!traces) return <div className="spinner" />

  return (
    <div className="panel">
      <div className="panel-inner trace-panel">
        <h1>🔬 Traces</h1>
        <p className="sub">
          Jeder Chat-Turn als Baum: LLM-Aufrufe (mit Kosten), Tool-Aufrufe (Dauer, ok/Fehler),
          Subagents, Verify &amp; Verdichtung. Lokal unter <code>~/.deepcode/traces/</code>.
        </p>
        <div className="field">
          <input placeholder="Filtern (Titel / Modell)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="trace-body">
          <div className="trace-list">
            {shown.length === 0 && <div className="empty">Noch keine Traces{filter ? ' für diesen Filter' : ''}.</div>}
            {shown.map((t) => (
              <button
                key={t.id}
                className={'trace-item' + (selId === t.id ? ' sel' : '')}
                onClick={() => setSelId(t.id)}
              >
                <span className="trace-st">{STATUS_ICON[t.status] ?? '·'}</span>
                <span className="trace-title">{t.title}</span>
                <span className="trace-meta-row">
                  <span>{dur(t.startedAt, t.endedAt) || '…'}</span>
                  {t.costUsd > 0 && <span>{usd(t.costUsd)}</span>}
                  {t.unattended && <span title="unbeaufsichtigt (Cron/Automation)">🕒</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="trace-detail">
            {sel ? (
              <>
                <div className="trace-head">
                  <div className="trace-head-title">
                    {STATUS_ICON[sel.status]} <b>{sel.title}</b>
                  </div>
                  <div className="trace-head-stats">
                    <span>🧠 {sel.model}</span>
                    <span>⏱ {dur(sel.startedAt, sel.endedAt) || '…'}</span>
                    {sel.costUsd > 0 && <span>💰 {usd(sel.costUsd)}</span>}
                    {sel.tokens > 0 && <span>🔢 {sel.tokens.toLocaleString()} tok</span>}
                    <span title={when(sel.startedAt)}>{when(sel.startedAt)}</span>
                  </div>
                </div>
                <div className="trace-tree">
                  {rows.length === 0 && <p className="wf-hint">Keine Spans aufgezeichnet.</p>}
                  {rows.map(({ span, depth }, i) => (
                    <div key={span.id + ':' + i} className={'trace-span st-' + span.status} style={{ marginLeft: depth * 18 }}>
                      <div className="trace-span-head">
                        <span className="trace-span-ic">{KIND_ICON[span.kind] ?? '•'}</span>
                        <span className="trace-span-name">{span.name}</span>
                        <span className="trace-span-tail">
                          {span.costUsd ? <span className="trace-cost">{usd(span.costUsd)}</span> : null}
                          {span.tokens ? <span className="trace-tok">{span.tokens.toLocaleString()} tok</span> : null}
                          <span className="trace-dur">{dur(span.startedAt, span.endedAt)}</span>
                          <span className="trace-span-st">{STATUS_ICON[span.status] ?? ''}</span>
                        </span>
                      </div>
                      {span.error ? (
                        <pre className="trace-span-err">{span.error}</pre>
                      ) : span.detail ? (
                        <div className="trace-span-detail">{span.detail}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="wf-hint">Wähle links einen Trace.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
