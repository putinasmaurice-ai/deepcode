import { useEffect, useState } from 'react'

// detect the user's reduced-motion preference once (module scope) — no per-render matchMedia
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

// per-particle geometry, precomputed so the CSS keyframe only animates transform/opacity.
// capped at 14 particles per burst (perf + "elegant, not seizure-inducing").
const CAP = 14
// small festive palette for confetti (uses theme accent tokens + green/yellow)
const CONFETTI_COLORS = ['var(--accent)', 'var(--accent-2)', 'var(--accent-3)', 'var(--green)', 'var(--yellow)']

interface Particle {
  dx: number
  dy: number
  d: number
  rot?: string
  color?: string
}

// radial spark burst: particles fly outward in all directions and fade.
function sparks(n: number): Particle[] {
  const count = Math.min(n, CAP)
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.5
    const dist = 26 + Math.random() * 30
    return { dx: Math.cos(a) * dist, dy: Math.sin(a) * dist, d: 0.42 + Math.random() * 0.25 }
  })
}

// confetti: a wide horizontal scatter that falls DOWN, each piece its own rotation + color.
function confetti(n: number): Particle[] {
  const count = Math.min(n, CAP)
  return Array.from({ length: count }, (_, i) => ({
    dx: (Math.random() - 0.5) * 160, // wide left/right scatter
    dy: 80 + Math.random() * 80, // always downward (fall)
    d: 0.85 + Math.random() * 0.4,
    rot: Math.round(Math.random() * 720 - 360) + 'deg',
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]
  }))
}

interface RunFxProps {
  kind?: 'burst' | 'confetti'
  // changing this key (e.g. a status string or a run id) re-triggers the burst
  trigger?: string | number
  count?: number
}

// A reusable, self-cleaning particle burst. Mounts a short-lived CSS-animated layer and
// unmounts itself after the animation — no per-frame React setState, GPU-only (transform/opacity).
export function RunFx({ kind = 'burst', trigger, count = 12 }: RunFxProps): JSX.Element | null {
  const [parts, setParts] = useState<Particle[] | null>(null)

  useEffect(() => {
    if (trigger === undefined) return
    if (prefersReducedMotion()) return // honor reduced-motion: no burst at all
    const p = kind === 'confetti' ? confetti(CAP) : sparks(count)
    setParts(p)
    const longest = Math.max(...p.map((x) => x.d)) * 1000 + 80
    const t = setTimeout(() => setParts(null), longest)
    return () => clearTimeout(t)
  }, [trigger, kind, count])

  if (!parts) return null
  // The animation class belongs on each PIECE (the keyframe acts on the element that
  // moves), NOT on the zero-size container — so confetti pieces actually fall/rotate.
  const pieceCls = kind === 'confetti' ? 'wf-confetti' : 'wf-particle'
  return (
    <div className="wf-burst" aria-hidden>
      {parts.map((p, i) => (
        <span
          key={i}
          className={pieceCls}
          style={
            {
              '--wf-dx': `${p.dx}px`,
              '--wf-dy': `${p.dy}px`,
              ...(p.rot ? { '--wf-rot': p.rot } : {}),
              ...(p.color ? { '--wf-spark': p.color } : {}),
              animationDuration: `${p.d}s`
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}
