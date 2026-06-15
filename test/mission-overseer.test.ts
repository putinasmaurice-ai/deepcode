import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

// Redirect ~/.deepcode to an isolated temp HOME BEFORE paths.ts loads (it reads homedir() at
// module-eval time). vi.hoisted runs before the static imports below. Mirrors backup.test.ts.
const HOME = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp'
  const home = `${base}/dc-mission-test-${process.pid}`
  process.env.USERPROFILE = home // os.homedir() reads this on Windows
  process.env.HOME = home // …and this on POSIX
  return home
})

import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS } from '../src/main/paths'
import { runMission, OverseerDeps, CommitResult } from '../src/main/missions/overseer'
import { getMission, saveMission, deleteMission } from '../src/main/missions/store'
import { generatePlan, parsePlanJson, coercePlan } from '../src/main/missions/plan'
import type { Mission, MissionTask } from '../src/shared/types'

const CFG = join(HOME, '.deepcode')

beforeAll(() => {
  if (PATHS.root !== CFG) throw new Error(`paths not redirected (root=${PATHS.root}) — aborting`)
  mkdirSync(join(CFG, 'missions'), { recursive: true })
})
afterAll(() => {
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const task = (title: string, status: MissionTask['status'] = 'pending'): MissionTask => ({
  id: randomUUID(),
  title,
  instruction: `do ${title}`,
  status,
  attempts: status === 'done' ? 1 : 0,
  commit: status === 'done' ? 'abc1234' : undefined
})

const makeMission = (tasks: MissionTask[]): Mission => {
  const m: Mission = {
    id: randomUUID().replace(/-/g, ''),
    goal: 'ship the thing',
    cwd: '/repo',
    verifyCommand: 'npm test',
    status: 'ready',
    tasks,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  saveMission(m)
  return m
}

// A stub OverseerDeps with live call counters; `verifyResults` is consumed per verify call
// (the last entry repeats once exhausted, so a single [false] means "always fails").
type StubDeps = OverseerDeps & { runCalls: number; verifyCalls: number; commits: string[] }
function makeDeps(over: Partial<OverseerDeps> & { verifyResults?: boolean[] } = {}): StubDeps {
  const counters = { runCalls: 0, verifyCalls: 0, commits: [] as string[] }
  const verifyResults = over.verifyResults ?? []
  const deps = {
    runTask:
      over.runTask ??
      (async () => {
        counters.runCalls++
        return { summary: 'did it', tokens: 10, cost: 0.01 }
      }),
    verify:
      over.verify ??
      (async () => {
        const ok = verifyResults.length ? verifyResults[Math.min(counters.verifyCalls, verifyResults.length - 1)] : true
        counters.verifyCalls++
        return { ok, summary: ok ? 'pass' : 'FAIL: assertion' }
      }),
    ensureBranch: over.ensureBranch ?? (async () => {}),
    commit:
      over.commit ??
      (async (_cwd: string, msg: string) => {
        counters.commits.push(msg)
        return { sha: `c${counters.commits.length}` }
      }),
    treeStatus: over.treeStatus ?? (async () => ''), // clean tree by default
    emit: over.emit ?? (() => {}),
    overDailyCap: over.overDailyCap ?? (() => false),
    inOffPeak: over.inOffPeak ?? (() => true),
    signal: over.signal ?? new AbortController().signal
  } as OverseerDeps
  return Object.defineProperties(deps as StubDeps, {
    runCalls: { get: () => counters.runCalls },
    verifyCalls: { get: () => counters.verifyCalls },
    commits: { get: () => counters.commits }
  })
}

describe('runMission overseer', () => {
  beforeEach(() => {
    // clean the missions dir between tests
    try {
      rmSync(join(CFG, 'missions'), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    mkdirSync(join(CFG, 'missions'), { recursive: true })
  })

  it('(1) verify-pass → task done + commit recorded + next task runs', async () => {
    const m = makeMission([task('a'), task('b')])
    const deps = makeDeps({ verifyResults: [true, true] })
    const result = await runMission(m, deps, {})

    expect(result.status).toBe('done')
    expect(deps.runCalls).toBe(2) // both tasks ran (proves the loop advanced)
    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    expect(result.tasks[0].commit).toBeTruthy()
    expect(deps.commits).toHaveLength(2)
    // persisted: re-read from disk reflects the done state
    const persisted = getMission(m.id)!
    expect(persisted.status).toBe('done')
    expect(persisted.tasks.every((t) => t.status === 'done')).toBe(true)
  })

  it('(2) verify-fail → one retry (runTask twice) → task+mission failed, loop halts', async () => {
    const m = makeMission([task('a'), task('b')])
    // every verify fails → first task can never pass
    const deps = makeDeps({ verifyResults: [false] })
    const result = await runMission(m, deps, {})

    expect(deps.runCalls).toBe(2) // first attempt + ONE retry on task A — never a 3rd, never task B
    expect(result.status).toBe('failed')
    expect(result.tasks[0].status).toBe('failed')
    expect(result.tasks[0].attempts).toBe(2)
    expect(result.tasks[1].status).toBe('pending') // task B never started (no continue on broken foundation)
    expect(deps.commits).toHaveLength(0) // nothing committed
    expect(getMission(m.id)!.status).toBe('failed')
  })

  it('(2b) verify fails once then passes on retry → task done', async () => {
    const m = makeMission([task('a')])
    const deps = makeDeps({ verifyResults: [false, true] })
    const result = await runMission(m, deps, {})
    expect(deps.runCalls).toBe(2)
    expect(result.status).toBe('done')
    expect(result.tasks[0].status).toBe('done')
    expect(result.tasks[0].attempts).toBe(2)
    expect(deps.commits).toHaveLength(1)
  })

  it('(3) overDailyCap() → true halts before running any task', async () => {
    const m = makeMission([task('a')])
    const deps = makeDeps({ overDailyCap: () => true })
    const result = await runMission(m, deps, {})

    expect(deps.runCalls).toBe(0) // never ran
    expect(deps.commits).toHaveLength(0)
    expect(result.status).toBe('stopped')
    expect(getMission(m.id)!.status).toBe('stopped')
  })

  it('(3b) an aborted signal halts before running any task', async () => {
    const m = makeMission([task('a')])
    const ac = new AbortController()
    ac.abort()
    const deps = makeDeps({ signal: ac.signal })
    const result = await runMission(m, deps, {})
    expect(deps.runCalls).toBe(0)
    expect(result.status).toBe('stopped')
  })

  it('(4) restart over a mission with a done task skips it (no re-run / no re-commit)', async () => {
    const done = task('a', 'done')
    const m = makeMission([done, task('b')])
    const deps = makeDeps({ verifyResults: [true] })
    const result = await runMission(m, deps, {})

    expect(deps.runCalls).toBe(1) // only task B ran — done task A was skipped
    expect(deps.commits).toHaveLength(1) // only B committed; A's prior commit untouched
    expect(result.tasks[0].commit).toBe('abc1234') // original commit preserved
    expect(result.tasks[1].status).toBe('done')
    expect(result.status).toBe('done')
  })

  it('(5) empty / whitespace verifyCommand fails the mission closed without running anything', async () => {
    for (const vc of ['', '   ']) {
      const m = makeMission([task('a')])
      m.verifyCommand = vc
      saveMission(m)
      const deps = makeDeps({ verifyResults: [true] })
      const result = await runMission(m, deps, {})
      expect(result.status).toBe('failed')
      expect(deps.runCalls).toBe(0) // never dispatched a task
      expect(deps.commits).toHaveLength(0)
    }
  })

  it('(6) a dirty working tree fails the mission closed before any task runs', async () => {
    const m = makeMission([task('a')])
    const deps = makeDeps({ verifyResults: [true], treeStatus: async () => ' M src/foo.ts\n' })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(deps.runCalls).toBe(0)
    expect(deps.commits).toHaveLength(0)
  })

  it('(7) daily cap crossed BETWEEN attempts stops the mission (not failed), no extra turn', async () => {
    const m = makeMission([task('a')])
    let calls = 0
    // verify always fails so a retry would be attempted; cap flips on after the first attempt ran.
    const deps = makeDeps({
      verifyResults: [false],
      overDailyCap: () => calls >= 1, // false before task 1, true before the retry
      runTask: async () => {
        calls++
        return { summary: 'x', tokens: 0, cost: 0 }
      }
    })
    const result = await runMission(m, deps, {})
    expect(calls).toBe(1) // the retry never started a second turn
    expect(result.status).toBe('stopped') // stop, not failed
    expect(result.tasks[0].status).not.toBe('failed')
  })

  it('(8) a commit rejected by a hook (dirty tree) is a task failure, not a silent done', async () => {
    const m = makeMission([task('a')])
    // verify passes but commit is rejected on both attempts → task + mission fail, never "done".
    const deps = makeDeps({
      verifyResults: [true, true],
      commit: async (): Promise<CommitResult> => ({ rejected: 'pre-commit hook: lint failed' })
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(result.tasks[0].status).toBe('failed')
    expect(result.tasks[0].commit).toBeUndefined()
    expect(deps.runCalls).toBe(2) // retried once after the rejection
  })

  it('(9) a no-op commit (nothing to commit) still marks the task done', async () => {
    const m = makeMission([task('a')])
    const deps = makeDeps({ verifyResults: [true], commit: async (): Promise<CommitResult> => ({ sha: null }) })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('done')
    expect(result.tasks[0].status).toBe('done')
    expect(result.tasks[0].commit).toBeUndefined()
  })

  it('(10) resume: a previously-failed task gets a fresh attempt budget and can succeed', async () => {
    const failed = task('a', 'failed')
    failed.attempts = 2 // exhausted on the prior run
    const m = makeMission([failed])
    const deps = makeDeps({ verifyResults: [true] })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('done')
    expect(deps.runCalls).toBe(1) // it actually ran instead of bricking
    expect(result.tasks[0].status).toBe('done')
  })

  it('(11) resume: a task stuck in "running" with no commit is retried, not counted as failed', async () => {
    const stuck = task('a', 'running')
    stuck.attempts = 2 // crashed on its retry, attempts already maxed
    stuck.commit = undefined
    const m = makeMission([stuck])
    const deps = makeDeps({ verifyResults: [true] })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('done')
    expect(deps.runCalls).toBe(1) // got an attempt back (2 → 1) and ran
    expect(result.tasks[0].status).toBe('done')
  })

  it('(12) resume: a "running" task that already committed is treated as done (no re-run)', async () => {
    const committed = task('a', 'running')
    committed.commit = 'deadbee'
    const m = makeMission([committed, task('b')])
    const deps = makeDeps({ verifyResults: [true] })
    const result = await runMission(m, deps, {})
    expect(deps.runCalls).toBe(1) // only task B ran; A's committed work was NOT re-executed
    expect(result.tasks[0].status).toBe('done')
    expect(result.tasks[0].commit).toBe('deadbee')
    expect(result.status).toBe('done')
  })

  it('(13) stop pressed during the off-peak wait ends as stopped (never branded failed)', async () => {
    const m = makeMission([task('a')])
    m.waitForOffPeak = true
    saveMission(m)
    const ac = new AbortController()
    const deps = makeDeps({
      signal: ac.signal,
      inOffPeak: () => false, // never in window → would wait forever
      ensureBranch: async () => {
        throw new Error('should not reach ensureBranch')
      }
    })
    // abort almost immediately, while the off-peak loop is holding
    setTimeout(() => ac.abort(), 5)
    const result = await runMission(m, deps, { waitForOffPeak: true })
    expect(result.status).toBe('stopped')
    expect(deps.runCalls).toBe(0)
  })

  it('emits mission events scoped to the mission id', async () => {
    const m = makeMission([task('a')])
    const events: { status: string; missionId: string }[] = []
    const deps = makeDeps({
      verifyResults: [true],
      emit: (e) => {
        if (e.type === 'mission') events.push({ status: e.status, missionId: e.missionId })
      }
    })
    await runMission(m, deps, {})
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.missionId === m.id)).toBe(true)
    expect(events.some((e) => e.status === 'done')).toBe(true)
  })
})

describe('generatePlan', () => {
  it('parses + coerces a tasks array into MissionTasks', async () => {
    const json = JSON.stringify({ tasks: [{ title: 'Step 1', instruction: 'do x' }, { title: 'Step 2', instruction: 'do y' }] })
    const tasks = await generatePlan('build it', async () => json)
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ title: 'Step 1', instruction: 'do x', status: 'pending', attempts: 0 })
    expect(tasks.every((t) => typeof t.id === 'string' && t.id.length > 0)).toBe(true)
  })

  it('tolerates a fenced JSON block', () => {
    const raw = parsePlanJson('```json\n{"tasks":[{"instruction":"a"}]}\n```')
    expect(raw).toHaveLength(1)
  })

  it('caps at 8 tasks and drops empty instructions', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, instruction: i === 3 ? '' : `inst ${i}` }))
    const coerced = coercePlan(many)
    expect(coerced.length).toBe(8)
    expect(coerced.every((t) => t.instruction.trim().length > 0)).toBe(true)
  })

  it('throws a clear error when the model output is unusable', async () => {
    await expect(generatePlan('build it', async () => 'sorry, no JSON here')).rejects.toThrow(/Plan/)
    await expect(generatePlan('build it', async () => '{"tasks":[]}')).rejects.toThrow(/Plan|konkreter/i)
  })

  it('rejects an empty goal', async () => {
    await expect(generatePlan('', async () => '{}')).rejects.toThrow(/Ziel/)
  })
})

describe('mission store', () => {
  it('rejects traversal / unsafe ids', () => {
    for (const id of ['../../settings', '..\\..\\settings', 'a/b', '']) {
      expect(() => getMission(id)).toThrow(/invalid mission id/)
      expect(() => deleteMission(id)).toThrow(/invalid mission id/)
    }
  })
})
