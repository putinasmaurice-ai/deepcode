import { describe, it, expect } from 'vitest'
import { fuzzyScore, filterPalette } from '../src/renderer/src/components/palette-fuzzy'

describe('fuzzyScore — subsequence match with adjacency + prefix bonus', () => {
  it('matches an in-order subsequence and rejects out-of-order / missing chars', () => {
    expect(fuzzyScore('abc', 'aXbXc')).not.toBeNull()
    expect(fuzzyScore('abc', 'acb')).toBeNull() // out of order
    expect(fuzzyScore('xyz', 'abc')).toBeNull()
    expect(fuzzyScore('', 'anything')).toBe(0) // empty query matches everything
  })
  it('scores an exact prefix far better (more negative) than a scattered match', () => {
    const prefix = fuzzyScore('set', 'settings')!
    const scattered = fuzzyScore('set', 'reset everything tonight')!
    expect(prefix).toBeLessThan(scattered)
    expect(prefix).toBeLessThan(-900) // prefix bonus applied
  })
  it('rewards adjacency (contiguous run beats spread-out hits)', () => {
    const adjacent = fuzzyScore('ab', 'abxxxx')!
    const spread = fuzzyScore('ab', 'axxxxb')!
    expect(adjacent).toBeLessThan(spread)
  })
})

describe('filterPalette — the ranking the palette actually renders', () => {
  const items = [
    { id: '1', label: 'Open Settings', hint: 'config' },
    { id: '2', label: 'New Chat', hint: 'create' },
    { id: '3', label: 'Reset session', hint: 'clear' }
  ]
  it('drops non-matches and keeps only subsequence hits', () => {
    const r = filterPalette(items, 'set')
    expect(r.map((x) => x.id).sort()).toEqual(['1', '3']) // both contain 'set'; "New Chat/create" does not
    expect(r.find((x) => x.id === '2')).toBeUndefined()
  })
  it('floats an exact prefix to the top over a scattered match', () => {
    const r = filterPalette(
      [
        { id: 'a', label: 'config' }, // 'cfg' is scattered: c..f..g
        { id: 'b', label: 'cfg' } // 'cfg' is an exact prefix → big bonus
      ],
      'cfg'
    )
    expect(r.map((x) => x.id)).toEqual(['b', 'a'])
  })
  it('matches against the hint too, and caps to the limit', () => {
    expect(filterPalette(items, 'config').map((x) => x.id)).toEqual(['1']) // hint match
    expect(filterPalette(items, '', 2)).toHaveLength(2) // empty query keeps all, capped
  })
})
