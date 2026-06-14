import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PATHS } from '../src/main/paths'
import { rewindLastTurn, deleteSessionCheckpoints } from '../src/main/checkpoints'
import { proveRedFirst } from '../src/main/agent/verify-synth'

// The #3-edge fix: a changed file the snapshotter couldn't capture (>5MB/locked) is recorded as a
// `skipped` MARKER. rewind must NEVER write a marker back (that would zero a large/binary file),
// and proveRedFirst must ABSTAIN when a source is skipped (it can't faithfully revert).

describe('rewind never overwrites a skipped-marker file', () => {
  it('restores normal pre-images but leaves a skipped file untouched', () => {
    const sid = `test-cpskip-${process.pid}`
    const dir = join(tmpdir(), `dc-cpskip-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    const normal = join(dir, 'normal.txt')
    const big = join(dir, 'big.bin')
    writeFileSync(normal, 'CURRENT', 'utf8') // will be rewound to the pre-image
    writeFileSync(big, 'KEEP', 'utf8') // a skipped marker → must NOT be touched
    // hand-author the turn snapshot (one normal pre-image + one skipped marker)
    const cpDir = join(PATHS.root, 'checkpoints', sid)
    mkdirSync(cpDir, { recursive: true })
    writeFileSync(
      join(cpDir, '1.json'),
      JSON.stringify([
        { path: normal, existed: true, content: 'OLD' },
        { path: big, existed: true, content: '', skipped: true }
      ]),
      'utf8'
    )
    try {
      const restored = rewindLastTurn(sid)
      expect(readFileSync(normal, 'utf8')).toBe('OLD') // normal file rewound
      expect(readFileSync(big, 'utf8')).toBe('KEEP') // skipped file UNTOUCHED (not zeroed)
      expect(restored).toContain(normal)
      expect(restored).not.toContain(big)
    } finally {
      deleteSessionCheckpoints(sid)
      try {
        unlinkSync(normal)
        unlinkSync(big)
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })
})

describe('proveRedFirst abstains on an incomplete baseline', () => {
  it('returns incomplete (and touches nothing) when a changed source is a skipped marker', async () => {
    const before = existsSync(big0()) // sentinel: ensure no stray writes
    const r = await proveRedFirst(
      '/proj/x.test.ts',
      [{ path: '/proj/src/huge.bin', existed: true, content: '', skipped: true }],
      'echo should-not-run',
      '/proj',
      new AbortController().signal,
      false // confine off so insideCwd doesn't pre-filter the absolute test path
    )
    expect(r.incomplete).toBe(true)
    expect(r.green).toBe(false)
    expect(existsSync(big0())).toBe(before) // no disk side effects
  })
})

function big0(): string {
  return join(tmpdir(), '__dc_proveredfirst_sentinel_should_never_exist__')
}
