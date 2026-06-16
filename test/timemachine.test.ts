import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'

// Redirect ~/.deepcode to an isolated temp HOME BEFORE paths.ts loads (it reads homedir() at
// module-eval time). vi.hoisted runs before the static imports below. (Same pattern as backup.test.ts.)
const HOME = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp'
  const home = `${base}/dc-tm-test-${process.pid}`
  process.env.USERPROFILE = home // os.homedir() reads this on Windows
  process.env.HOME = home // …and this on POSIX
  return home
})

import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../src/main/paths'
import { isTimeMachineBranch } from '../src/main/timemachine/fork'
import { reconstructStateBefore } from '../src/main/timemachine/reconstruct'

const CFG = join(HOME, '.deepcode')

// Seed a session file (getSession reads straight from disk, bypassing the cache) so the
// reconstructed paths resolve relative to a cwd.
function seedSession(sid: string, cwd: string): void {
  const s = { id: sid, title: 'T', cwd, createdAt: 1, updatedAt: 1, messages: [] }
  writeFileSync(join(PATHS.sessions, `${sid}.json`), JSON.stringify(s), 'utf8')
}
// Hand-author a turn's checkpoint pre-images (same technique as checkpoint-skip.test.ts).
function seedTurn(sid: string, tag: string, snaps: unknown[]): void {
  const d = join(PATHS.root, 'checkpoints', sid)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${tag}.json`), JSON.stringify(snaps), 'utf8')
}

beforeAll(() => {
  // hard safety: if the redirect didn't take, ABORT before any write touches the real config dir
  if (PATHS.root !== CFG) throw new Error(`paths not redirected (root=${PATHS.root}) — aborting`)
  mkdirSync(PATHS.sessions, { recursive: true })
})
afterAll(() => {
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

// The safety contract branchFromHere relies on: a renderer-supplied name can NEVER reach a real
// branch or inject a git option. (fork.ts only ever operates on branches that pass this guard.)
describe('isTimeMachineBranch guard', () => {
  it('accepts well-formed timemachine/* refs', () => {
    expect(isTimeMachineBranch('timemachine/abc123-t1700000000000')).toBe(true)
    expect(isTimeMachineBranch('timemachine/a._-b')).toBe(true)
  })
  it('rejects anything that could escape to a real branch or inject a git option', () => {
    expect(isTimeMachineBranch('main')).toBe(false)
    expect(isTimeMachineBranch('timemachine/../main')).toBe(false) // traversal
    expect(isTimeMachineBranch('swarm/x')).toBe(false) // wrong prefix
    expect(isTimeMachineBranch('timemachine/a b')).toBe(false) // space
    expect(isTimeMachineBranch('timemachine/a;rm -rf /')).toBe(false) // shell metachar
    expect(isTimeMachineBranch('timemachine/')).toBe(false) // empty slug
    expect(isTimeMachineBranch('')).toBe(false)
    // @ts-expect-error — the runtime guard must not throw on a non-string
    expect(isTimeMachineBranch(undefined)).toBe(false)
  })
})

// The core causal-replay rule: a checkpoint stores the pre-image of each file the FIRST time a
// turn touches it, so the OLDEST qualifying pre-image (smallest tag >= tick) is the file's state
// at the tick. branchFromHere materializes exactly this into a throwaway worktree.
describe('reconstructStateBefore — repo state just before a past tick', () => {
  it('picks the OLDEST pre-image >= tick per path (= the file state at the tick)', () => {
    const sid = `tmA${process.pid}`
    const cwd = join(CFG, 'projA')
    seedSession(sid, cwd)
    const f = join(cwd, 'a.txt')
    seedTurn(sid, '1000', [{ path: f, existed: true, content: 'AT-1000' }])
    seedTurn(sid, '2000', [{ path: f, existed: true, content: 'AT-2000' }])

    const atTick = reconstructStateBefore(sid, 1000)
    const hit = atTick.find((x) => x.path === f)!
    expect(hit.content).toBe('AT-1000') // oldest qualifying pre-image wins
    expect(hit.existed).toBe(true)
    expect(hit.skipped).toBe(false)
    expect(hit.rel).toBe('a.txt') // path made relative to the session cwd

    // a later tick no longer sees the 1000 pre-image — only the later one qualifies
    expect(reconstructStateBefore(sid, 1500).find((x) => x.path === f)!.content).toBe('AT-2000')
  })

  it('surfaces a skipped marker honestly and maps a non-existent pre-image to existed:false', () => {
    const sid = `tmB${process.pid}`
    const cwd = join(CFG, 'projB')
    seedSession(sid, cwd)
    const big = join(cwd, 'big.bin')
    const created = join(cwd, 'created.ts')
    seedTurn(sid, '3000', [
      { path: big, existed: true, content: '', skipped: true },
      { path: created, existed: false, content: '' }
    ])

    const r = reconstructStateBefore(sid, 3000)
    const b = r.find((x) => x.path === big)!
    expect(b.skipped).toBe(true) // → branchFromHere leaves the HEAD version in place (skipped++)
    expect(b.content).toBe('') // never faked into real content
    const c = r.find((x) => x.path === created)!
    expect(c.existed).toBe(false) // → branchFromHere removes it on the fork (deleted++)
    expect(c.skipped).toBe(false)
    expect(r.map((x) => x.rel)).toEqual([...r.map((x) => x.rel)].sort()) // output sorted by rel
  })

  it('returns [] for an unknown session and for one without checkpoints', () => {
    expect(reconstructStateBefore('nosuchsession', 0)).toEqual([])
    const sid = `tmC${process.pid}`
    seedSession(sid, join(CFG, 'projC')) // session exists, but no turn checkpoints
    expect(reconstructStateBefore(sid, 0)).toEqual([])
  })
})
