import { Mission, MissionTask, AgentEvent } from '@shared/types'
import { saveMission, updateMissionTask } from './store'

// The Mission Control OUTER loop. Pure logic over OverseerDeps — NO electron/engine imports — so
// the gate/retry/halt/DAG/replan invariants are unit-tested against stubbed deps.
//
// V2 is a branching DAG: each task carries deps (ids of prerequisites). The overseer runs a READY
// task (all deps done) instead of strict array order — topological progress. A task is 'done' ONLY
// when deps.verify() reports ok — NEVER on the LLM's say-so. On pass → commit to the mission branch
// (+ a per-milestone branch pointer recorded on task.branch). On exhaustion → if replan budget is
// left, ask deps.replan() for remediation tasks that run BEFORE re-attempting the failed goal (also
// machine-verified); otherwise HALT the whole loop loudly. Replanning is bounded (maxReplans + a
// hard cap on total tasks added) and HALTS if it returns nothing / makes no progress — never loops
// unbounded. State is persisted after EVERY change so a restart resumes: done tasks are skipped and
// never re-run/re-committed.

// commit() outcome: a sha + the milestone branch pointer created at it when a commit landed; { sha:
// null } for a genuine no-op (nothing to commit, tree clean); or 'rejected' when `git commit` exited
// non-zero with a still-dirty tree (a pre-commit hook blocked it). The rejected case must NOT be
// silently treated as done — its work never landed. `branch` (milestone pointer name) is optional so
// a no-op or a deps stub that doesn't create one is still valid.
export type CommitResult = { sha: string; branch?: string } | { sha: null } | { rejected: string }

export interface OverseerDeps {
  runTask: (mission: Mission, task: MissionTask, feedback?: string) => Promise<{ summary: string; tokens: number; cost: number }>
  verify: (command: string, cwd: string) => Promise<{ ok: boolean; summary: string }>
  ensureBranch: (cwd: string, branch: string) => Promise<void>
  // commit the verified task's work. `milestone` is the per-milestone branch name the ipc layer
  // should also point at this commit (LOCAL only) and echo back in CommitResult.branch so the
  // overseer can record it on task.branch.
  commit: (cwd: string, message: string, milestone?: string) => Promise<CommitResult>
  // working tree status BEFORE the run — a non-empty list means uncommitted user work that `git add
  // -A` would otherwise sweep into a mission commit. Used to fail closed on a dirty tree.
  treeStatus: (cwd: string) => Promise<string>
  // discard the working tree back to the last verified commit (HEAD). Called when a task FAILS or the
  // mission HALTS so a failed task's never-verified, rejected edits can't bleed into the NEXT
  // (remediation) commit via `git add -A`, and so a halted mission leaves a clean tree (otherwise the
  // start-time clean-tree gate would make it un-resumable AND silently block every other scheduled
  // mission on that cwd). Safe here: the only uncommitted content is the just-failed mission task's
  // own work — the start gate guaranteed a clean tree and every PRIOR task committed.
  discardChanges: (cwd: string) => Promise<void>
  // V2 REPLAN: when a task exhausts its retries and budget remains, return remediation MissionTasks
  // to insert (wired with deps so they run BEFORE re-attempting the failed goal). [] = unsatisfiable
  // / give up → the overseer HALTS. The overseer enforces all budget caps; the dep just proposes.
  replan: (mission: Mission, failedTask: MissionTask, failure: string) => Promise<MissionTask[]>
  emit: (e: AgentEvent) => void
  overDailyCap: () => boolean
  inOffPeak: () => boolean
  signal: AbortSignal
}

const MAX_TASK_ATTEMPTS = 2 // first try + ONE retry with feedback
const DEFAULT_MAX_REPLANS = 2 // how many times a mission may replan before halting

// Outcome of running one task to completion (across its attempts). Lets the outer loop tell a
// real verify failure (→ replan or 'failed') apart from a user/cap stop (→ mission 'stopped')
// without guessing from a bare boolean + signal.aborted.
type TaskOutcome = 'done' | 'failed' | 'stopped'

