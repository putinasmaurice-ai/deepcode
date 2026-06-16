import { app, ipcMain, dialog, shell, BrowserWindow, Notification } from 'electron'
import { previewToolDiff } from './preview-diff'
import { isImagePath, imageToDataUri } from './images'
import { checkForUpdates } from './updater'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join, resolve, sep } from 'path'
import { IPC } from '@shared/ipc'
import {
  AgentEvent,
  AppSettings,
  AutomationDef,
  DEFAULT_SETTINGS,
  McpServerDef,
  MemoryEntry,
  Session
} from '@shared/types'
import {
  loadSettings,
  saveSettings,
  listSessions,
  getSession,
  saveSession,
  deleteSession
} from './store'
import { AgentEngine } from './agent/engine'
import { loadSkills } from './systems/skills'
import { loadCommands, expandCommand } from './systems/commands'
import { loadSubagents } from './systems/subagents'
import { loadHooks } from './systems/hooks'
import { pluginSkills, pluginCommands, pluginSubagents, pluginHooks, loadPlugins, togglePlugin } from './systems/plugins'
import { loadMemory, saveMemory, deleteMemory, recordArenaVote } from './systems/memory'
import { mcpManager } from './systems/mcp'
import { PATHS, safeFolderName } from './paths'
import { parsePluginRepoUrl, pluginCloneArgs } from './plugin-install'
import { buildAttachmentContext, listProjectFiles } from './attachments'
import { listApprovedCommands, removeApprovedCommand } from './approvals'
import { detectPreview } from './preview'
import { forecastTurn } from './samples'
import { estimateTokens, costOf } from './agent/pricing'
import { buildTools } from './agent/toolset'
import { ToolContext } from './agent/tools/types'
import {
  listWorkflows,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
  listRuns as listWorkflowRuns,
  getRun as getWorkflowRun
} from './workflows/store'
import { runWorkflow, WorkflowDeps, RunContext, RUN_MAX_MS } from './workflows/executor'
import { kvStore } from './workflows/kv-store'
import { createBackup, restoreBackup } from './backup'
import { atomicWriteJson } from './atomic'
import { runUserCode } from './workflows/code-node'
import { sendEmail } from './workflows/email'
import { WorkflowWatchManager } from './workflows/watch-trigger'
import { healRun } from './workflows/heal'
import { setPreviewSink } from './preview-bridge'
import { WorkflowScheduler } from './workflows/scheduler'
import { KNOWN_NODE_TYPES } from '@shared/workflows'
import { listSecretNames, setSecret, deleteSecret, loadSecretsResolved, buildMaskList, maskWith } from './workflows/secrets'
import { screenUnattendedCall } from './agent/policy'
import { WorkflowDef, WorkflowRun, WorkflowRunResult } from '@shared/types'
import { resolveWorkflow } from './workflows/wf-name-match'
import { runBuiltin } from './builtins'
import { execFile } from 'child_process'
import type { ApprovalPolicy } from './agent/engine'
import { loadProjects, getProject, upsertProject, deleteProject as removeProject } from './projects'
import { computeUsageSummary } from './usage'
import { listAudit, searchSessions } from './history'
import { listTraces, getTrace } from './trace-store'
import { listSwarmBranches, swarmBranchDiff, swarmMerge, swarmDeleteBranch } from './swarm-branches'
import { buildTimeline, buildTickDetail } from './timemachine/timeline'
import { branchFromHere, listForks, forkDiff, deleteFork } from './timemachine/fork'
import { getNightShift, saveNightShift, runNightShift, requestStop } from './nightshift'
import { listMissions, getMission, saveMission, deleteMission } from './missions/store'
import { runMission, OverseerDeps } from './missions/overseer'
import { generatePlan, replan as planReplan } from './missions/plan'
import { MissionScheduler } from './missions/scheduler'
import { buildMissionReport, writeMissionReport, missionReportPath } from './missions/report'
import { runStructuredVerify } from './agent/verify-report'
import { runGit } from './agent/tools/git'
import { inOffPeak } from '@shared/offpeak'
import { Mission } from '@shared/types'
import { overDailyCap } from './ledger'
import { startWatch, stopWatch, beginAgentOp, endAgentOp } from './watcher'
import { computeProjectHealth } from './health'
import { NightShiftState } from '@shared/types'
import { exportSessionMarkdown } from './export'
import { ProjectDef } from '@shared/types'
import {
  loadAutomations,
  upsertAutomation,
  deleteAutomation,
  AutomationScheduler
} from './systems/automations'

// Initialized in registerIpc() (after app 'ready', so safeStorage is available).
let settings: AppSettings
let engine: AgentEngine
let registered = false // registerIpc must wire handlers + scheduler only once
let currentWin: BrowserWindow | null = null // latest window; emitter targets this

export function getEngine(): AgentEngine {
  return engine
}

function emit(e: AgentEvent): void {
  if (currentWin && !currentWin.isDestroyed()) currentWin.webContents.send(IPC.agentEvent, e)
}

// Files the user explicitly chose via the OS file dialog (pickFiles) — a trusted
// gesture that authorizes reading those exact paths.
const pickedPaths = new Set<string>()

// Sanitize renderer-supplied settings before they replace the in-memory + on-disk object.
// Mirrors loadSettings's deep-merge over DEFAULT_SETTINGS (so a partial/garbage payload can't
// drop required nested fields) and clamps the numeric ceilings to sane non-negative ranges in
// memory — saveSettings only clamped maxTokens, and only on disk, so the live `settings` object
// (and engine.updateSettings) trusted whatever the renderer sent. confineToCwd stays boolean.
function sanitizeSettings(raw: Partial<AppSettings>): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...r,
    provider: { ...DEFAULT_SETTINGS.provider, ...(r.provider ?? {}) },
    autoApprove: { ...DEFAULT_SETTINGS.autoApprove, ...(r.autoApprove ?? {}) },
    claudeCode: { ...DEFAULT_SETTINGS.claudeCode, ...(r.claudeCode ?? {}) }
  }
  const mt = Number(merged.provider.maxTokens)
  merged.provider.maxTokens = Number.isFinite(mt) && mt >= 1 ? mt : DEFAULT_SETTINGS.provider.maxTokens
  const turn = Number(merged.maxCostPerTurn)
  merged.maxCostPerTurn = Number.isFinite(turn) && turn >= 0 ? turn : 0
  const day = Number(merged.maxCostPerDay)
  merged.maxCostPerDay = Number.isFinite(day) && day >= 0 ? day : 0
  merged.confineToCwd = !!merged.confineToCwd
  return merged
}

function isInsideConfigDir(abs: string): boolean {
  const root = resolve(PATHS.root)
  return abs === root || abs.startsWith(root + sep)
}

// Confine renderer-supplied read paths: the config dir (settings/mcp/memory) is
// always off-limits; otherwise allow only paths the user picked or that live inside
// a directory the user actually works in (a session/project cwd or the default cwd).
// Stops a compromised renderer from coercing readFileHead into arbitrary file reads.
function pathAllowedForRead(p: unknown): boolean {
  if (typeof p !== 'string' || !p) return false
  let abs: string
  try {
    abs = resolve(p)
  } catch {
    return false
  }
  if (isInsideConfigDir(abs)) return false
  if (pickedPaths.has(abs)) return true
  const roots = new Set<string>()
  if (settings?.defaultCwd) roots.add(resolve(settings.defaultCwd))
  for (const s of listSessions()) if (s.cwd) roots.add(resolve(s.cwd))
  for (const pr of loadProjects()) if (pr.cwd) roots.add(resolve(pr.cwd))
  for (const root of roots) if (abs === root || abs.startsWith(root + sep)) return true
  return false
}

