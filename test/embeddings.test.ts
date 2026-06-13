import { describe, it, expect } from 'vitest'
import { chunkLines, cosine } from '../src/main/embeddings'

describe('chunkLines', () => {
  it('chunks with overlap and 1-based start lines', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
    const chunks = chunkLines(text, 'a.ts', 40, 8)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].file).toBe('a.ts')
    // step = size - overlap = 32, so the second chunk starts at line 33
    expect(chunks[1].startLine).toBe(33)
    // overlap: chunk 0 covers lines 1..40, chunk 1 starts at 33 → shared 33..40
    expect(chunks[0].text).toContain('line 40')
    expect(chunks[1].text).toContain('line 33')
  })

  it('skips empty/whitespace-only content', () => {
    expect(chunkLines('\n\n   \n', 'b.ts').length).toBe(0)
  })

  it('does not loop forever on small input', () => {
    expect(chunkLines('one\ntwo', 'c.ts', 40, 8).length).toBe(1)
  })
})

describe('cosine', () => {
  it('is 1 for identical vectors and 0 for orthogonal', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6)
  })

  it('ranks a closer vector higher', () => {
    const q = [1, 1, 0]
    expect(cosine(q, [1, 1, 0])).toBeGreaterThan(cosine(q, [1, 0, 1]))
  })

  it('returns 0 for a zero vector (no NaN)', () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0)
  })
})
