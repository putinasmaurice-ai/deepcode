import { useMemo } from 'react'
import type { Trace, TraceSpanKind } from '../../../shared/types'

// $ formatting: tiny amounts get 4 decimals, otherwise 3 (matches TracePanel's usd()).
function usd(n: number): string {
  if (!n) return '$0'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`
}
function durMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 100) / 10)
  return s < 60 ? `${s}s` : `${Math.round(s / 6) / 10}m`
}

const KIND_ICON: Record<string, string> = {
  round: '🔄',
  llm: '🧠',
  tool: '🔧',
  subagent: '🤖',
  verify: '⚙️',
  compact: '🗜️'
}
const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--green)',
  error: 'var(--red)',
  cancelled: 'var(--yellow)',
  running: 'var(--accent)'
}

const cellBg = 'var(--bg-3)'
const tile: React.CSSProperties = {
  flex: '1 1 110px',
  background: cellBg,
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 10px'
}
const tileVal: React.CSSProperties = { fontSize: 18, fontWeight: 700, color: 'var(--text)' }
const tileLbl: React.CSSProperties = { fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }
const sectionH: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  margin: '14px 0 6px'
}

// A tiny labelled bar row used for every breakdown (model / kind / slowest).
function BarRow(props: { label: string; sub?: string; pct: number; color?: string }): JSX.Element {
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
        <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {props.label}
        </span>
        <span style={{ color: 'var(--text-faint)', flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 11 }}>{props.sub}</span>
      </div>
      <div style={{ height: 4, background: 'var(--border)', borderRadius: 3, marginTop: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(2, Math.min(100, props.pct))}%`, height: '100%', background: props.color ?? 'var(--accent)' }} />
      </div>
    </div>
  )
}

// Aggregations over a SET of traces: cost transparency + hotspots. Pure — derives
// everything via useMemo, no IPC/state.
export function TraceStats({ traces }: { traces: Trace[] }): JSX.Element {
  const s = useMemo(() => {
    let cost = 0
    let tokens = 0
    const byStatus: Record<string, number> = { ok: 0, error: 0, cancelled: 0, running: 0 }
    const byModel = new Map<string, number>()
    const byKindCost = new Map<TraceSpanKind, number>()
    const byKindCount = new Map<TraceSpanKind, number>()
    const slow: { name: string; ms: number; trace: string }[] = []

    for (const t of traces) {
      cost += t.costUsd || 0
      tokens += t.tokens || 0
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
      byModel.set(t.model, (byModel.get(t.model) ?? 0) + (t.costUsd || 0))
      for (const sp of t.spans) {
        byKindCount.set(sp.kind, (byKindCount.get(sp.kind) ?? 0) + 1)
        if (sp.costUsd) byKindCost.set(sp.kind, (byKindCost.get(sp.kind) ?? 0) + sp.costUsd)
        if (sp.startedAt && sp.endedAt) slow.push({ name: sp.name, ms: sp.endedAt - sp.startedAt, trace: t.title })
      }
    }

    const topModels = [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    const kinds = [...byKindCount.entries()].sort((a, b) => b[1] - a[1])
    const maxKindCount = Math.max(1, ...kinds.map(([, c]) => c))
    const topModelCost = Math.max(0.000001, ...topModels.map(([, c]) => c))
    const slowest = slow.sort((a, b) => b.ms - a.ms).slice(0, 5)
    const maxSlow = Math.max(1, ...slowest.map((x) => x.ms))

    return { cost, tokens, byStatus, topModels, topModelCost, kinds, maxKindCount, byKindCost, slowest, maxSlow }
  }, [traces])

  if (traces.length === 0)
    return (
      <div style={{ color: 'var(--text-faint)', fontSize: 13, padding: 12, border: '1px dashed var(--border)', borderRadius: 8 }}>
        Keine Traces zum Auswerten. Führe einen Chat-Turn aus, dann erscheinen hier Kosten &amp; Hotspots.
      </div>
    )

  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <div style={tile}>
          <div style={tileVal}>{traces.length}</div>
          <div style={tileLbl}>Traces</div>
        </div>
        <div style={tile}>
          <div style={tileVal}>{usd(s.cost)}</div>
          <div style={tileLbl}>Kosten gesamt</div>
        </div>
        <div style={tile}>
          <div style={tileVal}>{s.tokens.toLocaleString()}</div>
          <div style={tileLbl}>Tokens</div>
        </div>
        <div style={tile}>
          <div style={{ ...tileVal, fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['ok', 'error', 'cancelled', 'running'] as const).map((k) =>
              s.byStatus[k] ? (
                <span key={k} style={{ color: STATUS_COLOR[k] }}>
                  {s.byStatus[k]} {k}
                </span>
              ) : null
            )}
          </div>
          <div style={tileLbl}>Status</div>
        </div>
      </div>

      <div style={sectionH}>Kosten nach Modell</div>
      {s.topModels.map(([model, c]) => (
        <BarRow key={model} label={model} sub={usd(c)} pct={(c / s.topModelCost) * 100} color="var(--accent-2)" />
      ))}

      <div style={sectionH}>Spans nach Art</div>
      {s.kinds.map(([kind, count]) => {
        const c = s.byKindCost.get(kind) ?? 0
        return (
          <BarRow
            key={kind}
            label={`${KIND_ICON[kind] ?? '•'} ${kind}`}
            sub={`${count}×${c ? ' · ' + usd(c) : ''}`}
            pct={(count / s.maxKindCount) * 100}
            color="var(--accent-3)"
          />
        )
      })}

      <div style={sectionH}>Langsamste Spans</div>
      {s.slowest.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Keine abgeschlossenen Spans.</div>
      ) : (
        s.slowest.map((x, i) => (
          <BarRow
            key={x.name + ':' + i}
            label={x.name}
            sub={`${durMs(x.ms)} · ${x.trace}`}
            pct={(x.ms / s.maxSlow) * 100}
            color="var(--yellow)"
          />
        ))
      )}
    </div>
  )
}
