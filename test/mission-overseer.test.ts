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

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS } from '../src/main/paths'
import { runMission, OverseerDeps, CommitResult, readyTasks, validateDag } from '../src/main/missions/overseer'
import { getMission, saveMission, deleteMission } from '../src/main/missions/store'
import { generatePlan, replan, parsePlanJson, coercePlan } from '../src/main/missions/plan'
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
// (the last entry repeats once exhausted, so a single [false] means "always fails"). `replan` lets
// a test inject remediation tasks (default: [] = give up → halt). `replanCalls`/`commits` are read
// via getters so a test can assert how often the overseer asked for a replan / committed.
type StubDeps = OverseerDeps & { runCalls: number; verifyCalls: number; replanCalls: number; commits: string[]; milestones: string[] }
function makeDeps(over: Partial<OverseerDeps> & { verifyResults?: boolean[] } = {}): StubDeps {
  const counters = { runCalls: 0, verifyCalls: 0, replanCalls: 0, commits: [] as string[], milestones: [] as string[] }
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
      (async (_cwd: string, msg: string, milestone?: string) => {
        counters.commits.push(msg)
        if (milestone) counters.milestones.push(milestone)
        return { sha: `c${counters.commits.length}`, branch: milestone }
      }),
    treeStatus: over.treeStatus ?? (async () => ''), // clean tree by default
    discardChanges: over.discardChanges ?? (async () => {}), // no-op tree discard by default
    replan:
      over.replan ??
      (async () => {
        counters.replanCalls++
        return [] // default: no remediation → the overseer halts loudly
      }),
    emit: over.emit ?? (() => {}),
    overDailyCap: over.overDailyCap ?? (() => false),
    inOffPeak: over.inOffPeak ?? (() => true),
    signal: over.signal ?? new AbortController().signal
  } as OverseerDeps
  return Object.defineProperties(deps as StubDeps, {
    runCalls: { get: () => counters.runCalls },
    verifyCalls: { get: () => counters.verifyCalls },
    replanCalls: { get: () => counters.replanCalls },
    commits: { get: () => counters.commits },
    milestones: { get: () => counters.milestones }
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

  it('(3c) Stop pressed DURING a replan round halts cleanly (no "fehlgeschlagen" message, no throw)', async () => {
    // engine.complete now receives the overseer signal, so a Stop pressed while the replan round is
    // in flight aborts the billed call → it surfaces as a thrown error inside tryReplan. The overseer
    // must treat that as the same clean halt as the post-call abort check, NOT a replan failure.
    const m = makeMission([task('a')])
    const ac = new AbortController()
    const msgs: string[] = []
    const deps = makeDeps({
      verifyResults: [false], // task 'a' exhausts its retries → triggers a replan
      signal: ac.signal,
      emit: (e) => {
        const msg = (e as { message?: string }).message
        if (msg) msgs.push(msg)
      },
      // simulate Stop landing during the billed replan round: the threaded signal aborts mid-call,
      // which engine.complete/streamChat raise as a throw.
      replan: async () => {
        ac.abort()
        throw new Error('Aborted')
      }
    })
    const result = await runMission(m, deps, {})
    // resolves to a terminal status without an unhandled rejection / loop (current branding: failed)
    expect(result.status).toBe('failed')
    // the abort is a clean halt — never reported as a replan failure
    expect(msgs.some((t) => /Umplanung fehlgeschlagen/.test(t))).toBe(false)
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

  // ---- V2: DAG / ready-based ordering + bounded replan ----

  it('(14) runs tasks by DAG readiness (deps), not array order', async () => {
    // array order is [c, a, b] but deps force a -> b -> c. The overseer must run a, b, c.
    const a = task('a')
    const b = task('b')
    const c = task('c')
    b.deps = [a.id]
    c.deps = [b.id]
    const order: string[] = []
    const m = makeMission([c, a, b])
    const deps = makeDeps({
      verifyResults: [true, true, true],
      runTask: async (_mission, t) => {
        order.push(t.title)
        return { summary: 'did it', tokens: 1, cost: 0 }
      }
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('done')
    expect(order).toEqual(['a', 'b', 'c'])
    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
  })

  it('(15) a dependency cycle fails the mission closed without running anything', async () => {
    const a = task('a')
    const b = task('b')
    a.deps = [b.id]
    b.deps = [a.id] // cycle
    const m = makeMission([a, b])
    const deps = makeDeps({ verifyResults: [true] })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(deps.runCalls).toBe(0) // never ran
    expect(deps.commits).toHaveLength(0)
  })

  it('(15b) a dep on a missing task id fails the mission closed without running anything', async () => {
    const a = task('a')
    a.deps = ['no-such-task']
    const m = makeMission([a])
    const deps = makeDeps({ verifyResults: [true] })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(deps.runCalls).toBe(0)
    expect(deps.commits).toHaveLength(0)
  })

  it('(16) a failed task triggers ONE replan whose remediation runs, then the goal retries', async () => {
    const goal = task('goal')
    const m = makeMission([goal])
    // verify: goal fails twice (exhausts) → replan inserts a fix → fix passes → goal passes.
    // sequence of verify calls: F, F (goal attempts) | T (fix) | T (goal retry)
    const deps = makeDeps({
      verifyResults: [false, false, true, true],
      replan: async () => [
        { id: randomUUID(), title: 'fix it', instruction: 'repair the thing', status: 'pending', attempts: 0 } as MissionTask
      ]
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('done')
    // one remediation task inserted + the original goal, both done
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks.some((t) => t.kind === 'remediation' && t.status === 'done')).toBe(true)
    expect(result.tasks.find((t) => t.title === 'goal')!.status).toBe('done')
    expect(result.replansUsed).toBe(1)
    expect(deps.commits).toHaveLength(2) // fix + goal both committed
  })

  it('(17) replan budget exhaustion halts the mission (no infinite replanning)', async () => {
    const goal = task('goal')
    const m = makeMission([goal])
    m.maxReplans = 2
    saveMission(m)
    let replanCalls = 0
    // every verify fails forever; each replan inserts a fresh fix that also fails. Bounded by
    // maxReplans=2 → at most 2 replans, then HALT. Must terminate, not loop.
    const deps = makeDeps({
      verifyResults: [false], // always fail
      replan: async () => {
        replanCalls++
        return [{ id: randomUUID(), title: `fix${replanCalls}`, instruction: 'try again', status: 'pending', attempts: 0 } as MissionTask]
      }
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(replanCalls).toBe(2) // replanned exactly maxReplans times, then halted
    expect(result.replansUsed).toBe(2)
  })

  it('(18) replan returning [] (unsatisfiable) halts the mission loudly', async () => {
    const goal = task('goal')
    const m = makeMission([goal])
    const deps = makeDeps({
      verifyResults: [false], // goal always fails → exhausts → replan
      replan: async () => [] // give up
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(deps.replanCalls).toBe(0) // we passed our own replan; default counter untouched
    expect(result.replansUsed ?? 0).toBe(0) // [] is not a successful replan → budget not consumed beyond the attempt
    expect(result.tasks[0].status).toBe('failed')
  })

  it('(18b) daily cap crossed when a task fails gates the replan (no billed replan past the ceiling)', async () => {
    const goal = task('goal')
    const m = makeMission([goal])
    let attempts = 0
    // goal verify always fails → exhausts after 2 attempts; cap flips on once the task has failed, so
    // it is over the cap by the time tryReplan would fire. The replan dep must NOT be called.
    const deps = makeDeps({
      verifyResults: [false],
      overDailyCap: () => attempts >= 2, // false during the 2 attempts, true at replan time
      runTask: async () => {
        attempts++
        return { summary: 'x', tokens: 0, cost: 0 }
      },
      replan: async () => [
        { id: randomUUID(), title: 'fix', instruction: 'repair', status: 'pending', attempts: 0 } as MissionTask
      ]
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(deps.replanCalls).toBe(0) // the paid replan completion was NEVER issued past the cap
    expect(result.replansUsed ?? 0).toBe(0)
  })

  it('(18c) the added-task cap is a LIFETIME bound: existing remediation tasks count on resume', async () => {
    // simulate a restart of a mission that already grew by 2 remediation tasks. originalCount derives
    // from the NON-remediation tasks (1), so maxAddedTasks = 2 and addedTasks resumes at 2 → already
    // at the cap. A further failure must HALT on the added-task cap, never insert more.
    const goal = task('goal')
    const rem1: MissionTask = { id: randomUUID(), title: 'r1', instruction: 'r', status: 'done', attempts: 1, kind: 'remediation', commit: 'aaa' }
    const rem2: MissionTask = { id: randomUUID(), title: 'r2', instruction: 'r', status: 'done', attempts: 1, kind: 'remediation', commit: 'bbb' }
    const m = makeMission([goal, rem1, rem2])
    m.maxReplans = 5 // budget NOT the limiting factor — the added-task cap must be
    m.replansUsed = 2
    saveMission(m)
    let replanCalls = 0
    const deps = makeDeps({
      verifyResults: [false], // goal fails → would want to replan
      replan: async () => {
        replanCalls++
        return [{ id: randomUUID(), title: 'r3', instruction: 'r', status: 'pending', attempts: 0 } as MissionTask]
      }
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(replanCalls).toBe(0) // added-task cap already reached on resume → no further growth
    expect(result.tasks.filter((t) => t.kind === 'remediation')).toHaveLength(2) // no new ones inserted
  })

  it('(18d) a throw from verify() is a failed attempt, not an escaped rejection leaving "running"', async () => {
    const m = makeMission([task('a')])
    const deps = makeDeps({
      verify: async () => {
        throw new Error('git spawn EPERM')
      }
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed') // durable terminal status, not stuck 'running'
    expect(result.tasks[0].status).toBe('failed')
    expect(deps.runCalls).toBe(2) // retried after the verify throw, then failed
    expect(getMission(m.id)!.status).toBe('failed')
  })

  it('(18e) a throw from commit() after a green verify retries, then fails durably', async () => {
    const m = makeMission([task('a')])
    const deps = makeDeps({
      verifyResults: [true, true],
      commit: async () => {
        throw new Error('git commit spawn failed')
      }
    })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('failed')
    expect(result.tasks[0].status).toBe('failed')
    expect(result.tasks[0].commit).toBeUndefined()
    expect(deps.runCalls).toBe(2) // retried after the commit throw
    expect(getMission(m.id)!.status).toBe('failed')
  })

  it('(19) records a per-milestone branch on each verified task', async () => {
    const m = makeMission([task('first thing'), task('second thing')])
    const deps = makeDeps({ verifyResults: [true, true] })
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('done')
    expect(deps.milestones).toHaveLength(2)
    // sibling namespace ("--m<n>-"), NOT a child segment ("/m<n>-") that would D/F-conflict in git
    expect(result.tasks[0].branch).toMatch(/--m1-first-thing$/)
    expect(result.tasks[1].branch).toMatch(/--m2-second-thing$/)
    // persisted to disk too
    expect(getMission(m.id)!.tasks[0].branch).toMatch(/--m1-/)
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

  it('emits DAG tasks: remaps model dep ids onto minted ids', async () => {
    const json = JSON.stringify({
      tasks: [
        { id: 't1', title: 'A', instruction: 'do a', deps: [] },
        { id: 't2', title: 'B', instruction: 'do b', deps: ['t1'] }
      ]
    })
    const tasks = await generatePlan('build it', async () => json)
    expect(tasks).toHaveLength(2)
    expect(tasks[0].deps).toEqual([]) // first task has no deps
    expect(tasks[1].deps).toEqual([tasks[0].id]) // remapped from 't1' to the minted id
    expect(tasks.every((t) => t.kind === 'task')).toBe(true)
    // minted ids are not the model's local ids
    expect(tasks[0].id).not.toBe('t1')
  })

  it('drops a dep pointing at an unknown / dropped task id', async () => {
    const coerced = coercePlan([
      { id: 'a', title: 'A', instruction: 'do a', deps: ['ghost'] },
      { id: 'b', title: 'B', instruction: '', deps: [] } // dropped (empty instruction)
    ])
    expect(coerced).toHaveLength(1)
    expect(coerced[0].deps).toEqual([]) // 'ghost' (and the dropped 'b') resolve to nothing
  })
})

describe('replan', () => {
  const failed: MissionTask = { id: 'x', title: 'goal', instruction: 'do goal', status: 'failed', attempts: 2 }
  it('coerces remediation tasks tagged kind=remediation', async () => {
    const json = JSON.stringify({ tasks: [{ id: 'fix1', title: 'Fix', instruction: 'repair' }] })
    const r = await replan('build it', [failed], failed, 'verify failed', async () => json)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ title: 'Fix', instruction: 'repair', kind: 'remediation', status: 'pending', attempts: 0 })
  })

  it('returns [] when the planner gives no remediation (unsatisfiable)', async () => {
    expect(await replan('g', [failed], failed, 'fail', async () => '{"tasks":[]}')).toEqual([])
  })

  it('returns [] on unparseable output instead of throwing (overseer treats it as give-up)', async () => {
    expect(await replan('g', [failed], failed, 'fail', async () => 'sorry no json')).toEqual([])
  })

  it('returns [] when the planner call throws', async () => {
    expect(
      await replan('g', [failed], failed, 'fail', async () => {
        throw new Error('boom')
      })
    ).toEqual([])
  })
})

describe('DAG pure helpers', () => {
  const t = (id: string, status: MissionTask['status'], deps: string[] = []): MissionTask => ({
    id,
    title: id,
    instruction: `do ${id}`,
    status,
    attempts: 0,
    deps
  })

  it('readyTasks returns only pending tasks whose deps are all done, in array order', () => {
    const tasks = [t('a', 'done'), t('b', 'pending', ['a']), t('c', 'pending', ['b']), t('d', 'pending', ['a'])]
    const ready = readyTasks(tasks)
    expect(ready.map((x) => x.id)).toEqual(['b', 'd']) // c waits on b (still pending); a is done
  })

  it('readyTasks ignores done/running/failed tasks', () => {
    const tasks = [t('a', 'running'), t('b', 'failed'), t('c', 'done'), t('d', 'pending')]
    expect(readyTasks(tasks).map((x) => x.id)).toEqual(['d'])
  })

  it('validateDag passes a valid DAG and rejects cycles + missing deps', () => {
    expect(validateDag([t('a', 'pending'), t('b', 'pending', ['a'])])).toBeNull()
    expect(validateDag([t('a', 'pending', ['b']), t('b', 'pending', ['a'])])).toMatch(/[Zz]yklus/)
    expect(validateDag([t('a', 'pending', ['ghost'])])).toMatch(/unbekannte/)
    expect(validateDag([t('a', 'pending', ['a'])])).toMatch(/sich selbst/)
  })
})

// ---- REAL-GIT integration: the deps the stubs mask. Drives the overseer against an actual git repo
// with the SAME commit / ensureBranch / treeStatus / discardChanges shape the ipc layer supplies, so
// a git D/F ref conflict (child milestone segment under the base branch) or a missing discard is
// caught instead of stubbed away. Skips cleanly if git isn't on PATH.
let GIT_OK = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  GIT_OK = false
}

describe.skipIf(!GIT_OK)('runMission against real git', () => {
  const REPOS = join(HOME, 'repos')
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  function makeRepo(): string {
    mkdirSync(REPOS, { recursive: true })
    const cwd = join(REPOS, randomUUID())
    mkdirSync(cwd)
    git(cwd, ['init', '-q'])
    git(cwd, ['config', 'user.email', 't@t.t'])
    git(cwd, ['config', 'user.name', 't'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(cwd, 'seed.txt'), 'seed\n')
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'init'])
    return cwd
  }

  // The git-backed deps, mirroring makeOverseerDeps in ipc.ts (minus electron). runTask writes a file
  // so each task produces real working-tree changes for commit/discard to act on.
  function realGitDeps(cwd: string, verifyResults: boolean[]): StubDeps {
    const signal = new AbortController().signal
    const runGit = async (args: string[]): Promise<{ code: number; out: string }> => {
      try {
        return { code: 0, out: git(cwd, args) }
      } catch (e) {
        const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
        return { code: err.status ?? 1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
      }
    }
    let fileN = 0
    const counters = { runCalls: 0, verifyCalls: 0, replanCalls: 0, commits: [] as string[], milestones: [] as string[] }
    const deps = {
      runTask: async () => {
        counters.runCalls++
        writeFileSync(join(cwd, `task-${++fileN}.txt`), `work ${fileN}\n`)
        return { summary: 'did it', tokens: 1, cost: 0 }
      },
      verify: async () => {
        const ok = verifyResults.length ? verifyResults[Math.min(counters.verifyCalls, verifyResults.length - 1)] : true
        counters.verifyCalls++
        return { ok, summary: ok ? 'pass' : 'FAIL' }
      },
      ensureBranch: async (_c: string, branch: string) => {
        const ex = await runGit(['rev-parse', '--verify', branch])
        const r = ex.code === 0 ? await runGit(['checkout', branch]) : await runGit(['checkout', '-b', branch])
        if (r.code !== 0 && !/already on/i.test(r.out)) throw new Error(`checkout ${branch}: ${r.out}`)
      },
      commit: async (_c: string, message: string, milestone?: string): Promise<CommitResult> => {
        await runGit(['add', '-A'])
        const c = await runGit(['commit', '-m', message])
        counters.commits.push(message)
        if (c.code === 0) {
          const sha = await runGit(['rev-parse', '--short', 'HEAD'])
          let branch: string | undefined
          if (milestone) {
            const b = await runGit(['branch', '-f', milestone])
            if (b.code === 0) {
              branch = milestone
              counters.milestones.push(milestone)
            }
          }
          return { sha: sha.code === 0 ? sha.out.trim() : null, branch }
        }
        const st = await runGit(['status', '--porcelain'])
        if (st.code === 0 && !st.out.trim()) return { sha: null }
        return { rejected: c.out.trim() }
      },
      treeStatus: async () => (await runGit(['status', '--porcelain'])).out,
      discardChanges: async () => {
        await runGit(['reset', '--hard', 'HEAD'])
        await runGit(['clean', '-fd'])
      },
      replan: async () => {
        counters.replanCalls++
        return []
      },
      emit: () => {},
      overDailyCap: () => false,
      inOffPeak: () => true,
      signal
    } as OverseerDeps
    return Object.defineProperties(deps as StubDeps, {
      runCalls: { get: () => counters.runCalls },
      verifyCalls: { get: () => counters.verifyCalls },
      replanCalls: { get: () => counters.replanCalls },
      commits: { get: () => counters.commits },
      milestones: { get: () => counters.milestones }
    })
  }

  it('(20) milestone branches are actually CREATED in git (no D/F ref conflict with the base branch)', async () => {
    const cwd = makeRepo()
    const m = makeMission([task('add tests'), task('wire it up')])
    m.cwd = cwd
    saveMission(m)
    const deps = realGitDeps(cwd, [true, true])
    const result = await runMission(m, deps, {})

    expect(result.status).toBe('done')
    // each verified task recorded a milestone branch that REALLY EXISTS in git (the old child-segment
    // namespace "mission/<id>/m1-…" would have failed with a D/F conflict → task.branch undefined).
    const branches = git(cwd, ['branch', '--list']).split('\n').map((s) => s.replace(/^[*+ ]+/, '').trim()).filter(Boolean)
    expect(result.tasks[0].branch).toBeTruthy()
    expect(result.tasks[1].branch).toBeTruthy()
    expect(branches).toContain(result.tasks[0].branch)
    expect(branches).toContain(result.tasks[1].branch)
    // sibling namespace, not a child of the base branch
    expect(result.tasks[0].branch).toMatch(/--m1-add-tests$/)
    expect(branches).toContain(`mission/${m.id}`)
  })

  it('(21) a failed task discards its uncommitted edits → halted mission leaves a CLEAN tree', async () => {
    const cwd = makeRepo()
    const goal = task('do goal')
    const m = makeMission([goal])
    m.cwd = cwd
    m.maxReplans = 0 // no replan → fail straight to halt
    saveMission(m)
    const deps = realGitDeps(cwd, [false]) // verify always fails → task fails, edits never committed
    const result = await runMission(m, deps, {})

    expect(result.status).toBe('failed')
    // the failed task wrote task-1.txt but it was never committed; the halt must have discarded it.
    expect(existsSync(join(cwd, 'task-1.txt'))).toBe(false)
    expect(git(cwd, ['status', '--porcelain']).trim()).toBe('') // clean tree → resumable, non-blocking
  })

  it('(22) replan remediation commit does NOT absorb the failed task’s rejected edits', async () => {
    const cwd = makeRepo()
    const goal = task('goal')
    const m = makeMission([goal])
    m.cwd = cwd
    saveMission(m)
    // goal fails twice (writes task-1, task-2; both discarded) → replan inserts a fix that passes.
    // The fix's commit must contain ONLY the fix's own file, never the goal's discarded task-*.txt.
    const deps = realGitDeps(cwd, [false, false, true, true])
    ;(deps as { replan: OverseerDeps['replan'] }).replan = async () => [
      { id: randomUUID(), title: 'fix it', instruction: 'repair', status: 'pending', attempts: 0 } as MissionTask
    ]
    const result = await runMission(m, deps, {})
    expect(result.status).toBe('done')
    const fix = result.tasks.find((t) => t.kind === 'remediation')!
    // files in the remediation commit = its own diff against the parent: no task-1/2.txt leaked in.
    const filesInFixCommit = git(cwd, ['show', '--name-only', '--pretty=format:', fix.commit!]).trim().split('\n').filter(Boolean)
    expect(filesInFixCommit.some((f) => /^task-[12]\.txt$/.test(f))).toBe(false)
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
