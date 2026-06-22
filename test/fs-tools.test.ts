import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lineDiff, writeTool } from '../src/main/agent/tools/fs'
import type { ToolContext } from '../src/main/agent/tools/types'

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

describe('write_file — append mode (chunked large-file path)', () => {
  const mkCtx = (cwd: string): ToolContext => ({ cwd, confineToCwd: false }) as unknown as ToolContext

  it('overwrite (default) then append builds the full file and previews the whole thing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-write-'))
    try {
      const ctx = mkCtx(dir)
      const r1 = await writeTool.execute({ path: 'big.html', content: '<head>\n' }, ctx)
      expect(r1.ok).toBe(true)
      const r2 = await writeTool.execute({ path: 'big.html', content: '<body>\n', mode: 'append' }, ctx)
      expect(r2.ok).toBe(true)
      expect(readFileSync(join(dir, 'big.html'), 'utf8')).toBe('<head>\n<body>\n')
      expect(r2.meta?.content).toBe('<head>\n<body>\n') // diff/preview reflects the whole file, not just the chunk
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('append to a non-existent file creates it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-write-'))
    try {
      const r = await writeTool.execute({ path: 'new.txt', content: 'X', mode: 'append' }, mkCtx(dir))
      expect(r.ok).toBe(true)
      expect(r.meta?.created).toBe(true)
      expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('X')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
