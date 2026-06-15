import { Mission, MissionTask, AgentEvent } from '@shared/types'
import { saveMission, updateMissionTask } from './store'

// The Mission Control OUTER loop. Pure logic over OverseerDeps — NO electron/engine imports — so
// the gate/retry/halt invariants are unit-tested against stubbed deps.
//
// V1 is LINEAR: run tasks sequentially. A task is 'done' ONLY when deps.verify() reports ok —
// NEVER on the LLM's say-so. On pass → commit to the mission branch. On fail → retry ONCE with the
// failure fed back; still failing → mark the task + mission 'failed' and HALT the whole loop loudly
// (don't continue on a broken foundation, don't loop). State is persisted after EVERY change so a
// restart resumes: done tasks are skipped and never re-run/re-committed.

// commit() outcome: a sha when a commit landed, null for a genuine no-op (nothing to commit, tree
// clean), or 'rejected' when `git commit` exited non-zero with a still-dirty tree (a pre-commit
// hook blocked it). The last case must NOT be silently treated as done — its work never landed.
export type CommitResult = { sha: string } | { sha: null } | { rejected: string }

export interface OverseerDeps {
  runTask: (mission: Mission, task: MissionTask, feedback?: string) => Promise<{ summary: string; tokens: number; cost: number }>
  verify: (command: string, cwd: string) => Promise<{ ok: boolean; summary: string }>
  ensureBranch: (cwd: string, branch: string) => Promise<void>
  commit: (cwd: string, message: string) => Promise<CommitResult>
  // working tree status BEFORE the run — a non-empty list means uncommitted user work that `git add
  // -A` would otherwise sweep into a mission commit. Used to fail closed on a dirty tree.
  treeStatus: (cwd: string) => Promise<string>
  emit: (e: AgentEvent) => void
  overDailyCap: () => boolean
  inOffPeak: () => boolean
  signal: AbortSignal
}

const MAX_TASK_ATTEMPTS = 2 // first try + ONE retry with feedback

// Outcome of running one task to completion (across its attempts). Lets the outer loop tell a
// real verify failure (→ mission 'failed') apart from a user/cap stop (→ mission 'stopped') without
// guessing from a bare boolean + signal.aborted.
type TaskOutcome = 'done' | 'failed' | 'stopped'

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

  for (const task of mission.tasks) {
    // restart-resumable: a done task is never re-run or re-committed.
    if (task.status === 'done') continue

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
      // task exhausted its retry (or its work could not be committed) → HALT the whole mission
      // loudly. Do NOT continue / loop.
      mission.status = 'failed'
      saveMission(mission)
      emit('failed', `❌ Mission abgebrochen — Aufgabe "${task.title}" hat den Verify-Gate nicht bestanden.`, task.id)
      return mission
    }
  }

  mission.status = 'done'
  saveMission(mission)
  emit('done', `✅ Mission abgeschlossen: ${mission.tasks.length} Aufgabe(n) verifiziert & committet.`)
  return mission
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

    // THE gate: only the machine verify decides 'done' — never the agent's say-so.
    const v = await deps.verify(mission.verifyCommand, mission.cwd)
    if (v.ok) {
      const c = await deps.commit(mission.cwd, `mission: ${task.title}`)
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
      updateMissionTask(mission.id, task.id, { status: 'done', commit: task.commit })
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
