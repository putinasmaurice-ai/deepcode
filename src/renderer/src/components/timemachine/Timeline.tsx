import { useCallback, useEffect, useRef } from 'react'
import type { TimelineTick } from '../../../../shared/types'

// World-class neon scrubber rail for Time Machine. Pure presentational: one dot per
// fused turn-tick (left = oldest, right = newest), colored by status, glowing in
// proportion to its cost, dashed-ringed when its pre-image is missing/skipped (.gap),
// and bright neon-ringed + playhead-marked when selected. Keyboard ←/→ scrubs and the
// selected dot auto-scrolls into view. No window.deepcode calls — the parent owns data + IPC.

// Cost → glow strength in [0,1]. Sub-linear (sqrt) so one pricey turn doesn't blind the
// rail; ~0.36$ reaches full glow. Drives the dot size + box-shadow radius (inline, layered
// on top of the shared .tm-tick base so the rail still reads from styles.css alone).
function glowFor(costUsd: number): number {
  const c = Math.max(0, costUsd)
  return Math.min(1, Math.sqrt(c) / 0.6)
}

// The neon token for a non-error / non-gap dot's glow (selected dot reuses it for its ring).
function glowColor(t: TimelineTick): string {
  if (t.status === 'error') return 'var(--red)'
  if (t.status === 'running') return 'var(--yellow)'
  if (t.status === 'ok') return 'var(--green)'
  return 'var(--text-faint)'
}

// Localized cost label — the app is German: "gratis", "< 1 Cent", comma decimal.
function costLabel(costUsd: number): string {
  if (costUsd <= 0) return 'gratis'
  if (costUsd < 0.01) return '< 1 Cent'
  return costUsd.toFixed(costUsd < 1 ? 3 : 2).replace('.', ',') + ' $'
}

// A short ms label shown under each dot (the turn key, trimmed to the last 5 digits).
function tickLabel(tick: number): string {
  const s = String(tick)
  return s.length > 5 ? '…' + s.slice(-5) : s
}

// Compact German tooltip: title/excerpt, time, cost, changed-file count + honesty note.
function tooltipFor(t: TimelineTick): string {
  const head = (t.userExcerpt || t.assistantExcerpt || t.model || 'Turn').slice(0, 90)
  const lines = [head, `🕑 ${t.iso}`, `💸 ${costLabel(t.costUsd)}`]
  const changed = t.files.length
  if (changed > 0) {
    let f = `📄 ${changed} ${changed === 1 ? 'Datei' : 'Dateien'} geändert`
    if (t.skippedFiles > 0) f += ` · ${t.skippedFiles} nicht sicherbar`
    lines.push(f)
  } else if (!t.hasCheckpoint) {
    lines.push('📄 keine Dateiänderung (kein Checkpoint)')
  }
  if (t.toolCount > 0) lines.push(`🔧 ${t.toolCount} Tool-Aufrufe`)
  if (t.topError) lines.push(`⚠️ ${t.topError.slice(0, 80)}`)
  return lines.join('\n')
}

export function Timeline(props: {
  ticks: TimelineTick[]
  selected: number | null
  onSelect: (tick: number) => void
}): JSX.Element {
  const { ticks, selected, onSelect } = props
  const railRef = useRef<HTMLDivElement | null>(null)
  const selRef = useRef<HTMLButtonElement | null>(null)

  // Always chronological (oldest → newest) regardless of how the parent passes them.
  const ordered = [...ticks].sort((a, b) => a.tick - b.tick)
  const selIdx = selected == null ? -1 : ordered.findIndex((t) => t.tick === selected)

  // Auto-scroll the selected dot into the centre of the rail when it changes.
  useEffect(() => {
    selRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [selected])

  // ←/→ move the selection to the neighbouring tick (clamped) and notify the parent.
  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (ordered.length === 0) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const base = selIdx < 0 ? (e.key === 'ArrowLeft' ? ordered.length : -1) : selIdx
      const next = e.key === 'ArrowLeft' ? base - 1 : base + 1
      const clamped = Math.max(0, Math.min(ordered.length - 1, next))
      onSelect(ordered[clamped].tick)
    },
    [ordered, selIdx, onSelect]
  )

  if (ordered.length === 0) {
    return <div className="tm-empty">Noch keine Ticks auf dieser Zeitachse.</div>
  }

  return (
    <div
      ref={railRef}
      className="tm-rail"
      role="slider"
      tabIndex={0}
      aria-label="Zeitachse — mit ← → durch die Turns scrubben"
      aria-valuemin={0}
      aria-valuemax={ordered.length - 1}
      aria-valuenow={selIdx < 0 ? undefined : selIdx}
      onKeyDown={onKey}
    >
      {ordered.map((t) => {
        const isSel = t.tick === selected
        const glow = glowFor(t.costUsd)
        // A turn with a missing/skipped pre-image (or no checkpoint) gets the dashed "gap"
        // ring — the honest signal that this point may not be fully reconstructable.
        const gap = !t.hasCheckpoint || t.skippedFiles > 0 || (t.files.length > 0 && !t.restorable)
        const cls =
          'tm-tick' +
          (t.status === 'error' ? ' err' : '') +
          (gap ? ' gap' : '') +
          (isSel ? ' sel' : '')
        // Inline cost-glow scaling, layered over the shared .tm-tick base. Gap dots stay
        // their dashed transparent selves (no glow); selected styling comes from .sel.
        const px = (10 + glow * 8).toFixed(1) + 'px'
        const dotGlow = gap
          ? undefined
          : {
              width: px,
              height: px,
              boxShadow: `0 0 ${(6 + glow * 18).toFixed(0)}px color-mix(in srgb, ${glowColor(
                t
              )} ${(40 + glow * 45).toFixed(0)}%, transparent)`
            }
        return (
          <button
            key={t.tick}
            ref={isSel ? selRef : undefined}
            type="button"
            className={cls}
            title={tooltipFor(t)}
            aria-label={tooltipFor(t)}
            aria-current={isSel ? 'true' : undefined}
            onClick={() => onSelect(t.tick)}
            style={isSel ? undefined : dotGlow}
          >
            {isSel && <span className="tm-playhead" aria-hidden />}
            <span className="tm-tick-label" aria-hidden>
              {tickLabel(t.tick)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
