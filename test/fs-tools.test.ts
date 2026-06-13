import { describe, it, expect } from 'vitest'
import { lineDiff } from '../src/main/agent/tools/fs'

describe('lineDiff', () => {
  it('reports added and removed line counts', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc')
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.diff).toContain('- b')
    expect(d.diff).toContain('+ B')
  })

  it('handles pure additions (new file)', () => {
    const d = lineDiff('', 'line1\nline2')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(0)
  })

  it('shows nothing changed when identical', () => {
    const d = lineDiff('same\ntext', 'same\ntext')
    expect(d.added).toBe(0)
    expect(d.removed).toBe(0)
  })
})
