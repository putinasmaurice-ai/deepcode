import { useMemo, type CSSProperties } from 'react'
import type {
  TimelineTick,
  TickDetail,
  TimeMachineFork,
  TraceSpan,
  ChatMessage
} from '../../../../shared/types'

// Kind/status glyphs mirror TracePanel so the reasoning tree reads identically across the app.
const KIND_ICON: Record<string, string> = {
  round: '🔄',
  llm: '🧠',
  tool: '🔧',
  subagent: '🤖',
  verify: '⚙️',
  compact: '🗜️'
}
const STATUS_ICON: Record<string, string> = {
  running: '⏳',
  ok: '✅',
  error: '❌',
  cancelled: '🚫',
  unknown: '·'
}
const STATUS_LABEL: Record<string, string> = {
  running: 'läuft',
  ok: 'ok',
  error: 'Fehler',
  cancelled: 'abgebrochen',
  unknown: 'unbekannt'
}

function usd(n?: number): string {
  if (!n) return ''
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`
}
function dur(a?: number, b?: number): string {
  if (!a || !b) return ''
  const s = Math.max(0, Math.round((b - a) / 100) / 10)
  return s < 60 ? `${s}s` : `${Math.round(s / 6) / 10}m`
}
function clip(s: string, n = 220): string {
  const t = (s || '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// Flatten the flat span list into a depth-ordered tree via parentId (DFS, insertion order
// preserved). Guards a corrupt cyclic/duplicate parentId — same approach as TracePanel.
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
      if (seen.has(s.id)) continue
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

// One reconstructed diff line colored by its +/- prefix — uses the .tm-diff .add/.del/.hunk
// block classes from the shared stylesheet (context is the default dimmed mono).
function diffClass(line: string): string | undefined {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'del'
  if (line.startsWith('@@')) return 'hunk'
  return undefined
}

function MessageRow({ m }: { m: ChatMessage }): JSX.Element {
  const label = m.toolName ? `${m.role} · ${m.toolName}` : m.role
  return (
    <div className={'tm-msg tm-msg-' + m.role}>
      <span className="tm-msg-role">{label}</span>
      <span className="tm-msg-body">{clip(m.content) || '(leer)'}</span>
    </div>
  )
}

// The selected tick rendered as a reconstructed "moment": header, reasoning span tree, changed
// files, diff, messages, an honest gap note, and the headline branch-from-here control + fork list.
// Pure presentational — every datum + action flows in via props. Class names match the shared
// .tm-* stylesheet (.tm-inspector is a card grid; .tm-span depth is the --tm-depth var).
export function TickInspector(props: {
  sessionId: string
  tick: TimelineTick
  detail: TickDetail | null
  forks: TimeMachineFork[]
  forking: boolean
  onFork: () => void
  onDeleteFork: (branch: string) => void
}): JSX.Element {
  const { tick, detail, forks, forking, onFork, onDeleteFork } = props
  const spanRows = useMemo(() => (detail?.trace ? flatten(detail.trace.spans) : []), [detail])
  const diffLines = useMemo(() => (detail?.diff ? detail.diff.split('\n') : []), [detail])

  return (
    <div className="tm-inspector">
      {/* 1) Header */}
      <div className="tm-card tm-card-head" style={{ gridColumn: '1 / -1' }}>
        <h4>{tick.iso}</h4>
        <div className="tm-meta tm-head-meta">
          {tick.model && <span className="tm-tag">🧠 {tick.model}</span>}
          <span className={'tm-tag tm-status st-' + tick.status}>
            {STATUS_ICON[tick.status] ?? '·'} {STATUS_LABEL[tick.status] ?? tick.status}
          </span>
          {tick.costUsd > 0 && <span className="tm-tag">💰 {usd(tick.costUsd)}</span>}
          {tick.tokens > 0 && <span className="tm-tag">🔢 {tick.tokens.toLocaleString()} tok</span>}
          {!tick.hasTrace && (
            <span className="tm-tag tm-faint" title="Über das Limit von 300 Traces hinaus verworfen">
              Trace verworfen (Limit 300)
            </span>
          )}
        </div>
        {tick.topError && <div className="tm-toperr">❌ {tick.topError}</div>}
      </div>

      {/* 2) Reasoning span tree */}
      <div className="tm-card">
        <h4>Reasoning</h4>
        {detail?.trace ? (
          spanRows.length > 0 ? (
            spanRows.map(({ span, depth }, i) => (
              <div
                key={span.id + ':' + i}
                className={'tm-span st-' + span.status}
                style={{ '--tm-depth': depth } as CSSProperties}
              >
                <span className="tm-span-ic">{KIND_ICON[span.kind] ?? '•'}</span>
                <span className="tm-span-name">{span.name}</span>
                {span.costUsd ? <span className="tm-span-cost">{usd(span.costUsd)}</span> : null}
                <span className="tm-span-dur">
                  {dur(span.startedAt, span.endedAt)} {STATUS_ICON[span.status] ?? ''}
                </span>
              </div>
            ))
          ) : (
            <p className="tm-meta">Keine Spans aufgezeichnet.</p>
          )
        ) : (
          <p className="tm-meta">Kein Reasoning-Trace für diesen Punkt.</p>
        )}
      </div>

      {/* 3) Changed files */}
      <div className="tm-card">
        <h4>Geänderte Dateien</h4>
        {tick.files.length > 0 ? (
          tick.files.map((f) => (
            <div key={f.path} className="tm-file" title={f.path}>
              <span className="tm-file-path">{f.rel}</span>
              {f.skipped ? (
                <span className="tm-gap-badge">&gt;5MB / nicht rekonstruierbar</span>
              ) : f.existed ? (
                <span className="tm-badge mod">geändert</span>
              ) : (
                <span className="tm-badge new">neu</span>
              )}
            </div>
          ))
        ) : (
          <p className="tm-meta">Dieser Turn hat keine Dateien geändert.</p>
        )}
      </div>

      {/* 4) Diff (collapsible) */}
      {detail?.diff && (
        <details className="tm-card" style={{ gridColumn: '1 / -1' }}>
          <summary className="tm-diff-summary">Diff (Vorzustand → danach)</summary>
          <pre className="tm-diff">
            {diffLines.map((l, i) => {
              const c = diffClass(l)
              return c ? (
                <span key={i} className={c}>
                  {l + '\n'}
                </span>
              ) : (
                l + '\n'
              )
            })}
          </pre>
        </details>
      )}

      {/* 5) Messages */}
      {detail && detail.messages.length > 0 && (
        <div className="tm-card" style={{ gridColumn: '1 / -1' }}>
          <h4>Nachrichten</h4>
          <div className="tm-msgs">
            {detail.messages.map((m) => (
              <MessageRow key={m.id} m={m} />
            ))}
          </div>
        </div>
      )}

      {/* 6) Honesty note */}
      <p className="tm-honesty" style={{ gridColumn: '1 / -1' }}>
        Terminal-Ausgaben und Live-Preview werden nicht dauerhaft gespeichert und lassen sich nicht
        rekonstruieren.
      </p>

      {/* 7) Branch-from-here (headline) */}
      <div className="tm-card tm-fork-card" style={{ gridColumn: '1 / -1' }}>
        <button
          className="tm-fork-btn"
          onClick={onFork}
          disabled={forking || !tick.restorable}
          title={!tick.restorable ? 'Nichts Rekonstruierbares an diesem Punkt' : undefined}
        >
          {forking ? '⏳ Zweige ab…' : '🌱 Abzweigen ab hier (Stand vor diesem Turn)'}
        </button>
        <p className="tm-fork-explain">
          Erstellt einen lokalen Branch in einem isolierten Worktree aus dem rekonstruierten
          Zustand — der Arbeitsbaum wird nicht angerührt, nichts wird gepusht.
        </p>
        {forks.length > 0 && (
          <div className="tm-forks">
            {forks.map((fk) => (
              <div key={fk.branch} className="tm-fork tm-fork-row">
                <div className="tm-fork-main">
                  <code className="tm-fork-name">{fk.branch}</code>
                  {fk.subject && <span className="tm-fork-subject">{fk.subject}</span>}
                  <code className="tm-fork-hint">git checkout {fk.branch}</code>
                  {fk.stat && <pre className="tm-fork-stat">{fk.stat}</pre>}
                </div>
                <button className="btn ghost sm tm-fork-del" onClick={() => onDeleteFork(fk.branch)}>
                  Löschen
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