// A short, url-safe slug for the per-milestone branch segment (mission/<id>--m<n>-<slug>).
function slug(s: string): string {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'task'
  )
}

// PURE: the pending tasks whose every dep is 'done' (ignores deps pointing at unknown ids — the
// DAG validator rejects those up front, so by the time this runs every dep resolves). Returned in
// the tasks' array order so a deterministic, stable pick survives across resume/persist. Exported
// for unit tests of the topological readiness rule.
export function readyTasks(tasks: MissionTask[]): MissionTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return tasks.filter((t) => {
    if (t.status !== 'pending') return false
    const deps = Array.isArray(t.deps) ? t.deps : []
    return deps.every((d) => byId.get(d)?.status === 'done')
  })
}

// PURE: validate the DAG before running a single task. Returns an error string (fail closed) for a
// dep on a MISSING id or any dependency CYCLE; null when the graph is a valid DAG. Exported for
// unit tests. A non-pending (already done) task with a now-missing dep is still rejected — a
// corrupt plan must never run on a broken foundation.
export function validateDag(tasks: MissionTask[]): string | null {
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks) {
    for (const d of Array.isArray(t.deps) ? t.deps : []) {
      if (!ids.has(d)) return `Aufgabe "${t.title}" hängt von einer unbekannten Aufgabe ab (${String(d).slice(0, 40)}).`
      if (d === t.id) return `Aufgabe "${t.title}" hängt von sich selbst ab.`
    }
  }
  // DFS cycle detection (white/grey/black coloring).
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const state = new Map<string, 0 | 1 | 2>() // 0 unvisited, 1 on-stack, 2 done
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0
    if (s === 1) return true // back-edge → cycle
    if (s === 2) return false
    state.set(id, 1)
    for (const d of byId.get(id)?.deps ?? []) {
      if (visit(d)) return true
    }
    state.set(id, 2)
    return false
  }
  for (const t of tasks) {
    if (visit(t.id)) return `Der Aufgabenplan enthält einen Abhängigkeitszyklus (bei "${t.title}").`
  }
  return null
}