export function registerIpc(win: BrowserWindow): void {
  // On window re-creation (e.g. macOS activate) only re-point the emitter — never
  // re-register ipcMain.handle (throws "second handler") or start a 2nd scheduler.
  currentWin = win
  if (registered) return
  registered = true
  settings = loadSettings()
  engine = new AgentEngine(settings)
  // route preview runtime errors (console error / load fail) to the renderer as a "Fix this" chip
  setPreviewSink(emit)

  // ---- settings ----
  ipcMain.handle(IPC.getSettings, () => settings)
  ipcMain.handle(IPC.saveSettings, (_e, next: AppSettings) => {
    // deep-merge over DEFAULT_SETTINGS + clamp numeric ceilings BEFORE it touches memory, disk,
    // or the engine — never persist/apply the renderer's raw object verbatim.
    const clean = sanitizeSettings(next)
    settings = clean
    saveSettings(clean)
    engine.updateSettings(clean)
    return settings
  })

  // ---- sessions ----
  ipcMain.handle(IPC.listSessions, () => listSessions())
  ipcMain.handle(IPC.getSession, (_e, id: string) => getSession(id))
  ipcMain.handle(IPC.createSession, (_e, cwd?: string, projectId?: string) => {
    const project = projectId ? getProject(projectId) : null
    const session: Session = {
      id: randomUUID(),
      title: 'New session',
      cwd: validDir(cwd) || validDir(project?.cwd) || validDir(settings.defaultCwd) || homedir(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      model: settings.provider.model,
      projectId: project?.id
    }
    saveSession(session)
    return session
  })

  // ---- projects ----
  ipcMain.handle(IPC.listProjects, () => loadProjects())
  ipcMain.handle(IPC.saveProject, (_e, p: ProjectDef) => {
    if (!p.id) p.id = randomUUID()
    if (!p.createdAt) p.createdAt = Date.now()
    return upsertProject(p)
  })
  ipcMain.handle(IPC.deleteProject, (_e, id: string) => removeProject(id))

  // ---- usage / export ----
  ipcMain.handle(IPC.usageSummary, () => computeUsageSummary())
  ipcMain.handle(IPC.listAudit, () => listAudit())
  ipcMain.handle(IPC.searchSessions, (_e, q: string) => searchSessions(q))

  // ---- night shift + project health ----
  ipcMain.handle(IPC.nightGet, () => getNightShift())
  ipcMain.handle(IPC.nightSave, (_e, state: NightShiftState) => saveNightShift(state))
  ipcMain.handle(IPC.nightStart, () => {
    // fire and forget — progress arrives via agent events; renderer polls state
    runNightShift(engine, emit).catch((err) =>
      emit({ type: 'error', message: `Nachtschicht: ${(err as Error).message}` })
    )
    return getNightShift()
  })
  ipcMain.handle(IPC.nightStop, () => {
    requestStop()
    return true
  })
  ipcMain.handle(IPC.nightOpenReport, (_e, path: string) => {
    shell.openPath(path)
    return true
  })

  // ---- mission control ----
  // One autonomous mission at a time (the overseer drives throwaway agent turns + git commits;
  // two concurrent ones would race the same branch/working tree). The AbortController lets
  // stopMission halt the loop cleanly (the overseer threads its signal into every runTask/verify/git).
  let missionRunning: string | null = null
  const missionAborters = new Map<string, AbortController>()

  // git-safe ref check for a per-milestone branch name (defence in depth: the overseer builds the
  // name, but never feed an unexpected value to `git branch -f`). Allows the mission/<id>/m<n>-<slug>
  // shape — slashes, alphanumerics, dot, dash, underscore — and rejects anything else.
  const safeBranchRef = (s: string): boolean => /^[A-Za-z0-9._/-]+$/.test(s) && !s.includes('..') && !s.startsWith('-')

  // Build the real OverseerDeps for ONE run. Mirrors the night-shift dispatch: a throwaway
  // unattended session per task, machine verify gate, local-only git. All events are stamped with
  // a fixed background 'mission' session id so per-task turn output never bleeds into a foreground chat.
  const makeOverseerDeps = (signal: AbortSignal): OverseerDeps => {
    const cwdOf = (m: Mission): string => validDir(m.cwd) || validDir(settings.defaultCwd) || homedir()
    return {
      // dispatch a task as a throwaway unattended turn (like nightshift.ts), summing the
      // session's billed tokens/cost and handing back the last assistant message as the summary.
      runTask: async (mission, task, feedback) => {
        const session: Session = {
          id: randomUUID(),
          title: `[🎯] ${task.title.replace(/\s+/g, ' ').slice(0, 45)}`,
          cwd: cwdOf(mission),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
          projectId: mission.projectId,
          model: settings.provider.model
        }
        saveSession(session)
        const prompt = task.instruction + (feedback ? '\n\nVorheriger Fehlversuch:\n' + feedback : '')
        beginAgentOp()
        // Bridge the mission's abort to the in-flight engine turn so Stop halts the LIVE (most
        // expensive) coding turn, not just the gap between attempts/tasks. engine.runTurn owns its
        // own per-session AbortController keyed on session.id; recordIfPending remembers a cancel
        // that races ahead of the turn's registration. Mirrors makeWfDeps.runAgent.
        const onAbort = (): void => engine.cancel(session.id, true)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        try {
          // fully unattended → the engine gates MCP / claude_code / task / git push|pr
          await engine.runTurn(session, prompt, emit, 'full', undefined, true)
        } finally {
          signal.removeEventListener('abort', onAbort)
          engine.clearPendingCancel(session.id)
          endAgentOp()
        }
        let tokens = 0
        let cost = 0
        for (const m of session.messages) {
          if (m.usage) {
            tokens += m.usage.totalTokens
            cost += m.usage.cost
          }
        }
        const last = [...session.messages].reverse().find((m) => m.role === 'assistant')
        return { summary: (last?.content ?? '(keine Antwort)').slice(0, 600), tokens, cost }
      },
      // machine verify gate — the ONLY thing that decides a task is done. Never the LLM's say-so.
      verify: async (command, cwd) => {
        const v = await runStructuredVerify(command, cwd, signal)
        return { ok: v.ok, summary: v.output.slice(0, 800) }
      },
      // ensure the mission branch exists + is checked out (local only). Create it on first run,
      // switch to it on a resume. Tolerant of "already on" (git prints it to a non-zero path on some
      // versions) — the overseer commits onto whatever HEAD this leaves us on.
      ensureBranch: async (cwd, branch) => {
        const exists = await runGit(['rev-parse', '--verify', branch], cwd, signal)
        const r = exists.code === 0
          ? await runGit(['checkout', branch], cwd, signal)
          : await runGit(['checkout', '-b', branch], cwd, signal)
        if (r.code !== 0 && !/already on/i.test(r.out)) {
          throw new Error(`git checkout ${branch} fehlgeschlagen: ${r.out.trim().slice(0, 300)}`)
        }
      },
      // commit the verified task's work to the mission branch AND drop a LOCAL per-milestone branch
      // pointer (the `milestone` name the overseer supplies — mission/<id>/m<n>-<slug>) at that commit,
      // so the user gets a reviewable STACK. Echoes the branch name back so the overseer records
      // task.branch. Distinguishes three outcomes so the overseer can react: { sha, branch } a real
      // commit, { sha: null } a genuine no-op (tree clean after the failed commit → "nothing to
      // commit"), or { rejected } a non-zero commit that left the tree DIRTY (a pre-commit hook
      // blocked it) — which must NOT be silently treated as done.
      commit: async (cwd, message, milestone) => {
        await runGit(['add', '-A'], cwd, signal)
        const c = await runGit(['commit', '-m', message], cwd, signal)
        if (c.code === 0) {
          const sha = await runGit(['rev-parse', '--short', 'HEAD'], cwd, signal)
          // per-milestone branch pointer at HEAD — LOCAL only, best-effort. `branch -f` never moves
          // the checkout, so the mission keeps building on its own branch; a failure here must NOT
          // sink an already-landed commit, so it's swallowed and the sha still returns. Validate the
          // name before handing it to git (defence in depth — the overseer composes it).
          let createdBranch: string | undefined
          if (milestone && safeBranchRef(milestone)) {
            try {
              const b = await runGit(['branch', '-f', milestone], cwd, signal)
              if (b.code === 0) createdBranch = milestone
            } catch {
              /* per-milestone branch is a convenience; never let it fail the commit */
            }
          }
          return { sha: sha.code === 0 ? sha.out.trim() : null, branch: createdBranch }
        }
        // non-zero commit: clean tree → genuine no-op; still-dirty tree → the commit was REJECTED
        // (hook) with the work uncommitted. Surface the hook output so the retry can react.
        const st = await runGit(['status', '--porcelain'], cwd, signal)
        if (st.code === 0 && !st.out.trim()) return { sha: null } // nothing to commit, working tree clean
        return { rejected: c.out.trim().slice(0, 800) }
      },
      // REPLANNING: when a task exhausts its retries, the overseer asks for remediation tasks instead
      // of always halting. Pure LLM decomposition (plan.replan) via the same one-shot completion as
      // generatePlan — bills usage. Returns the NEW remediation MissionTask[] ([] = unsatisfiable, the
      // overseer then halts). The overseer enforces the maxReplans + total-tasks-added caps; this dep
      // is just the model call.
      replan: async (mission, failedTask, failure) =>
        // thread the overseer's signal so Stop aborts the billed replan round in-flight (the dep's
        // closure has it). The overseer's tryReplan catch treats the resulting AbortError as a halt.
        planReplan(mission.goal, mission.tasks, failedTask, failure, (system, user) =>
          engine.complete(system, user, signal)
        ),
      // working-tree status used by the overseer's pre-flight clean-tree gate (porcelain = empty
      // when clean). The gate refuses to start on a dirty tree so `git add -A` can't sweep the
      // user's unrelated uncommitted work into a mission commit.
      treeStatus: async (cwd) => {
        const r = await runGit(['status', '--porcelain'], cwd, signal)
        if (r.code !== 0) throw new Error(r.out.trim().slice(0, 300) || 'git status fehlgeschlagen')
        return r.out
      },
      // discard a FAILED task's never-verified edits back to the last verified commit so they don't
      // bleed into the next remediation commit and so a halted mission leaves a clean (resumable,
      // non-blocking) tree. `reset --hard HEAD` drops tracked changes; `clean -fd` removes the task's
      // newly-created untracked files/dirs. Safe: the start-time clean-tree gate guaranteed a clean
      // tree and every prior task committed, so the only content here is THIS failed task's own work.
      discardChanges: async (cwd) => {
        await runGit(['reset', '--hard', 'HEAD'], cwd, signal)
        await runGit(['clean', '-fd'], cwd, signal)
      },
      // 'mission' + per-task turn events are session-less (no foreground chat to bleed into) →
      // forward straight to the renderer via the module emitter.
      emit,
      overDailyCap: () => overDailyCap(settings.maxCostPerDay),
      inOffPeak: () => inOffPeak(),
      signal
    }
  }

  // Runtime-truth override (mirrors nightshift's `s.running = running`): a mission persisted as
  // 'running' but with no live overseer (its id is not in missionAborters) is a PHANTOM left by a
  // crash/restart — report it reconciled to 'stopped' so the UI offers Resume instead of a dead
  // Stop button. Never mutates the file; the next real run rewrites the status authoritatively.
  const reconcile = <T extends Mission | null>(m: T): T => {
    if (m && m.status === 'running' && !missionAborters.has(m.id)) {
      return { ...m, status: 'stopped' } as T
    }
    return m
  }
  ipcMain.handle(IPC.missionsList, () => listMissions().map(reconcile))
  ipcMain.handle(IPC.missionGet, (_e, id: string) => reconcile(getMission(id)))
  ipcMain.handle(IPC.missionSave, (_e, m: Mission) => saveMission(m))
  ipcMain.handle(IPC.missionDelete, (_e, id: string) => {
    // don't delete a mission out from under a running overseer (its writes would resurrect the file)
    if (missionRunning === id) throw new Error('Diese Mission läuft gerade — bitte erst stoppen.')
    return deleteMission(id)
  })
  ipcMain.handle(IPC.missionGeneratePlan, async (_e, goal: string) => {
    // decompose the goal into 3-8 linear tasks via the engine's one-shot completion (bills usage).
    return generatePlan(String(goal ?? ''), (system, user) => engine.complete(system, user))
  })
  // RECURRING cron re-arm: a cron schedule ('0 2 * * *' = every night) implies recurrence, but a run
  // drives the mission to a TERMINAL status and isDue() only fires a 'scheduled' mission — so without
  // re-arming it would run exactly ONCE, then go permanently dormant (the documented overnight
  // operator breaks). After a terminal run, flip a cron mission back to 'scheduled' and reset its plan
  // to pending so the NEXT occurrence re-does the work (each nightly fire is a fresh run). The
  // scheduler's per-minute lastFired key + the cron-minute match + the one-at-a-time latch keep this
  // from double-firing within the same minute / while running. Off-peak stays SINGLE-SHOT by design
  // (it would otherwise re-fire continuously throughout the discount window). Mutates the mission in
  // place; the caller persists. No-op for non-cron / un-scheduled missions.
  const rearmCron = (m: Mission): void => {
    if (m.schedule?.mode !== 'cron') return
    m.status = 'scheduled'
    m.replansUsed = 0
    // drop replan-inserted remediation tasks and reset the original plan to pending for a clean rerun
    m.tasks = m.tasks
      .filter((t) => t.kind !== 'remediation')
      .map((t) => ({ ...t, status: 'pending', attempts: 0, commit: undefined, branch: undefined, summary: undefined }))
  }
  // Shared, guarded launch path used by BOTH the manual missionStart and the overnight scheduler:
  // one-mission-at-a-time, abortable, fire-and-forget. Throws on the one-at-a-time guard so the
  // manual handler can surface it; the scheduler swallows it (a missed tick retries next minute).
  // After the run ends (any terminal status) it writes the morning report onto mission.reportPath.
  const launchMission = (mission: Mission): Mission => {
    if (missionRunning) throw new Error('Es läuft bereits eine Mission — bitte erst stoppen.')
    const id = mission.id
    missionRunning = id
    const ac = new AbortController()
    missionAborters.set(id, ac)
    const deps = makeOverseerDeps(ac.signal)
    // fire and forget — progress streams via 'mission' agent events; the renderer polls getMission.
    runMission(mission, deps, { waitForOffPeak: mission.waitForOffPeak })
      .then((final) => {
        // morning report (per-task status/commit/branch/cost + keep/rewind hints) — written for
        // every terminal outcome so the user wakes to a reviewable summary. Re-read from disk so the
        // report metadata can't clobber a concurrent edit, and never let a report write fail the run.
        try {
          const cur = getMission(id) ?? final
          const path = writeMissionReport(cur)
          cur.reportPath = path
          rearmCron(cur) // RECURRING cron: re-arm for the next occurrence (mutates cur in place)
          saveMission(cur)
        } catch (e) {
          console.error('Mission-Bericht konnte nicht geschrieben werden:', (e as Error).message)
        }
      })
      .catch((err) => {
        // An escaped rejection (the overseer normally persists its own terminal status, but a throw
        // from outside its try-blocks would otherwise leave the file stuck 'running'). Persist a
        // durable terminal 'failed' so a restart doesn't resume a phantom — re-read first so the
        // status flip can't clobber concurrent report/edit writes.
        try {
          const cur = getMission(id)
          if (cur && cur.status === 'running') {
            cur.status = 'failed'
            saveMission(cur)
          }
        } catch {
          /* best-effort durable failure; the event below still notifies the UI */
        }
        emit({ type: 'mission', missionId: id, status: 'failed', message: (err as Error).message })
      })
      .finally(() => {
        missionAborters.delete(id)
        if (missionRunning === id) missionRunning = null
      })
    return getMission(id) ?? mission
  }

  ipcMain.handle(IPC.missionStart, (_e, id: string) => {
    const mission = getMission(id)
    if (!mission) throw new Error('Mission not found')
    // authoritative guard (not just the renderer's disabled button): never start a mission without
    // a real machine gate — an empty verify command would auto-pass and commit unverified work.
    if (!mission.verifyCommand || !mission.verifyCommand.trim()) {
      throw new Error('Kein Verify-Befehl gesetzt — eine Mission ohne maschinelle Abnahme kann nicht gestartet werden.')
    }
    return launchMission(mission)
  })
  ipcMain.handle(IPC.missionStop, (_e, id: string) => {
    // abort halts the overseer loop: it threads this signal into every runTask/verify/git call and
    // checks signal.aborted between tasks, so the run unwinds without committing on a stopped task.
    missionAborters.get(id)?.abort()
    return true
  })
  // save a schedule on a mission (the overnight operator auto-starts it inside its window). Saved
  // separately from missionSave so the panel can flip scheduling on/off without rewriting the plan.
  ipcMain.handle(IPC.missionSchedule, (_e, id: string, schedule: Mission['schedule'] | null) => {
    const mission = getMission(id)
    if (!mission) throw new Error('Mission not found')
    if (schedule) {
      // guard a scheduled mission the same way the manual start is guarded — never queue a mission
      // the scheduler would refuse to run (empty verify command auto-passes + commits unverified).
      if (!mission.verifyCommand || !mission.verifyCommand.trim()) {
        throw new Error('Kein Verify-Befehl gesetzt — eine Mission ohne maschinelle Abnahme kann nicht geplant werden.')
      }
      if (schedule.mode === 'cron' && !String(schedule.cron ?? '').trim()) {
        throw new Error('Cron-Zeitplan fehlt — bitte einen 5-Felder-Cron-Ausdruck angeben.')
      }
      mission.schedule = schedule.mode === 'cron' ? { mode: 'cron', cron: String(schedule.cron ?? '').trim() } : { mode: 'offpeak' }
      mission.status = 'scheduled'
    } else {
      // un-schedule: drop the schedule and reset a still-'scheduled' mission back to a runnable state.
      delete mission.schedule
      if (mission.status === 'scheduled') mission.status = mission.tasks.length ? 'ready' : 'planning'
    }
    return saveMission(mission)
  })
  // morning report: the path (so the panel can open it externally) + the freshly-built content (so
  // it can render inline without a file read). Returns null content when no report has been written.
  ipcMain.handle(IPC.missionReport, (_e, id: string) => {
    const mission = getMission(id)
    if (!mission) return { path: null, content: null }
    const path = mission.reportPath ?? missionReportPath(id)
    return { path, content: buildMissionReport(mission) }
  })

  ipcMain.handle(IPC.projectHealth, (_e, cwd: string) => computeProjectHealth(cwd))
  ipcMain.handle(IPC.exportSession, (_e, id: string) => {
    const s = getSession(id)
    if (!s) throw new Error('Session not found')
    return exportSessionMarkdown(s)
  })
  ipcMain.handle(IPC.changeCwd, (_e, id: string, cwd: string) => {
    const dir = validDir(cwd)
    if (!dir) throw new Error('Not a valid directory: ' + cwd)
    // route through the engine's live session if a turn is running, so the running
    // turn's saveSession doesn't clobber the edit (last-writer-wins).
    const s = engine.applyLiveEdit(id, { cwd: dir }) ?? getSession(id)
    if (!s) throw new Error('Session not found')
    s.cwd = dir
    saveSession(s)
    return s
  })
  ipcMain.handle(IPC.updateSessionModel, (_e, id: string, model: string) => {
    const s = engine.applyLiveEdit(id, { model }) ?? getSession(id)
    if (s) {
      s.model = model
      saveSession(s)
    }
    return true
  })
  ipcMain.handle(IPC.deleteSession, (_e, id: string) => {
    engine.cancel(id) // stop any in-flight turn so it can't resurrect the file
    deleteSession(id)
    return true
  })
  ipcMain.handle(IPC.renameSession, (_e, id: string, title: string) => {
    const s = engine.applyLiveEdit(id, { title }) ?? getSession(id)
    if (s) {
      s.title = title
      saveSession(s)
    }
    return true
  })

  // ---- agent turn ----
  ipcMain.handle(
    IPC.sendMessage,
    async (_e, sessionId: string, rawText: string, attachments?: string[], mode?: ApprovalPolicy, toolAllow?: string[]) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')

    let text = rawText
    if (rawText.trim().startsWith('/')) {
      const trimmed = rawText.trim()
      const cmd = trimmed.slice(1).split(/\s+/)[0]
      const args = trimmed.slice(1 + cmd.length).trim()

      const builtin = await runBuiltin(cmd, {
        session,
        args,
        // scope the builtin's emit to this session — async builtins (/wf, /learn, /remember,
        // /compact) run LLM calls during which the user may switch chats; their events (incl. the
        // synthetic result message) must not bleed into whatever chat is then open.
        emit: engine.scopeEmit(session.id, emit),
        engine,
        settings,
        // run a saved workflow from chat, unattended, and hand back its MASKED final output so a
        // workflow that touched a secret can't leak it into the chat transcript. Reuses wfAborters
        // so the run is cancellable via the normal cancelWorkflow IPC, and streams workflow_* events.
        runWorkflowFromChat: async (def, input) => {
          const runId = randomUUID()
          const ac = new AbortController()
          wfAborters.set(runId, ac)
          chatWfAborters.set(session.id, ac) // so cancelTurn(session.id) (Stop/Escape) aborts it
          const stopDeadline = armDeadline(ac)
          const wfCwd = validDir(session.cwd) || validDir(settings.defaultCwd) || homedir()
          const deps = makeWfDeps(wfCwd, ac.signal, 0, undefined, new Set([def.id]))
          const mask = deps.mask ?? ((s: string) => s)
          // live progress in the chat: each node emits a 'running' workflow_node event as the walk
          // enters it — surface it as a (session-scoped) status line so a long workflow isn't a
          // silent multi-minute wait. The WorkingIndicator (busy=true during /wf) renders it.
          const labelOf = new Map(def.nodes.map((n) => [n.id, (n.label || n.type) as string]))
          const baseEmit = deps.emit
          deps.emit = (e: AgentEvent) => {
            baseEmit(e)
            // only the node-ENTRY 'running' (no output) — not the throttled loop/parallel
            // heartbeats or retry re-emits (which carry output) — so a long fan-out node doesn't
            // spam ~4 status lines/sec. NOTE: this status goes through the raw (unmasked) emit;
            // it is safe ONLY because def.name + node label/type are STATIC def text — never
            // interpolate a resolved {{var}} here.
            if (e && e.type === 'workflow_node' && e.status === 'running' && e.output === undefined) {
              const lbl = labelOf.get(e.nodeId) || 'Schritt'
              emit({ type: 'status', sessionId: session.id, message: `⚙ „${def.name}": ${lbl}…` })
            }
          }
          try {
            let run = await runWorkflow(def, deps, { vars: { input, last: input }, runId })
            // opt-in self-healing: the in-process coder repairs a failed node + replays
            run = await maybeAutoHeal(def, run, deps, wfCwd, ac.signal)
            // Prefer an explicit result var (so a workflow ending in notify/delay still surfaces a
            // meaningful value) and fall back to the executor's running `last`.
            const v = run.vars ?? {}
            const result = v.output ?? v.result ?? v.last ?? ''
            return {
              status: run.status === 'failed' ? 'error' : run.status === 'cancelled' ? 'cancelled' : 'done',
              output: mask(String(result)),
              error: run.error ? mask(run.error) : undefined
            }
          } finally {
            stopDeadline()
            wfAborters.delete(runId)
            // only clear OUR entry — if a later run for the same session somehow replaced it,
            // don't delete the newer run's aborter (keeps Stop/Escape working for it).
            if (chatWfAborters.get(session.id) === ac) chatWfAborters.delete(session.id)
          }
        },
        // /swarm — parallel agents in isolated worktrees; cancellable via Stop/Escape (chatWfAborters)
        runSwarmFromChat: async (task) => {
          const ac = new AbortController()
          chatWfAborters.set(session.id, ac)
          const stopDeadline = armDeadline(ac)
          beginAgentOp() // suppress fs_change toasts for the workers' writes
          try {
            return await engine.runSwarm(session, task, emit, ac.signal)
          } finally {
            endAgentOp()
            stopDeadline()
            if (chatWfAborters.get(session.id) === ac) chatWfAborters.delete(session.id)
          }
        }
      })
      if (builtin === 'handled') {
        emit({ type: 'turn_done', sessionId: session.id })
        return true
      }
      if (typeof builtin === 'string') {
        text = builtin // builtin expanded into a normal agent prompt (/init)
      } else {
        const expanded = expandCommand(cmd, args, session.cwd)
        if (expanded) text = expanded
      }
    }

    // Split attachments: images go to the vision model, other files are inlined.
    let images: string[] | undefined
    if (attachments && attachments.length) {
      const imgPaths = attachments.filter(isImagePath)
      const filePaths = attachments.filter((p) => !isImagePath(p))
      if (filePaths.length) {
        const ctx = buildAttachmentContext(filePaths, session.cwd)
        if (ctx) text = `${ctx}\n\n${text}`
      }
      const uris = imgPaths.map(imageToDataUri).filter((u): u is string => !!u)
      if (uris.length) images = uris
    }

    if (session.title === 'New session') {
      session.title = rawText.replace(/\s+/g, ' ').slice(0, 50) || 'New session'
      saveSession(session)
    }

    beginAgentOp()
    try {
      await engine.runTurn(session, text, emit, mode, images, false, toolAllow)
    } finally {
      endAgentOp()
    }
    return true
    }
  )
  // Re-run from a user message: truncate history at that point and run again
  // (optionally with edited text). Powers "Regenerate".
  ipcMain.handle(
    IPC.resendMessage,
    async (
      _e,
      sessionId: string,
      messageId: string,
      newText?: string,
      mode?: ApprovalPolicy,
      attachments?: string[]
    ) => {
      const session = getSession(sessionId)
      if (!session) throw new Error('Session not found')
      const idx = session.messages.findIndex((m) => m.id === messageId && m.role === 'user')
      if (idx < 0) throw new Error('User message not found')
      const original = session.messages[idx].content
      // Recover the original message's images BEFORE truncating — otherwise regenerate/edit
      // re-runs blind (the vision pass never sees them) and the persisted description is
      // lost. Newly-attached images (edit) override; otherwise reuse the originals.
      const origImages = session.messages[idx].images
      session.messages = session.messages.slice(0, idx)
      saveSession(session)
      let text = newText ?? original
      let images: string[] | undefined = origImages
      if (attachments?.length) {
        const imgPaths = attachments.filter(isImagePath)
        const filePaths = attachments.filter((pth) => !isImagePath(pth))
        if (filePaths.length) {
          const ctx = buildAttachmentContext(filePaths, session.cwd)
          if (ctx) text = `${ctx}\n\n${text}`
        }
        const uris = imgPaths.map(imageToDataUri).filter((u): u is string => !!u)
        if (uris.length) images = uris // newly attached images replace the originals
      }
      // No 'session' event here: the renderer truncates its transcript locally,
      // keeping its optimistic user message visible during the rerun.
      beginAgentOp()
      try {
        await engine.runTurn(session, text, emit, mode, images)
      } finally {
        endAgentOp()
      }
      return true
    }
  )
  ipcMain.handle(IPC.watchStart, (_e, cwd: string) => {
    startWatch(cwd, (files) => emit({ type: 'fs_change', files }))
    return true
  })
  ipcMain.handle(IPC.watchStop, () => {
    stopWatch()
    return true
  })
  ipcMain.handle(IPC.listFiles, (_e, cwd: string) => listProjectFiles(cwd))
  ipcMain.handle(IPC.secondOpinion, async (_e, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    await engine.secondOpinion(session, engine.scopeEmit(session.id, emit))
    return true
  })
  ipcMain.handle(IPC.arena, async (_e, sessionId: string, modelB?: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    await engine.arena(session, engine.scopeEmit(session.id, emit), modelB)
    return true
  })
  ipcMain.handle(IPC.arenaVote, (_e, winner: string, loser: string) => {
    recordArenaVote(winner, loser)
    return true
  })
  // local models from the OpenAI-compatible endpoint (Ollama / LM Studio)
  ipcMain.handle(IPC.listLocalModels, async () => {
    try {
      const base = (settings.provider.localBaseUrl || 'http://localhost:11434/v1').replace(/\/$/, '')
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      const res = await fetch(`${base}/models`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!res.ok) return []
      const json = (await res.json()) as { data?: { id: string }[] }
      return (json.data ?? [])
        .map((m) => m.id)
        .filter((id) => !/embed|minilm/i.test(id)) // hide embedding models
    } catch {
      return [] // endpoint not running — that's fine
    }
  })
  ipcMain.handle(IPC.previewDiff, (_e, name: string, argsJson: string, cwd: string) =>
    previewToolDiff(name, argsJson, cwd, (abs) => pathAllowedForRead(abs))
  )
  ipcMain.handle(IPC.getAppInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron
  }))
  ipcMain.handle(IPC.checkUpdates, () => checkForUpdates())
  // Marketplace: install a plugin/skill bundle by cloning a git repo into
  // ~/.deepcode/plugins/<repo>. Shallow clone, 60s cap.
  ipcMain.handle(IPC.installFromGit, async (_e, url: string) => {
    const name = parsePluginRepoUrl(url)
    if (!name) return { ok: false, message: 'Bitte eine https-Repo-URL angeben (GitHub/GitLab/Codeberg).' }
    const dest = join(PATHS.plugins, name)
    if (existsSync(dest)) return { ok: false, message: `"${name}" ist bereits installiert.` }
    return new Promise((resolvePromise) => {
      execFile(
        'git',
        // harden against an untrusted repo: block file:// submodule transports and skip tag fetching
        pluginCloneArgs(url, dest),
        { timeout: 60_000 },
        (err) => {
          if (err) {
            resolvePromise({ ok: false, message: `Clone fehlgeschlagen: ${err.message.slice(0, 200)}` })
            return
          }
          const hasPlugin = existsSync(join(dest, 'plugin.json'))
          const hasSkills = existsSync(join(dest, 'skills')) || existsSync(join(dest, 'SKILL.md'))
          // install DISABLED — a freshly cloned bundle's hooks/MCP would otherwise run on the next
          // tool call (RCE). The user enables it explicitly in the Plugins panel.
          togglePlugin(name, false)
          resolvePromise({
            ok: true,
            message: `"${name}" installiert${hasPlugin ? ' (Plugin)' : hasSkills ? ' (Skills)' : ''} — im Plugins-Panel aktivierbar.`
          })
        }
      )
    })
  })
  ipcMain.handle(IPC.imageDataUri, (_e, path: string) => {
    // never expose the config dir; imageToDataUri itself rejects non-image bytes
    if (typeof path !== 'string' || isInsideConfigDir(resolve(path))) return null
    return imageToDataUri(path)
  })
  ipcMain.handle(IPC.readFileHead, (_e, path: string, maxChars?: number) => {
    if (!pathAllowedForRead(path)) return '(Zugriff verweigert: außerhalb des Projekts)'
    try {
      const st = statSync(path)
      if (st.isDirectory()) return '(Ordner)'
      if (st.size > 2_000_000) return `(zu groß: ${Math.round(st.size / 1024)} KB)`
      return readFileSync(path, 'utf8').slice(0, Math.min(maxChars ?? 1500, 8000))
    } catch (e) {
      return `(Fehler: ${(e as Error).message})`
    }
  })
  ipcMain.handle(IPC.compactSession, async (_e, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    const updated = await engine.compactSession(session, engine.scopeEmit(session.id, emit))
    emit({ type: 'turn_done', sessionId: session.id })
    return updated
  })
  ipcMain.handle(IPC.forecastTurn, (_e, sessionId: string) => {
    const s = getSession(sessionId)
    const model = s?.model || settings.provider.model
    const isLocal = model.startsWith('local:')
    const contextTokens = s ? estimateTokens(s) : 0
    // reuse costOf so the pre-send estimate matches the RECORDED cost — same per-vendor card
    // (deepinfra/google) and off-peak discount — instead of re-deriving the price (which billed
    // non-DeepSeek models with DeepSeek's card and ignored the off-peak window).
    const estInputCost = costOf(
      settings.provider,
      { promptTokens: contextTokens, completionTokens: 0, totalTokens: contextTokens },
      model
    ).cost
    const f = forecastTurn(model)
    return {
      contextTokens,
      estInputCost,
      isLocal,
      avgCost: f.avgCost,
      avgTokens: f.avgTokens,
      avgDurationMs: f.avgDurationMs,
      sampleCount: f.count
    }
  })
  ipcMain.handle(IPC.cancelTurn, (_e, sessionId: string) => {
    engine.cancel(sessionId)
    // a /wf workflow running in this chat isn't an engine turn — abort it too so Stop/Escape work
    chatWfAborters.get(sessionId)?.abort()
    return true
  })
  ipcMain.handle(IPC.approveTool, (_e, callId: string, approved: boolean, remember?: boolean) => {
    engine.approve(callId, approved, remember)
    return true
  })
  // Secure secret entry: the submitted VALUE flows renderer→main→setSecret ONLY (inside
  // engine.submitSecret). It is never echoed back to the renderer/LLM or logged. Returns only the
  // store OUTCOME ({ set, error? }) so the renderer can warn on a rejected value — error is a
  // static constraint message (min length / no encryption), never the value itself.
  ipcMain.handle(IPC.submitSecret, (_e, callId: string, value: string | null) => engine.submitSecret(callId, value))

  // ---- persistent approval allowlist ----
  ipcMain.handle(IPC.listApprovedCommands, () => listApprovedCommands())
  ipcMain.handle(IPC.removeApprovedCommand, (_e, command: string, cwd: string) =>
    removeApprovedCommand(command, cwd)
  )

  // ---- in-chat find (Electron native findInPage with highlight-all) ----
  win.webContents.on('found-in-page', (_e, result) => {
    win.webContents.send(IPC.findResult, {
      matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal
    })
  })
  ipcMain.handle(IPC.findInPage, (_e, text: string, forward: boolean, findNext: boolean) => {
    if (!text) {
      win.webContents.stopFindInPage('clearSelection')
      return true
    }
    win.webContents.findInPage(text, { forward, findNext })
    return true
  })
  ipcMain.handle(IPC.stopFindInPage, () => {
    win.webContents.stopFindInPage('clearSelection')
    return true
  })

  // ---- project preview detection ----
  ipcMain.handle(IPC.detectPreview, (_e, cwd: string) => detectPreview(cwd))
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // http(s) only — the webview already renders file:// internally, and forwarding
    // file:// to the OS shell would open arbitrary local paths/folders.
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return true
  })

  // ---- feature systems (read-only listings) ----
  ipcMain.handle(IPC.listSkills, (_e, cwd?: string) => [...loadSkills(cwd), ...pluginSkills()])
  ipcMain.handle(IPC.listCommands, (_e, cwd?: string) => [...loadCommands(cwd), ...pluginCommands()])
  ipcMain.handle(IPC.listSubagents, (_e, cwd?: string) => [...loadSubagents(cwd), ...pluginSubagents()])
  ipcMain.handle(IPC.listHooks, (_e, cwd?: string) => [...loadHooks(cwd), ...pluginHooks()])

  // ---- memory ----
  ipcMain.handle(IPC.listMemory, () => loadMemory())
  ipcMain.handle(IPC.saveMemory, (_e, entry: Omit<MemoryEntry, 'path'>) => saveMemory(entry))
  ipcMain.handle(IPC.deleteMemory, (_e, name: string) => {
    deleteMemory(name)
    return true
  })

  // ---- mcp ----
  ipcMain.handle(IPC.listMcp, () => mcpManager.listStatus())
  ipcMain.handle(IPC.saveMcp, (_e, defs: McpServerDef[]) => {
    mcpManager.saveConfig(defs)
    return mcpManager.listStatus()
  })
  ipcMain.handle(IPC.connectMcp, async (_e, name: string) => {
    try {
      return await mcpManager.connect(name)
    } catch (err) {
      return { name, transport: 'stdio', enabled: true, status: 'error', error: (err as Error).message }
    }
  })
  ipcMain.handle(IPC.disconnectMcp, async (_e, name: string) => {
    await mcpManager.disconnect(name)
    return true
  })

  // ---- plugins ----
  ipcMain.handle(IPC.listPlugins, () => loadPlugins())
  ipcMain.handle(IPC.togglePlugin, (_e, name: string, enabled: boolean) => {
    togglePlugin(name, enabled)
    return loadPlugins()
  })

  // ---- visual workflows ----
  const wfAborters = new Map<string, AbortController>()
  // workflows launched from chat via /wf, keyed by the CHAT session id, so Stop/Escape
  // (cancelTurn) can abort them — they run inside sendMessage, not a normal agent turn.
  const chatWfAborters = new Map<string, AbortController>()
  // Hard wall-clock ceiling: the executor only checks the deadline BETWEEN nodes, so a single
  // stuck node could outlive RUN_MAX_MS. Schedule an abort at the deadline (the signal threads
  // through every node + sub-run), making the documented ceiling real. Returns a clear fn.
  const armDeadline = (ac: AbortController): (() => void) => {
    const t = setTimeout(() => ac.abort(), RUN_MAX_MS)
    t.unref?.()
    return () => clearTimeout(t)
  }
  // Build the executor deps: reuse the real agent loop (agent nodes), the built-in tools
  // (tool/shell/http nodes), and recursion (sub-workflow nodes). `depth` guards recursion.
  // `ancestors` = the workflow ids on the path from the top run down to THIS level (copy-on-
  // descend, NOT shared). Cycle detection keys on this path so concurrent sibling fan-out to
  // the same id (parallel loops / parallel branches) is fine; only a true re-entry trips.
  const makeWfDeps = (cwd: string, signal: AbortSignal, depth: number, runCtx?: RunContext, ancestors: ReadonlySet<string> = new Set()): WorkflowDeps => {
    // The TOP-LEVEL call (no runCtx) creates the tree-wide context ONCE: secrets decrypted a
    // single time, an absolute deadline, and the fan-out cap. Sub-runs inherit the SAME object
    // (passed by makeWfDeps in runSub*), so the count/deadline are enforced across the tree.
    const ctx: RunContext =
      runCtx ?? {
        deadline: Date.now() + RUN_MAX_MS,
        childRuns: { n: 0 },
        maxChildRuns: 500,
        secrets: loadSecretsResolved()
      }
    if (!ctx.maskList) ctx.maskList = buildMaskList(ctx.secrets ?? {})
    const secrets = ctx.secrets ?? {}
    const maskList = ctx.maskList
    const mask = (s: string): string => maskWith(maskList, s)
    // wrap emit ONCE: deep-mask EVERY string field of the event (not just top-level
    // message/output/error) — the agent stream carries text in delta / message.content /
    // toolCall.arguments / args / result.content. Serialize→mask→parse redacts them all.
    const maskedEmit = (e: AgentEvent): void => {
      if (!maskList.length) return emit(e)
      try {
        emit(JSON.parse(mask(JSON.stringify(e))) as AgentEvent)
      } catch {
        emit(e) // non-serializable event → emit as-is rather than dropping it
      }
    }
    return {
    cwd,
    signal,
    depth,
    runCtx: ctx,
    emit: maskedEmit,
    mask,
    resolveSecret: (name: string) => secrets[name],
    runAgent: async (prompt, c, modelOverride) => {
      // workflow already cancelled before this node started → don't even create a
      // throwaway session or burn a turn (engine.cancel here would be a no-op anyway,
      // since the turn hasn't registered its aborter yet).
      if (signal.aborted) return ''
      const session: Session = {
        id: randomUUID(),
        title: '[wf] ' + prompt.replace(/\s+/g, ' ').slice(0, 45),
        cwd: c,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        // per-node model override (agent node config.model) → this step runs on that provider/model;
        // otherwise the configured default. Prefix routing (openai:/google:/deepinfra:/local:) applies.
        model: (modelOverride && modelOverride.trim()) || settings.provider.model
      }
      saveSession(session)
      // bridge a workflow cancel to the in-flight engine turn. engine.runTurn owns its own
      // per-session AbortController; pass recordIfPending so a cancel that races ahead of
      // the turn's registration is remembered and applied by acquireSession.
      const onAbort = (): void => engine.cancel(session.id, true)
      signal.addEventListener('abort', onAbort, { once: true })
      // catch an abort that fired in the gap between the early check and this listener
      if (signal.aborted) onAbort()
      try {
        // unattended=true → the engine's approval gate blocks MCP / claude_code / task /
        // git push|pr for this agent node (no user to approve), closing the hole where the
        // agent node would otherwise bypass the tool-node gate under policy 'full'.
        await engine.runTurn(session, prompt, maskedEmit, 'full', undefined, true)
        const last = [...session.messages].reverse().find((m) => m.role === 'assistant')
        return last?.content ?? ''
      } finally {
        signal.removeEventListener('abort', onAbort)
        // turn is done → drop any pending cancel a late-firing abort may have recorded for
        // this throwaway session, so pendingCancels can't grow unbounded across runs.
        engine.clearPendingCancel(session.id)
        try {
          deleteSession(session.id) // throwaway — don't clutter the chat list
        } catch {
          /* ignore */
        }
      }
    },
    runTool: async (name, args, c) => {
      // A workflow tool node runs UNATTENDED with no approval prompt. Apply the SAME shared
      // screen the engine + subagent loop use (MCP/claude_code/task, structured AND raw git
      // push/pr, dangerous shell) so the "no unattended high-blast-radius work" invariant can't
      // drift between the three entry points.
      const blocked = screenUnattendedCall(name, args)
      if (blocked) return { ok: false, content: blocked }
      const tool = buildTools(settings, c).find((t) => t.name === name)
      if (!tool) return { ok: false, content: `Unknown tool: ${name}` }
      const ctx: ToolContext = { cwd: c, signal, confineToCwd: settings.confineToCwd }
      try {
        const r = await tool.execute(args, ctx)
        return { ok: r.ok, content: r.content }
      } catch (e) {
        return { ok: false, content: (e as Error).message }
      }
    },
    notify: (title, body) => {
      try {
        if (Notification.isSupported()) new Notification({ title, body }).show()
      } catch {
        /* ignore — notifications are best-effort */
      }
    },
    kv: kvStore, // persistent key/value state for the `store` node
    runCode: runUserCode, // sandboxed JS for the `code` node
    sendEmail, // SMTP send for the `email` node
    runSubworkflow: async (subId, vars, d) => {
      const r = await guardedSub(subId, vars, d)
      return r.vars?.last ?? ''
    },
    // like runSubworkflow but returns the child's FULL vars bag (loop/parallel collection)
    runSubBag: async (subId, vars, d) => {
      const r = await guardedSub(subId, vars, d)
      return r.vars ?? {}
    }
    }

    // Shared sub-run with the tree-wide guards: depth, cycle (subId already on THIS descent
    // path), and the fan-out cap. Throws (so the parent node fails) on a non-'done' child.
    async function guardedSub(subId: string, vars: Record<string, string>, d: number): Promise<WorkflowRun> {
      if (d > 5) throw new Error('sub-workflow depth limit (5) reached')
      if (ancestors.has(subId)) throw new Error(`Zyklus erkannt: Workflow „${subId}" ruft sich (indirekt) selbst auf.`)
      if (ctx.childRuns.n >= ctx.maxChildRuns) throw new Error(`Limit erreicht: max. ${ctx.maxChildRuns} Sub-Läufe pro Workflow.`)
      const child = getWorkflow(subId)
      if (!child) throw new Error(`sub-workflow not found: ${subId}`)
      ctx.childRuns.n++
      // child carries its OWN extended path copy — siblings don't see each other
      const childAncestors = new Set(ancestors).add(subId)
      const r = await runWorkflow(child, makeWfDeps(cwd, signal, d, ctx, childAncestors), { vars, runId: randomUUID() })
      if (r.status !== 'done') throw new Error(`Sub-Workflow „${child.name}" endete mit Status ${r.status}${r.error ? ': ' + r.error : ''}`)
      return r
    }
  }

  // Let the chat agent build/run/iterate workflows: resolve a saved workflow by id-or-name, run it
  // UNATTENDED with the same guarded deps as a manual run, and hand back a structured per-node
  // result (MASKED like runWorkflowFromChat, so a workflow that touched a secret can't leak it
  // into the agent's tool-result transcript). Cancellable via the shared wfAborters + deadline.
  engine.setWorkflowRunner(async (idOrName, input, cwd): Promise<WorkflowRunResult> => {
    const { def } = resolveWorkflow(listWorkflows(), String(idOrName ?? ''))
    if (!def) return { ok: false, status: 'error', error: 'Workflow nicht gefunden', nodes: [] }
    const runId = randomUUID()
    const ac = new AbortController()
    wfAborters.set(runId, ac)
    const stopDeadline = armDeadline(ac)
    const wfCwd = validDir(cwd) || validDir(settings.defaultCwd) || homedir()
    const deps = makeWfDeps(wfCwd, ac.signal, 0, undefined, new Set([def.id]))
    const mask = deps.mask ?? ((s: string) => s)
    const labelOf = new Map(def.nodes.map((n) => [n.id, (n.label || n.type) as string]))
    beginAgentOp() // suppress fs_change toasts for the workflow's own writes
    try {
      const inp = input ?? ''
      const run = await runWorkflow(def, deps, { vars: { input: inp, last: inp }, runId })
      const v = run.vars ?? {}
      const result = v.output ?? v.result ?? v.last ?? ''
      return {
        ok: run.status === 'done',
        status: run.status,
        output: mask(String(result)),
        error: run.error ? mask(run.error) : undefined,
        nodes: run.nodes.map((n) => ({
          id: n.nodeId,
          label: labelOf.get(n.nodeId),
          status: n.status,
          output: n.output ? mask(n.output) : undefined,
          error: n.error ? mask(n.error) : undefined
        }))
      }
    } finally {
      endAgentOp()
      stopDeadline()
      wfAborters.delete(runId)
    }
  })

  // Self-healing: after an unattended run, if it failed AND the workflow opted in (def.autoHeal),
  // let the in-process coder repair the failed node + replay. `force` (interactive "Reparieren")
  // heals regardless of the flag. Bounded by maxHealAttempts (1–3) and the daily spend cap.
  const healingWorkflows = new Set<string>() // serialize heal/save per workflow id (cron+chat+interactive)
  const maybeAutoHeal = async (
    def: WorkflowDef,
    run: WorkflowRun,
    deps: WorkflowDeps,
    cwd: string,
    signal: AbortSignal,
    force = false
  ): Promise<WorkflowRun> => {
    if (run.status !== 'failed' || !run.healSeed) return run
    if (!force && !def.autoHeal) return run
    if (overDailyCap(settings.maxCostPerDay)) return run
    // never run two heal loops for the SAME workflow at once — both would saveWorkflow the
    // patched def and last-writer-wins could clobber the other's patch on disk.
    if (healingWorkflows.has(def.id)) return run
    healingWorkflows.add(def.id)
    try {
      return await healRun(def, run, deps, {
        maxAttempts: Math.max(1, Math.min(Number(def.maxHealAttempts) || 1, 3)),
        overCap: () => overDailyCap(settings.maxCostPerDay),
        makeReplayDeps: (rid) => makeWfDeps(cwd, signal, 0, undefined, new Set([def.id])),
        newRunId: () => randomUUID()
      })
    } finally {
      healingWorkflows.delete(def.id)
    }
  }

  ipcMain.handle(IPC.listWorkflows, () => listWorkflows())
  ipcMain.handle(IPC.getWorkflow, (_e, id: string) => getWorkflow(id))
  ipcMain.handle(IPC.saveWorkflow, (_e, def: WorkflowDef) => saveWorkflow(def))
  // generate a workflow from a natural-language description (DeepSeek → validated → repaired once),
  // then persist it. Throws a clear message (surfaced in the panel) if no valid workflow results.
  ipcMain.handle(IPC.generateWorkflow, async (_e, description: string) => {
    const def = await engine.generateWorkflow(String(description ?? ''), `wf_${randomUUID()}`, Date.now())
    return saveWorkflow(def)
  })
  ipcMain.handle(IPC.deleteWorkflow, (_e, id: string) => deleteWorkflow(id))
  ipcMain.handle(IPC.listWorkflowRuns, (_e, workflowId?: string) => listWorkflowRuns(workflowId))
  ipcMain.handle(IPC.getWorkflowRun, (_e, runId: string) => getWorkflowRun(runId))
  ipcMain.handle(IPC.listTraces, (_e, sessionId?: string) => listTraces(sessionId))
  ipcMain.handle(IPC.getTrace, (_e, id: string) => getTrace(id))
  // swarm merge-gate: list/diff/merge/delete the swarm/* branches in the project repo
  const swarmCwd = (): string => validDir(settings.defaultCwd) || homedir()
  const swarmAc = (): AbortController => new AbortController()
  ipcMain.handle(IPC.swarmBranches, () => listSwarmBranches(swarmCwd(), swarmAc().signal))
  ipcMain.handle(IPC.swarmDiff, (_e, branch: string) => swarmBranchDiff(swarmCwd(), branch, swarmAc().signal))
  ipcMain.handle(IPC.swarmMerge, (_e, branch: string) => swarmMerge(swarmCwd(), branch, swarmAc().signal))
  ipcMain.handle(IPC.swarmDeleteBranch, (_e, branch: string) => swarmDeleteBranch(swarmCwd(), branch, swarmAc().signal))
  // ---- Time Machine: causal-replay scrubber over the three persisted per-turn stores ----
  // timeline/tick are pure reads (no git, no signal); fork/forks/forkDiff/deleteFork drive local-only
  // git worktrees, so each gets a throwaway AbortController exactly like swarmAc above.
  const tmAc = (): AbortController => new AbortController()
  ipcMain.handle(IPC.tmTimeline, (_e, sessionId: string) => buildTimeline(sessionId))
  ipcMain.handle(IPC.tmTick, (_e, sessionId: string, tick: number) => buildTickDetail(sessionId, tick))
  ipcMain.handle(IPC.tmFork, (_e, sessionId: string, tick: number) => branchFromHere(sessionId, tick, tmAc().signal))
  ipcMain.handle(IPC.tmForks, (_e, sessionId: string) => listForks(sessionId, tmAc().signal))
  ipcMain.handle(IPC.tmForkDiff, (_e, sessionId: string, branch: string) => forkDiff(sessionId, branch, tmAc().signal))
  ipcMain.handle(IPC.tmDeleteFork, (_e, sessionId: string, branch: string) => deleteFork(sessionId, branch, tmAc().signal))
  // export a workflow to a .json file the user picks (share / back up / move between machines)
  // ---- backup / restore (portable JSON export of the user's config) ----
  ipcMain.handle(IPC.exportBackup, async () => {
    const res = await dialog.showSaveDialog(currentWin ?? win, {
      title: 'Backup speichern',
      defaultPath: 'deepcode-backup.json',
      filters: [{ name: 'DeepCode Backup', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    atomicWriteJson(res.filePath, createBackup(app.getVersion(), Date.now()))
    return { ok: true, path: res.filePath }
  })
  ipcMain.handle(IPC.importBackup, async () => {
    const res = await dialog.showOpenDialog(currentWin ?? win, {
      title: 'Backup wiederherstellen',
      properties: ['openFile'],
      filters: [{ name: 'DeepCode Backup', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths?.[0]) return { ok: false }
    try {
      const bundle = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
      const { restored } = restoreBackup(bundle)
      // reload settings into the live object + engine so non-secret config takes effect without a
      // restart (projects/memory/workflows/automations are read fresh from disk on next use).
      settings = loadSettings()
      engine.updateSettings(settings)
      return { ok: true, restored }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.exportWorkflow, async (_e, id: string) => {
    const def = getWorkflow(id)
    if (!def) throw new Error('Workflow not found')
    const safeName = (def.name || 'workflow').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
    const res = await dialog.showSaveDialog(currentWin ?? win, {
      title: 'Workflow exportieren',
      defaultPath: `${safeName}.deepcode-workflow.json`,
      filters: [{ name: 'DeepCode Workflow', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return false
    writeFileSync(res.filePath, JSON.stringify(def, null, 2), 'utf8')
    return true
  })
  // import a workflow from a .json file — given a FRESH id so it can't overwrite an existing one
  ipcMain.handle(IPC.importWorkflow, async () => {
    const res = await dialog.showOpenDialog(currentWin ?? win, {
      title: 'Workflow importieren',
      properties: ['openFile'],
      filters: [{ name: 'DeepCode Workflow', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths?.[0]) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
    } catch {
      throw new Error('Datei ist kein gültiges JSON.')
    }
    const p = parsed as Partial<WorkflowDef>
    if (!p || typeof p !== 'object' || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) {
      throw new Error('Keine gültige Workflow-Datei (nodes/edges fehlen).')
    }
    // validate element SHAPE too — a null/typeless node or duplicate id would otherwise be
    // persisted and crash the editor on open / mis-route at run time. (shared type set)
    const okNode = (n: unknown): boolean =>
      !!n && typeof n === 'object' && typeof (n as { id?: unknown }).id === 'string' && !!(n as { id: string }).id && KNOWN_NODE_TYPES.has(String((n as { type?: unknown }).type))
    const okEdge = (e: unknown): boolean =>
      !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' && typeof (e as { source?: unknown }).source === 'string' && typeof (e as { target?: unknown }).target === 'string'
    if (!p.nodes.every(okNode) || !p.edges.every(okEdge)) {
      throw new Error('Keine gültige Workflow-Datei (Knoten/Verbindungen ungültig).')
    }
    const nodeIds = p.nodes.map((n) => (n as { id: string }).id)
    if (new Set(nodeIds).size !== nodeIds.length) {
      throw new Error('Keine gültige Workflow-Datei (doppelte Knoten-IDs).')
    }
    const now = Date.now()
    const def: WorkflowDef = {
      id: `wf_${randomUUID()}`, // fresh id — never clobber an existing workflow
      name: (typeof p.name === 'string' && p.name ? p.name : 'Importiert') + ' (Import)',
      description: typeof p.description === 'string' ? p.description : undefined,
      nodes: p.nodes,
      edges: p.edges,
      createdAt: now,
      updatedAt: now
    }
    return saveWorkflow(def)
  })
  // ---- workflow secrets (encrypted; values never leave main, only names are listed) ----
  ipcMain.handle(IPC.secretsList, () => listSecretNames())
  ipcMain.handle(IPC.secretSet, (_e, name: string, value: string) => {
    setSecret(name, value) // throws (clear message) on invalid name / no-encryption
    return true
  })
  ipcMain.handle(IPC.secretDelete, (_e, name: string) => {
    deleteSecret(name)
    return true
  })
  ipcMain.handle(IPC.cancelWorkflow, (_e, runId: string) => {
    wfAborters.get(runId)?.abort()
    return true
  })
  ipcMain.handle(IPC.runWorkflow, (_e, id: string, clientRunId?: string, vars?: Record<string, string>, fromNodeId?: string) => {
    const def = getWorkflow(id)
    if (!def) throw new Error('Workflow not found')
    // honour the renderer-supplied runId (it set its event-matching ref to this BEFORE
    // calling, so the first workflow_* events aren't missed) — but only if it's a safe
    // slug, since it ends up in a run filename; otherwise mint our own.
    const runId = typeof clientRunId === 'string' && /^[A-Za-z0-9_-]+$/.test(clientRunId) ? clientRunId : randomUUID()
    const ac = new AbortController()
    wfAborters.set(runId, ac)
    const stopDeadline = armDeadline(ac)
    const cwd = validDir(settings.defaultCwd) || homedir()
    // fire-and-forget: progress streams via workflow_* events; the renderer polls getRun
    runWorkflow(def, makeWfDeps(cwd, ac.signal, 0, undefined, new Set([def.id])), { vars, fromNodeId, runId })
      .catch((e: unknown) => {
        // executor already persists/streams failures per node, but guard the rare case
        // where the whole call rejects before any node ran (e.g. malformed def).
        emit({
          type: 'workflow_run',
          runId,
          workflowId: id,
          status: 'error',
          message: (e as Error)?.message ?? String(e)
        })
      })
      .finally(() => {
        stopDeadline()
        wfAborters.delete(runId)
      })
    return runId
  })
  // interactive "Reparieren": a FRESH run that self-heals on failure (force=true, regardless of
  // the autoHeal flag). Heal needs the LIVE unmasked vars of THIS run, so we re-run rather than
  // heal the old masked persisted run. beginAgentOp suppresses fs_change toasts for its writes.
  ipcMain.handle(IPC.healWorkflow, (_e, id: string, clientRunId?: string) => {
    const def = getWorkflow(id)
    if (!def) throw new Error('Workflow not found')
    const runId = typeof clientRunId === 'string' && /^[A-Za-z0-9_-]+$/.test(clientRunId) ? clientRunId : randomUUID()
    const ac = new AbortController()
    wfAborters.set(runId, ac)
    const stopDeadline = armDeadline(ac)
    const cwd = validDir(settings.defaultCwd) || homedir()
    beginAgentOp()
    ;(async () => {
      const deps = makeWfDeps(cwd, ac.signal, 0, undefined, new Set([def.id]))
      const run = await runWorkflow(def, deps, { runId })
      await maybeAutoHeal(def, run, deps, cwd, ac.signal, true)
    })()
      .catch((e: unknown) =>
        emit({ type: 'workflow_run', runId, workflowId: id, status: 'error', message: (e as Error)?.message ?? String(e) })
      )
      .finally(() => {
        endAgentOp()
        stopDeadline()
        wfAborters.delete(runId)
      })
    return runId
  })

  // ---- automations ----
  ipcMain.handle(IPC.listAutomations, () => loadAutomations())
  ipcMain.handle(IPC.saveAutomation, (_e, a: AutomationDef) => upsertAutomation(a))
  ipcMain.handle(IPC.deleteAutomation, (_e, id: string) => deleteAutomation(id))
  ipcMain.handle(IPC.runAutomation, async (_e, id: string) => {
    const a = loadAutomations().find((x) => x.id === id)
    if (a) await runAutomationNow(a, emit)
    return true
  })

  // ---- misc ----
  ipcMain.handle(IPC.pickDirectory, async () => {
    // 'createDirectory' adds a "New Folder" button on macOS; harmless on Windows (native
    // picker already has one). Authorize the chosen path for subsequent reads/preview.
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    pickedPaths.add(resolve(res.filePaths[0]))
    return res.filePaths[0]
  })
  // Create a brand-new project folder: pick a parent + a name, get a fresh empty dir back.
  // This is the missing half of "choose a folder as the chat workspace" — so a new project
  // lands in its own folder instead of only being able to adopt an existing one.
  ipcMain.handle(IPC.createDirectory, (_e, parent: string, name: string) => {
    const base = validDir(parent)
    if (!base) throw new Error('Übergeordneter Ordner existiert nicht: ' + parent)
    // safeFolderName keeps the name to a single segment (no traversal / illegal chars) so it
    // can't escape `base`; spaces and hyphens stay allowed. See paths.ts.
    const clean = safeFolderName(name)
    const target = join(base, clean)
    if (existsSync(target)) {
      let entries: string[] = ['?']
      try {
        entries = readdirSync(target)
      } catch {
        /* unreadable → treat as occupied */
      }
      if (entries.length > 0) throw new Error('Ordner existiert bereits und ist nicht leer: ' + target)
    }
    mkdirSync(target, { recursive: true })
    pickedPaths.add(resolve(target))
    return target
  })
  ipcMain.handle(IPC.pickFiles, async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled) return []
    // authorize these user-chosen paths for subsequent readFileHead/preview
    for (const f of res.filePaths) pickedPaths.add(resolve(f))
    return res.filePaths
  })
  ipcMain.handle(IPC.openConfigDir, () => {
    shell.openPath(PATHS.root)
    return true
  })
  ipcMain.handle(IPC.getCwdInfo, async (_e, cwd: string) => {
    // validDir wraps existsSync+statSync in try/catch (statSync can throw even when
    // existsSync passed: TOCTOU, EACCES, broken reparse point on Windows).
    const exists = !!validDir(cwd)
    let gitBranch: string | null = null
    let gitDirty = 0
    try {
      const head = join(cwd, '.git', 'HEAD')
      if (existsSync(head)) {
        const txt = readFileSync(head, 'utf8').trim()
        gitBranch = txt.startsWith('ref:') ? txt.split('/').pop() || null : txt.slice(0, 8)
        gitDirty = await new Promise<number>((resolve) => {
          let settled = false
          const finish = (n: number): void => {
            if (settled) return
            settled = true
            clearTimeout(t)
            resolve(n)
          }
          const t = setTimeout(() => finish(0), 2500)
          execFile('git', ['status', '--porcelain'], { cwd, timeout: 2000 }, (err, stdout) => {
            finish(err ? 0 : stdout.split('\n').filter(Boolean).length)
          })
        })
      }
    } catch {
      /* not a repo */
    }
    return { cwd, exists, gitBranch, gitDirty }
  })

  // ---- automation scheduler ----
  const scheduler = new AutomationScheduler((a) => runAutomationNow(a, emit))
  scheduler.start()

  // ---- workflow trigger scheduler (cron) ----
  // fires saved workflows whose trigger node is set to mode='cron'. Runs unattended via
  // the same guarded deps as a manual run (dangerous-command screen, MCP/claude_code gate).
  // shared by the cron scheduler AND the file-watch manager: one guarded, unattended run.
  // `input` (the changed file list) is injected as {{input}}/{{last}} by the file-watch trigger.
  const runTriggeredWorkflow = async (def: WorkflowDef, input?: string): Promise<void> => {
    // daily spend cap: skip a scheduled (unattended) workflow run once today's budget is used up.
    if (overDailyCap(settings.maxCostPerDay)) {
      console.info(`[budget] Triggered workflow "${def.name}" skipped — daily cap $${settings.maxCostPerDay} reached.`)
      return
    }
    const runId = randomUUID()
    const ac = new AbortController()
    wfAborters.set(runId, ac)
    const stopDeadline = armDeadline(ac)
    const cwd = validDir(settings.defaultCwd) || homedir()
    const vars = input ? { input, last: input } : undefined
    // suppress file-watcher "externally changed" toasts for files this background run touches
    beginAgentOp()
    try {
      const deps = makeWfDeps(cwd, ac.signal, 0, undefined, new Set([def.id]))
      const run = await runWorkflow(def, deps, { runId, vars })
      // opt-in self-healing: repair a failed node + replay (bounded), unattended-gated
      await maybeAutoHeal(def, run, deps, cwd, ac.signal)
    } catch (e: unknown) {
      emit({ type: 'workflow_run', runId, workflowId: def.id, status: 'error', message: (e as Error)?.message ?? String(e) })
    } finally {
      endAgentOp()
      stopDeadline()
      wfAborters.delete(runId)
    }
  }
  const wfScheduler = new WorkflowScheduler(runTriggeredWorkflow)
  wfScheduler.start()

  // ---- mission overnight operator (scheduler) ----
  // Auto-starts SCHEDULED missions inside their off-peak window / cron minute via the SAME guarded
  // launch path as a manual start (one-mission-at-a-time, machine verify gate, local-only git). The
  // scheduler already serializes to one in-flight run; here we additionally SKIP (rather than fail)
  // when the daily cap is hit or the working tree is dirty, so a nightly mission stays scheduled and
  // simply retries on the next eligible tick instead of flipping to 'failed'.
  const runScheduledMission = async (mission: Mission): Promise<void> => {
    if (missionRunning) return // one at a time — another mission is already running; retry next tick
    if (!mission.verifyCommand || !mission.verifyCommand.trim()) {
      console.info(`[mission] scheduled "${mission.goal.slice(0, 40)}" skipped — no verify command.`)
      return
    }
    if (overDailyCap(settings.maxCostPerDay)) {
      console.info(`[mission] scheduled "${mission.goal.slice(0, 40)}" skipped — daily cap $${settings.maxCostPerDay} reached.`)
      return
    }
    // clean-tree pre-check: don't even start (the overseer would fail-closed + brand it 'failed',
    // which would un-schedule the nightly run). Skip quietly and retry when the tree is clean.
    try {
      const cwd = validDir(mission.cwd) || validDir(settings.defaultCwd) || homedir()
      const st = await runGit(['status', '--porcelain'], cwd, new AbortController().signal)
      if (st.code === 0 && st.out.trim()) {
        console.info(`[mission] scheduled "${mission.goal.slice(0, 40)}" skipped — working tree dirty.`)
        return
      }
    } catch {
      return // can't check the tree → don't risk an unattended commit; retry next tick
    }
    try {
      launchMission(mission)
    } catch {
      /* one-at-a-time guard raced us between the check and launch — retry next tick */
    }
  }
  const missionScheduler = new MissionScheduler((m) => runScheduledMission(m))
  missionScheduler.start()

  // ---- workflow file-watch trigger ----
  // fires saved workflows whose trigger node is set to mode='filewatch' when a matching file
  // under the project changes. Shares the guarded runner + the agent-busy suppression so a
  // run's own writes never re-trigger it.
  const wfWatch = new WorkflowWatchManager(runTriggeredWorkflow, () => validDir(settings.defaultCwd) || homedir())
  wfWatch.start()
}

async function runAutomationNow(a: AutomationDef, emit: (e: AgentEvent) => void): Promise<void> {
  // daily spend cap: an unattended automation must not run once today's budget is used up.
  if (overDailyCap(settings.maxCostPerDay)) {
    console.info(`[budget] Automation "${a.name}" skipped — daily cap $${settings.maxCostPerDay} reached.`)
    return
  }
  const session: Session = {
    id: randomUUID(),
    title: `[auto] ${a.name}`,
    cwd: validDir(a.cwd) || validDir(settings.defaultCwd) || homedir(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    model: settings.provider.model
  }
  saveSession(session)
  // stamp the session id so the renderer's cross-session guard drops this status
  // (and the turn's own events) instead of flashing them in the foreground chat.
  emit({ type: 'status', sessionId: session.id, message: `Automation "${a.name}" running...` })
  // 'safe' = only auto-approved reads run unattended; 'full' = writes + shell too.
  const policy = a.autonomy === 'full' ? 'full' : 'safe'
  // automations are headless/unattended too → same gate as workflow agent nodes: block
  // MCP / claude_code / task / git push|pr (no user present to approve outward actions).
  // wrap in beginAgentOp/endAgentOp so the file watcher suppresses change toasts for files this
  // background run touches (mirrors Night Shift) — otherwise the foreground chat flashes spurious
  // "externally changed" notices.
  beginAgentOp()
  try {
    await engine.runTurn(session, a.prompt, emit, policy, undefined, true)
  } finally {
    endAgentOp()
  }
}

function validDir(p?: string): string | null {
  if (!p) return null
  try {
    return existsSync(p) && statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

// connect enabled MCP servers in the background after startup
export function bootstrapMcp(): void {
  mcpManager.connectAllEnabled().catch((e) => console.error('MCP bootstrap error:', e))
}
