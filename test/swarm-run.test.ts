import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'

// Redirect ~/.deepcode to an isolated temp HOME BEFORE paths.ts loads (PATHS.swarm must live under
// the temp dir, not the real config). vi.hoisted runs before the static imports below.
const HOME = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp'
  const home = `${base}/dc-swarm-test-${process.pid}`
  process.env.USERPROFILE = home
  process.env.HOME = home
  return home
})

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../src/main/paths'
import { runGit } from '../src/main/agent/tools/git'
import { runSwarm, formatSwarmReport, SwarmShard, SwarmRunDeps } from '../src/main/agent/swarm'
import type { AgentEvent } from '../src/shared/types'

const CFG = join(HOME, '.deepcode')
const REPO = join(HOME, 'repo') // the project git repo the swarm worktrees branch off
const SID = `sw${process.pid}`
const sig = new AbortController().signal

beforeAll(async () => {
  if (PATHS.root !== CFG) throw new Error(`paths not redirected (root=${PATHS.root}) — aborting`)
  mkdirSync(REPO, { recursive: true })
  mkdirSync(PATHS.swarm, { recursive: true })
  // a real repo with one commit + a local identity (no gpg) so worktree add + commit succeed
  await runGit(['init'], REPO, sig)
  await runGit(['config', 'user.email', 'swarm@test.local'], REPO, sig)
  await runGit(['config', 'user.name', 'Swarm Test'], REPO, sig)
  await runGit(['config', 'commit.gpgsign', 'false'], REPO, sig)
  writeFileSync(join(REPO, 'README.md'), 'init\n', 'utf8')
  await runGit(['add', '-A'], REPO, sig)
  await runGit(['commit', '-m', 'init'], REPO, sig)
}, 30000)
afterAll(() => {
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

// A fake worker: writes a file into its worktree cwd UNLESS the prompt says NOOP, then bills a round.
function fakeWorker(): SwarmRunDeps['runWorker'] {
  return async (prompt, cwd, onUsage) => {
    onUsage({ cost: 0.002, totalTokens: 500 })
    if (!/NOOP/.test(prompt)) writeFileSync(join(cwd, 'worker.txt'), `edit for ${prompt}\n`, 'utf8')
    return `done: ${prompt.slice(0, 20)}`
  }
}

describe('runSwarm — isolated git worktrees, branch survival, teardown', () => {
  it('runs each shard in its own worktree+branch, commits real edits, tears the worktrees down', async () => {
    const events: AgentEvent[] = []
    const shards: SwarmShard[] = [
      { label: 'mod a', prompt: 'edit module a' },
      { label: 'mod b', prompt: 'edit module b' },
      { label: 'noop', prompt: 'NOOP do nothing' }
    ]
    const deps: SwarmRunDeps = {
      runWorker: fakeWorker(),
      emit: (e) => events.push(e),
      signal: sig,
      concurrency: 2
    }

    const { runId, workers } = await runSwarm(shards, REPO, SID, deps)

    expect(workers).toHaveLength(3)
    const a = workers.find((w) => w.label === 'mod a')!
    const b = workers.find((w) => w.label === 'mod b')!
    const noop = workers.find((w) => w.label === 'noop')!

    // the two real edits committed successfully and report a diff stat
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(a.diffStat).toMatch(/worker\.txt|1 file/)
    expect(a.branch).toMatch(/^swarm\/.+\/0-mod-a$/)
    expect(b.branch).toMatch(/^swarm\/.+\/1-mod-b$/)
    expect(a.costUsd).toBeCloseTo(0.002, 6) // usage bubbled per worker

    // the no-op worker created its branch but has nothing to commit
    expect(noop.ok).toBe(false)
    expect(noop.diffStat).toBe('(keine Änderungen)')

    // all three branches survive for review/merge
    const branches = await runGit(['branch', '--list', 'swarm/*'], REPO, sig)
    expect(branches.out).toContain(a.branch)
    expect(branches.out).toContain(b.branch)
    expect(branches.out).toContain(noop.branch)

    // the worktrees were torn down (root removed since nothing was preserved)
    const tag = runId.slice(0, 12)
    const root = join(PATHS.swarm, SID, tag)
    expect(existsSync(root)).toBe(false)
    const wt = await runGit(['worktree', 'list'], REPO, sig)
    expect(wt.out).not.toMatch(/[\\/]w0\b/) // only the main worktree remains

    // lifecycle events were emitted
    expect(events.some((e) => e.type === 'swarm_run' && e.status === 'start')).toBe(true)
    expect(events.some((e) => e.type === 'swarm_run' && e.status === 'done')).toBe(true)
  }, 60000)

  it('stops launching new workers once the cost cap is hit (completed ones still commit)', async () => {
    const shards: SwarmShard[] = Array.from({ length: 4 }, (_, i) => ({
      label: `cap ${i}`,
      prompt: `edit module ${i}`
    }))
    // each worker bills 0.01; cap 0.015 → after the first 2 (concurrency 2) bill, the cap trips
    // and workers 2/3 are never launched.
    const deps: SwarmRunDeps = {
      runWorker: async (prompt, cwd, onUsage) => {
        onUsage({ cost: 0.01, totalTokens: 100 })
        writeFileSync(join(cwd, 'worker.txt'), `edit ${prompt}\n`, 'utf8')
        return `done ${prompt}`
      },
      emit: () => {},
      signal: new AbortController().signal,
      concurrency: 2,
      costCapUsd: 0.015
    }

    const { workers, capped } = await runSwarm(shards, REPO, `${SID}cap`, deps)

    expect(capped).toBe(true)
    const okCount = workers.filter((w) => w.ok).length
    expect(okCount).toBeGreaterThanOrEqual(1) // the in-flight batch completed + committed
    expect(okCount).toBeLessThan(4) // the cap prevented the full run
    // the skipped workers committed nothing
    expect(workers.some((w) => !w.ok && w.diffStat === '(keine Änderungen)')).toBe(true)
    // the report carries the cap notice
    expect(formatSwarmReport(workers, capped)).toContain('Kosten-Limit erreicht')
  }, 60000)
})