export async function runMission(
  mission: Mission,
  deps: OverseerDeps,
  opts: { waitForOffPeak?: boolean }
): Promise<Mission> {
  const emit = (status: string, message?: string, taskId?: string): void =>
    deps.emit({ type: 'mission', missionId: mission.id, taskId, status, message })

  // Fail closed on a missing machine gate: without a real verify command every task would auto-pass
  // the gate (an empty shell exits 0) and get committed with ZERO verification. Refuse to run.
  if (!mission.verifyCommand || !mission.verifyCommand.trim()) {
    mission.status = 'failed'
    saveMission(mission)
    emit('failed', '❌ Kein Verify-Befehl gesetzt — eine Mission ohne maschinelle Abnahme wird nicht ausgeführt.')
    return mission
  }

  mission.status = 'running'
  mission.lastRunAt = Date.now()
  saveMission(mission)
  emit('running', `🎯 Mission gestartet: ${mission.goal.slice(0, 80)}`)

  // Resume normalization (crash / restart recovery). attempts is PERSISTED and was incremented at
  // the START of an attempt, so a task left 'running' was interrupted mid-flight and never
  // adjudicated — give that attempt back rather than counting it as a verify failure. A previously
  // 'failed' task gets a fresh attempt budget so a restart after the user fixes the root cause can
  // make progress instead of bricking the mission forever.
  for (const t of mission.tasks) {
    if (t.status === 'running') {
      if (t.commit) {
        // crashed AFTER its commit landed (durable in git) but BEFORE persisting 'done'. Re-running
        // the LLM instruction would double-apply non-idempotent work and create a second commit, so
        // treat the already-committed work as done instead of re-dispatching the turn.
        t.status = 'done'
        updateMissionTask(mission.id, t.id, { status: 'done', commit: t.commit })
      } else {
        // interrupted mid-attempt and never adjudicated — give that started-but-unfinished attempt
        // back rather than counting it as a verify failure.
        t.status = 'pending'
        t.attempts = Math.max(0, t.attempts - 1)
        updateMissionTask(mission.id, t.id, { status: 'pending', attempts: t.attempts })
      }
    } else if (t.status === 'failed') {
      // fresh attempt budget on resume so a restart (after the user fixes the root cause) can make
      // progress instead of bricking the mission on a permanently-exhausted task.
      t.status = 'pending'
      t.attempts = 0
      updateMissionTask(mission.id, t.id, { status: 'pending', attempts: 0 })
    }
  }

  // optionally hold until DeepSeek's off-peak discount window opens (honors stop/abort). The sleep
  // is raced against the abort signal so a Stop pressed mid-wait unwinds promptly instead of after
  // the full poll interval.
  if (opts.waitForOffPeak) {
    while (!deps.inOffPeak() && !deps.signal.aborted) {
      emit('waiting', '🌙 Mission wartet auf das DeepSeek-Off-Peak-Fenster…')
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          deps.signal.removeEventListener('abort', onWake)
          r()
        }, 60_000)
        function onWake(): void {
          clearTimeout(t)
          r()
        }
        deps.signal.addEventListener('abort', onWake, { once: true })
      })
    }
  }

  // A stop pressed during the off-peak wait is a STOP, not a failure — bail BEFORE ensureBranch,
  // which on an already-aborted signal would throw and brand the user's stop as 'failed'.
  if (deps.signal.aborted) {
    mission.status = 'stopped'
    saveMission(mission)
    emit('stopped', '⏹ Mission gestoppt.')
    return mission
  }

  // Hard clean-tree gate: `git add -A` on commit would otherwise stage the user's pre-existing
  // uncommitted work (and, if cwd is a subdir of a larger repo, the whole repo) and bury it in an
  // autonomously-authored 'mission:' commit nobody reviewed. Refuse to start on a dirty tree — the
  // UI hint alone can't protect an unattended/headless run.
  try {
    const dirty = (await deps.treeStatus(mission.cwd)).trim()
    if (dirty) {
      mission.status = 'failed'
      saveMission(mission)
      emit('failed', '❌ Arbeitsbaum nicht sauber — committe oder stashe deine Änderungen, bevor die Mission startet.')
      return mission
    }
  } catch (e) {
    mission.status = 'failed'
    saveMission(mission)
    emit('failed', `❌ Arbeitsbaum konnte nicht geprüft werden: ${(e as Error).message}`)
    return mission
  }

  // DAG gate (fail closed): a dep on a missing id, a self-dep, or any cycle would make readyTasks
  // either never advance (deadlock) or run on a broken foundation. Refuse to start — never on a
  // corrupt plan. Checked AFTER resume normalization so a recovered plan is validated as it will run.
  const dagError = validateDag(mission.tasks)
  if (dagError) {
    mission.status = 'failed'
    saveMission(mission)
    emit('failed', `❌ Ungültiger Aufgabenplan — ${dagError}`)
    return mission
  }

  const branch = mission.branch ?? `mission/${mission.id}`
  try {
    await deps.ensureBranch(mission.cwd, branch)
  } catch (e) {
    mission.status = 'failed'
    mission.branch = branch
    saveMission(mission)
    emit('failed', `❌ Branch "${branch}" konnte nicht angelegt werden: ${(e as Error).message}`)
    return mission
  }
  mission.branch = branch
  saveMission(mission)

  // Hard cap on REPLAN growth: never let remediation insertion balloon the plan. Bounded both by
  // maxReplans (default 2) AND by total tasks added (≈ the original task count, so a plan can at most
  // roughly double). The combination guarantees the loop terminates: every iteration either finishes
  // a ready task (→ fewer pending), halts, or consumes one of a finite number of replan slots.
  //
  // LIFETIME (not per-process) bound: derive both counts from the PERSISTED plan so a crash/restart
  // can't re-base the cap on the already-enlarged plan and hand out a fresh budget. Remediation tasks
  // are the ones a replan added; the rest are the original plan. So originalCount excludes them and
  // addedTasks resumes from however many already landed — the cap survives restart.
  const maxReplans = typeof mission.maxReplans === 'number' && mission.maxReplans >= 0 ? mission.maxReplans : DEFAULT_MAX_REPLANS
  let addedTasks = mission.tasks.filter((t) => t.kind === 'remediation').length
  const originalCount = mission.tasks.length - addedTasks
  const maxAddedTasks = Math.max(1, originalCount) * 2

  // READY-based DAG loop: pick the next runnable task (all deps done) instead of strict array order.
  // Done tasks are inherently skipped (readyTasks only returns 'pending'), so resume is automatic.
  for (;;) {
    // stop / abort / daily cap are checked BEFORE each task so we never start one we can't finish.
    if (deps.signal.aborted) {
      mission.status = 'stopped'
      saveMission(mission)
      emit('stopped', '⏹ Mission gestoppt.')
      return mission
    }
    if (deps.overDailyCap()) {
      mission.status = 'stopped'
      saveMission(mission)
      emit('stopped', '🛑 Mission gestoppt — Tagesbudget erreicht.')
      return mission
    }

    const ready = readyTasks(mission.tasks)
    if (ready.length === 0) {
      // No runnable task. Either everything finished (→ done) or some pending task is permanently
      // blocked. With a validated DAG + replan halting on failure, a blocked-but-not-failed state
      // can't arise, so an empty ready set with no pending tasks means success.
      if (mission.tasks.every((t) => t.status === 'done')) break
      // Defensive: pending tasks remain but none are ready (should be unreachable post-validation).
      // Fail closed rather than spin.
      mission.status = 'failed'
      saveMission(mission)
      emit('failed', '❌ Mission abgebrochen — kein lauffähiger Schritt mehr (blockierter Plan).')
      return mission
    }

    const task = ready[0]
    const outcome = await runTaskWithRetry(mission, task, deps, emit)
    if (outcome === 'stopped') {
      // a mid-task abort or a daily-cap hit between attempts is a STOP, not a verify failure — don't
      // brand a user-stopped / budget-halted mission as failed.
      mission.status = 'stopped'
      saveMission(mission)
      emit('stopped', deps.signal.aborted ? '⏹ Mission gestoppt.' : '🛑 Mission gestoppt — Tagesbudget erreicht.')
      return mission
    }
    if (outcome === 'failed') {
      // The failed task left its never-verified (verify-rejected) edits in the working tree — nothing
      // committed them. Discard them back to HEAD BEFORE anything else: otherwise the NEXT remediation
      // task's `git add -A` would sweep this abandoned, unverified work into the remediation commit
      // (burying gate-REJECTED edits under a different task), and a final halt would leave the tree
      // dirty — making the mission un-resumable (the start-time clean-tree gate) and silently blocking
      // every other scheduled mission on this cwd. Safe: the only uncommitted content is THIS task's
      // own work (the start gate guaranteed a clean tree; every prior task committed). Best-effort —
      // a discard failure must not crash the loop; the clean-tree gate still backstops on next run.
      try {
        await deps.discardChanges(mission.cwd)
      } catch (e) {
        emit('task_retry', `⚠ Konnte die verworfenen Änderungen nicht zurücksetzen: ${(e as Error).message}`, task.id)
      }
      // Task exhausted its retry (or its work could not be committed). Before halting, try ONE
      // replan if budget remains: ask deps.replan() for remediation tasks that run BEFORE this goal
      // is re-attempted. The replan is bounded + must make progress, else we HALT loudly.
      const halted = await tryReplan(mission, task, deps, emit, {
        maxReplans,
        maxAddedTasks,
        addedTasks,
        onAdded: (n) => {
          addedTasks += n
        }
      })
      if (halted) {
        mission.status = 'failed'
        saveMission(mission)
        emit('failed', `❌ Mission abgebrochen — Aufgabe "${task.title}" hat den Verify-Gate nicht bestanden. Der Arbeitsbaum wurde auf den letzten verifizierten Commit zurückgesetzt.`, task.id)
        return mission
      }
      // replan succeeded: remediation tasks were inserted and the failed task reset to pending with
      // deps on them. Continue the loop — the remediation runs first, then the failed goal retries.
    }
  }

  mission.status = 'done'
  saveMission(mission)
  emit('done', `✅ Mission abgeschlossen: ${mission.tasks.length} Aufgabe(n) verifiziert & committet.`)
  return mission
}

