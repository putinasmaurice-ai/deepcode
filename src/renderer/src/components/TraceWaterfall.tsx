import type { Trace, TraceSpan } from '../../../shared/types'

// Kind → bar color (distinct accent-ish hues, readable on a dark theme). Error spans
// override this with a red tint so failures pop regardless of kind.
const KIND_COLOR: Record<string, string> = {
  round: 'hsl(220, 12%, 52%)',
  llm: 'hsl(265, 70%, 62%)',
  tool: 'hsl(200, 70%, 52%)',
  subagent: 'hsl(150, 60%, 46%)',
  verify: 'hsl(45, 80%, 55%)',
  compact: 'hsl(28, 75%, 55%)'
}
const KIND_ICON: Record<string, string> = {
  round: '🔄',
  llm: '🧠',
  tool: '🔧',
  subagent: '🤖',
  verify: '⚙️',
  compact: '🗜️'
}
const ERROR_COLOR = 'hsl(0, 70%, 55%)'

function dur(a?: number, b?: number): string {
  if (!a || !b) return ''
  const s = Math.max(0, Math.round((b - a) / 100) / 10)
  return s < 60 ? `${s}s` : `${Math.round(s / 6) / 10}m`
}

// Flatten the flat span list into a depth-ordered tree (DFS by parentId, preserving
// chronological insertion order within each parent), mirroring TracePanel so the
// waterfall rows line up with the tree view. Guards against cyclic / duplicate ids.
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
  const emitted = new Set(out.map((o) => o.span))
  for (const s of spans) if (!emitted.has(s)) out.push({ span: s, depth: 0 })
  return out
}

// Gantt / waterfall view of one trace's spans: each row is a horizontal bar positioned
// and sized by its time window, so parallelism (swarm/subagents) and per-step durations
// are visible at a glance. Pure presentational — no IPC, no state.
export function TraceWaterfall({ trace }: { trace: Trace }): JSX.Element {
  const rows = flatten(trace.spans)
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '8px 2px' }}>
        Keine Spans aufgezeichnet.
      </div>
    )
  }

  const now = Date.now()
  const t0 = trace.startedAt
  // Window end: explicit trace end, else the latest span end, else "now" (still running).
  const maxSpanEnd = rows.reduce((m, { span }) => Math.max(m, span.endedAt ?? 0), 0)
  const tEnd = trace.endedAt ?? (maxSpanEnd || now)
  const total = Math.max(1, tEnd - t0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {rows.map(({ span, depth }, i) => {
        const running = !span.endedAt
        const end = span.endedAt ?? now
        const leftPct = Math.min(99, Math.max(0, ((span.startedAt - t0) / total) * 100))
        const rawW = ((end - span.startedAt) / total) * 100
        const widthPct = Math.max(1.5, Math.min(100 - leftPct, rawW))
        const isError = span.status === 'error'
        const color = isError ? ERROR_COLOR : KIND_COLOR[span.kind] ?? 'var(--accent)'
        const label = (KIND_ICON[span.kind] ?? '•') + ' ' + span.name
        const d = dur(span.startedAt, end)

        return (
          <div
            key={span.id + ':' + i}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, lineHeight: 1.4 }}
          >
            {/* left: indented label, ~40% width, truncated */}
            <div
              title={span.name}
              style={{
                width: '40%',
                flexShrink: 0,
                marginLeft: depth * 12,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: isError ? ERROR_COLOR : 'var(--text)'
              }}
            >
              {label}
            </div>
            {/* right: the time track holding the positioned bar */}
            <div
              style={{
                position: 'relative',
                flex: 1,
                height: 16,
                background: 'var(--border)',
                borderRadius: 3,
                overflow: 'hidden'
              }}
            >
              <div
                title={`${span.name} — ${d || '…'}`}
                style={{
                  position: 'absolute',
                  top: 2,
                  bottom: 2,
                  left: leftPct + '%',
                  width: widthPct + '%',
                  background: color,
                  opacity: running ? 0.55 : 0.9,
                  borderRadius: 2,
                  animation: running ? 'pulse 1.4s ease-in-out infinite' : undefined,
                  minWidth: 2
                }}
              />
              {/* duration text pinned just after the bar end */}
              {d && (
                <span
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: `min(${leftPct + widthPct}%, calc(100% - 34px))`,
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 4,
                    fontSize: 10,
                    color: 'var(--text-faint)',
                    pointerEvents: 'none'
                  }}
                >
                  {d}
                </span>
              )}
            </div>
          </div>
        )
      })}
      {/* keyframes for the running-span pulse (scoped, inline) */}
      <style>{'@keyframes pulse{0%,100%{opacity:.4}50%{opacity:.7}}'}</style>
    </div>
  )
}
