// Command-palette fuzzy matching — pure + exported so the ranking the user actually sees is
// unit-testable without rendering. Subsequence match: every query char must appear in order in
// the target; the score rewards adjacency and floats exact prefixes to the top.

export interface PaletteScorable {
  label: string
  hint?: string
}

// Returns a score (LOWER = better) or null when the query is not a subsequence of the target.
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let lastHit = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti - lastHit // reward adjacency
      lastHit = ti
      qi++
    }
  }
  if (qi < q.length) return null // not all chars matched
  return score + (t.startsWith(q) ? -1000 : 0)
}

// Score `label + hint`, drop non-matches, sort best-first, cap to `limit` — the exact pipeline
// the palette renders.
export function filterPalette<T extends PaletteScorable>(items: T[], query: string, limit = 40): T[] {
  const scored = items
    .map((it) => ({ it, s: fuzzyScore(query, it.label + ' ' + (it.hint ?? '')) }))
    .filter((x): x is { it: T; s: number } => x.s !== null)
  scored.sort((a, b) => a.s - b.s)
  return scored.map((x) => x.it).slice(0, limit)
}