// Attempt ONE bounded replan for an exhausted task. Returns TRUE when the mission must HALT (budget
// exhausted, replan returned nothing, or it made no usable progress) and FALSE when remediation was
// inserted and the failed task was reset to retry after it. Every invariant that keeps replanning
// from looping/growing unbounded lives here.
async function tryReplan(
  mission: Mission,
  failedTask: MissionTask,
  deps: OverseerDeps,
  emit: (status: string, message?: string, taskId?: string) => void,
  budget: { maxReplans: number; maxAddedTasks: number; addedTasks: number; onAdded: (n: number) => void }
): Promise<boolean> {
  const used = mission.replansUsed ?? 0
  if (used >= budget.maxReplans) {
    emit('task_retry', `🛑 Replan-Budget erschöpft (${used}/${budget.maxReplans}) — keine weitere Umplanung.`, failedTask.id)
    return true // halt
  }
  if (budget.addedTasks >= budget.maxAddedTasks) {
    emit('task_retry', '🛑 Maximale Anzahl ergänzter Aufgaben erreicht — keine weitere Umplanung.', failedTask.id)
    return true // halt
  }
  // Re-check the daily cap BEFORE the replan: deps.replan() issues a BILLED DeepSeek completion. The
  // outer loop only re-checks the cap at the TOP of the NEXT iteration — AFTER this replan already
  // spent. Without this guard every failing task could burn one extra completion past the ceiling.
  // The mission already has an unrecoverable failed task, so halt (not 'stopped') is the right outcome.
  if (deps.overDailyCap()) {
    emit('task_retry', '🛑 Tagesbudget erreicht — keine Umplanung.', failedTask.id)
    return true // halt
  }

  let remediation: MissionTask[]
  try {
    remediation = await deps.replan(mission, failedTask, failedTask.summary ?? 'Verify fehlgeschlagen.')
  } catch (e) {
    // A Stop pressed DURING the replan round now aborts the billed call in-flight (the signal is
    // threaded into engine.complete), surfacing here as an AbortError. Treat it as the same clean
    // halt the post-call check below already performs — NOT a replan failure (no scary message).
    if (deps.signal.aborted) return true
    emit('task_retry', `🛑 Umplanung fehlgeschlagen: ${(e as Error).message}`, failedTask.id)
    return true // halt
  }

  // a stop/abort during the replan LLM call → don't insert; let the outer loop register the stop.
  if (deps.signal.aborted) return true

  // [] (or junk) = the planner judges the goal unsatisfiable → HALT loudly, never loop.
  const valid = (Array.isArray(remediation) ? remediation : []).filter(
    (t) => t && typeof t.id === 'string' && t.id && typeof t.instruction === 'string' && t.instruction.trim()
  )
  if (valid.length === 0) {
    emit('task_retry', '🛑 Umplanung ergab keine Maßnahmen — Mission wird abgebrochen.', failedTask.id)
    return true // halt
  }

  // Clamp to the remaining added-task budget so a single oversized replan can't blow the cap.
  const room = budget.maxAddedTasks - budget.addedTasks
  const insert = valid.slice(0, room).map((t) => ({
    ...t,
    status: 'pending' as const,
    attempts: 0,
    kind: 'remediation' as const,
    // a remediation task's own deps are scoped to OTHER inserted ids (chain the fix steps); any dep
    // on an id we're not inserting is dropped so the remediation can actually become ready.
    deps: Array.isArray(t.deps) ? t.deps.filter((d) => valid.some((v) => v.id === d)) : []
  }))
  const insertIds = new Set(insert.map((t) => t.id))

  // Reset the failed task to pending and make it depend on the remediation, so the fix runs FIRST
  // and the goal is re-attempted (with a fresh attempt budget) only once the remediation verified.
  failedTask.status = 'pending'
  failedTask.attempts = 0
  failedTask.deps = [...new Set([...(failedTask.deps ?? []), ...insertIds])]

  mission.tasks.push(...insert)
  mission.replansUsed = used + 1

  // Re-validate: a remediation must never introduce a cycle / dangling dep. Fail closed if it does.
  const dagError = validateDag(mission.tasks)
  if (dagError) {
    emit('task_retry', `🛑 Umplanung ergab einen ungültigen Plan (${dagError}) — Mission wird abgebrochen.`, failedTask.id)
    return true // halt
  }

  budget.onAdded(insert.length)
  saveMission(mission)
  emit('task_retry', `🔁 Umplanung ${mission.replansUsed}/${budget.maxReplans}: ${insert.length} Korrektur-Aufgabe(n) eingefügt für "${failedTask.title}".`, failedTask.id)
  return false // continue — remediation will run, then the failed goal retries
}

// Run ONE task: first attempt, then ONE retry with the verify failure fed back. Returns 'done' only
// when the machine verify gate passed and the work was committed (or was a genuine no-op). Persists
// after every state change.
async function runTaskWithRetry(
  mission: Mission,
  task: MissionTask,
  deps: OverseerDeps,
  emit: (status: string, message?: string, taskId?: string) => void
): Promise<TaskOutcome> {
  let feedback: string | undefined
  while (task.attempts < MAX_TASK_ATTEMPTS) {
    if (deps.signal.aborted) return 'stopped'
    // Re-check the daily cap BEFORE every attempt (incl. the retry) — the outer-loop check only
    // gates the FIRST attempt, so without this a task could launch a second full unattended turn +
    // verify after the cap was already crossed by the first. Treat as a STOP, not a verify failure.
    if (deps.overDailyCap()) return 'stopped'
    task.attempts += 1
    task.status = 'running'
    updateMissionTask(mission.id, task.id, { status: 'running', attempts: task.attempts })
    emit('task_running', `▶ Aufgabe ${task.attempts}/${MAX_TASK_ATTEMPTS}: ${task.title}`, task.id)

    let result: { summary: string; tokens: number; cost: number }
    try {
      result = await deps.runTask(mission, task, feedback)
    } catch (e) {
      result = { summary: `Agent-Fehler: ${(e as Error).message}`, tokens: 0, cost: 0 }
    }
    task.summary = result.summary
    task.tokens = result.tokens
    task.cost = result.cost
    updateMissionTask(mission.id, task.id, { summary: task.summary, tokens: task.tokens, cost: task.cost })

    // a stop pressed DURING the agent turn lands here — don't run verify/commit on a stopped task.
    if (deps.signal.aborted) return 'stopped'

    // THE gate: only the machine verify decides 'done' — never the agent's say-so. verify shells out
    // to a test runner; a spawn failure / EPERM / abort-triggered throw must NOT escape the loop (it
    // would reject runMission and leave the mission persisted 'running' forever). Treat a verify throw
    // as a failed attempt: an abort is a STOP, otherwise feed it back and let the retry budget decide.
    let v: { ok: boolean; summary: string }
    try {
      v = await deps.verify(mission.verifyCommand, mission.cwd)
    } catch (e) {
      if (deps.signal.aborted) return 'stopped'
      feedback = `Der Verify-Befehl (${mission.verifyCommand}) konnte nicht ausgeführt werden:\n${(e as Error).message}\nBehebe die Ursache.`
      emit('task_retry', `⚠ Verify-Lauf fehlgeschlagen (Versuch ${task.attempts}/${MAX_TASK_ATTEMPTS}): ${task.title}`, task.id)
      continue
    }
    if (v.ok) {
      // per-milestone branch pointer (LOCAL only): mission/<id>--m<n>-<slug>. A FLAT suffix ("--m")
      // rather than a child segment ("/m") so the pointer is a SIBLING ref of the mission base branch
      // (refs/heads/mission/<id>) — a child segment would be a git D/F ref conflict ("refs/heads/
      // mission/<id> exists; cannot create refs/heads/mission/<id>/m1-…") and every milestone branch
      // would silently fail. n is the task's 1-based index so the reviewable stack reads in plan order.
      // The actual git branch op is ipc's job — we pass the name and record back what it returns.
      const idx = mission.tasks.findIndex((t) => t.id === task.id)
      const milestone = `${mission.branch ?? `mission/${mission.id}`}--m${idx + 1}-${slug(task.title)}`
      // commit shells out to git; a spawn failure / EPERM / abort-triggered throw must NOT escape the
      // loop (it would reject runMission and strand the mission as 'running'). Surface it like the
      // 'rejected' branch: an abort is a STOP, otherwise feed it back and retry, then fail on exhaustion.
      let c: CommitResult
      try {
        c = await deps.commit(mission.cwd, `mission: ${task.title}`, milestone)
      } catch (e) {
        if (deps.signal.aborted) return 'stopped'
        feedback = `Verify war grün, aber der Commit konnte nicht ausgeführt werden:\n${(e as Error).message}\nBehebe die Ursache, damit der Commit durchgeht.`
        emit('task_retry', `⚠ Commit fehlgeschlagen (Versuch ${task.attempts}/${MAX_TASK_ATTEMPTS}): ${task.title}`, task.id)
        continue
      }
      if ('rejected' in c) {
        // verify passed but the commit was BLOCKED (pre-commit hook) with the work still staged.
        // Do NOT mark the task done — its edits never landed and would otherwise be swept into the
        // next task's commit. Feed the hook output back and retry; halt if it persists.
        feedback = `Verify war grün, aber der Commit wurde abgelehnt (vermutlich ein pre-commit-Hook):\n${c.rejected}\nBehebe die Ursache, damit der Commit durchgeht.`
        emit('task_retry', `⚠ Commit abgelehnt (Versuch ${task.attempts}/${MAX_TASK_ATTEMPTS}): ${task.title}`, task.id)
        continue
      }
      task.status = 'done'
      task.commit = c.sha ?? undefined
      // record the per-milestone branch pointer the commit dep created (only on a real commit — a
      // no-op { sha: null } has no branch field). Lets the morning report show a reviewable stack.
      task.branch = 'branch' in c ? c.branch : undefined
      updateMissionTask(mission.id, task.id, { status: 'done', commit: task.commit, branch: task.branch })
      emit('task_done', `✅ ${task.title}${c.sha ? ` — ${c.sha}` : ''}`, task.id)
      return 'done'
    }

    // verify failed → feed the failure back for the retry (if any attempt remains)
    feedback = `Der Verify-Befehl (${mission.verifyCommand}) ist fehlgeschlagen:\n${v.summary}\nBehebe die Ursache.`
    emit('task_retry', `⚠ Verify fehlgeschlagen (Versuch ${task.attempts}/${MAX_TASK_ATTEMPTS}): ${task.title}`, task.id)
  }

  task.status = 'failed'
  updateMissionTask(mission.id, task.id, { status: 'failed' })
  return 'failed'
}
