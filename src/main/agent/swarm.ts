import { join } from 'path'
import { rmSync } from 'fs'
import { randomUUID } from 'crypto'
import { AgentEvent } from '@shared/types'
import { PATHS, safeId } from '../paths'
import { runGit } from './tools/git'
import { runPool } from '../workflows/pool'

// Swarm mode: run N agents IN PARALLEL, each in its OWN isolated git worktree + branch, so their
// edits physically can't collide. A planner shards the task; each worker is a normal subagent
// bound to its worktree cwd; its changes are committed to its branch; the worktree is then torn
// down (the branch survives for the user to review/merge). This is a FIRST-CLASS orchestrator
// (engine.runSwarm), NOT the unattended-blocked `task` tool.

export interface SwarmShard {
  label: string
  prompt: string
}
export interface SwarmWorker {
  branch: string
  label: string
  ok: boolean
  summary: string
  diffStat: string
  costUsd: number
  tokens: number
}

export interface SwarmRunDeps {
  // run one worker (a subagent) bound to its worktree cwd; onUsage bubbles each billed round
  runWorker: (prompt: string, cwd: string, onUsage: (u: { cost: number; totalTokens: number }) => void) => Promise<string>
  emit: (e: AgentEvent) => void
  signal: AbortSignal
  deadline?: number
  concurrency: number
  // hard ceiling on TOTAL swarm spend: once the workers' accumulated cost crosses this, no further
  // workers are launched. The daily cap is only checked at run START, so without this a single
  // parallel run could overshoot the day's budget. Undefined / 0 = no cap.
  costCapUsd?: number
}

function slug(s: string): string {
  return (s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'task'
}

// Planner: split a task into independent, non-file-overlapping shards (the LLM call is done by
// the caller; this is the pure prompt + tolerant parser, unit-testable like workflow-gen).
export function buildPlanPrompt(task: string, maxWorkers: number): string {
  return (
    `Du planst PARALLELE, UNABHÄNGIGE Arbeitsströme für eine Coding-Aufgabe, die GLEICHZEITIG in getrennten git-Worktrees laufen. ` +
    `Zerlege die Aufgabe in 2 bis ${maxWorkers} Teilaufgaben, die sich möglichst NICHT in denselben Dateien überschneiden (sonst Merge-Konflikte). ` +
    `Gib NUR striktes JSON zurück: {"shards":[{"label":"kurzer Name","prompt":"vollständige, eigenständige Anweisung für einen Coder-Agenten in seinem Worktree — was genau zu tun ist, welche Dateien betroffen sind"}]}. ` +
    `WICHTIG für jeden prompt: der Worktree hat KEINE installierten Abhängigkeiten (kein node_modules) — die Worker dürfen NUR Quelldateien editieren und KEINE Build-/Test-/Lint-/git-Befehle ausführen (der Orchestrator committet selbst). ` +
    `Lässt sich die Aufgabe nicht sinnvoll parallelisieren, gib genau 1 Shard zurück.\n\nAufgabe: ${task}`
  )
}

export function parseShards(text: string, maxWorkers: number): SwarmShard[] {
  const candidates: string[] = []
  const fence = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim()) as { shards?: unknown }
      const arr = Array.isArray(o.shards) ? o.shards : []
      const shards = arr
        .map((s) => s as Record<string, unknown>)
        .filter((s) => s && typeof s.prompt === 'string' && (s.prompt as string).trim())
        .map((s) => ({ label: String(s.label || 'Teilaufgabe').slice(0, 60), prompt: String(s.prompt).slice(0, 8000) }))
        .slice(0, Math.max(1, maxWorkers))
      if (shards.length) return shards
    } catch {
      /* try next candidate */
    }
  }
  return []
}

export function formatSwarmReport(workers: SwarmWorker[], capped?: boolean): string {
  const okN = workers.filter((w) => w.ok).length
  const cost = workers.reduce((a, w) => a + w.costUsd, 0)
  const lines = workers.map(
    (w) => `${w.ok ? '✅' : '❌'} \`${w.branch}\` — ${w.label}${w.diffStat ? `\n${w.diffStat.trim()}` : ''}`
  )
  const capNote = capped
    ? `\n\n⚠️ Kosten-Limit erreicht — weitere Worker wurden NICHT gestartet (bereits fertige bleiben committet).`
    : ''
  return (
    `🐝 Schwarm fertig: ${okN}/${workers.length} Worker erfolgreich${cost ? ` · ≈ $${cost.toFixed(4)}` : ''}.` +
    capNote +
    `\n\n` +
    lines.join('\n\n') +
    `\n\nJeder Worker hat seine Änderung als eigenen Branch committet (Worktrees wurden aufgeräumt). ` +
    `Prüfe/merge die Branches z.B. mit dem git-Tool: \`git merge <branch>\` (oder einzeln per Diff). ` +
    `Hinweis: Branches mit Datei-Überschneidung können beim Merge kollidieren.`
  )
}

// Verify the project is a git repo — swarm needs worktrees.
export async function isGitRepo(cwd: string, signal: AbortSignal): Promise<boolean> {
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, signal)
  return r.code === 0 && /true/.test(r.out)
}

export async function runSwarm(
  shards: SwarmShard[],
  projectCwd: string,
  sessionId: string,
  deps: SwarmRunDeps
): Promise<{ runId: string; workers: SwarmWorker[]; capped: boolean }> {
  const runId = randomUUID()
  const tag = runId.slice(0, 12) // long enough that cross-run branch/dir collisions are negligible
  const root = join(PATHS.swarm, safeId(sessionId), tag)
  // teardown MUST run even after the user/deadline aborts — runGit short-circuits on an aborted
  // signal, so a separate non-aborted signal is used for all cleanup git ops.
  const td = new AbortController().signal
  // Internal run signal: aborts when the user/deadline aborts (deps.signal) OR when the cost cap is
  // hit. It gates worktree creation + worker launching, so a cap STOPS launching new workers while
  // letting in-flight ones finish. The COMMIT phase stays gated on deps.signal only — so a cost cap
  // still commits the workers that completed, whereas a user/deadline abort discards partial work.
  const runCtl = new AbortController()
  const onParentAbort = (): void => runCtl.abort()
  if (deps.signal.aborted) runCtl.abort()
  else deps.signal.addEventListener('abort', onParentAbort, { once: true })
  let totalCost = 0
  let capped = false
  deps.emit({ type: 'swarm_run', runId, status: 'start', total: shards.length })

  // git metadata ops (worktree add/remove, commit, refs) on ONE repo can race on the .git lock,
  // so do all git plumbing SEQUENTIALLY and parallelize only the expensive agent work.
  type Live = { w: SwarmWorker; dir: string; created: boolean; preserve: boolean }
  const live: Live[] = shards.map((s, i) => ({
    w: { branch: `swarm/${tag}/${i}-${slug(s.label)}`, label: s.label, ok: false, summary: '', diffStat: '', costUsd: 0, tokens: 0 },
    dir: join(root, `w${i}`),
    created: false,
    preserve: false
  }))

  try {
    // Phase 1: create each worktree on its own new branch (sequential — avoids .git lock races)
    for (const L of live) {
      if (runCtl.signal.aborted) break
      const add = await runGit(['worktree', 'add', L.dir, '-b', L.w.branch], projectCwd, runCtl.signal)
      L.created = add.code === 0
      if (!L.created) {
        L.w.summary = 'worktree add fehlgeschlagen: ' + add.out.slice(0, 300)
        deps.emit({ type: 'swarm_worker', runId, branch: L.w.branch, status: 'failed', message: L.w.summary })
      }
    }

    // Phase 2: run the worker agents IN PARALLEL, each bound to its worktree cwd. Catch the pool
    // rejection (abort/deadline) so we still finalize + report what completed.
    const tasks = live
      .filter((L) => L.created)
      .map((L) => {
        const prompt = shards[live.indexOf(L)].prompt
        return async (): Promise<void> => {
          deps.emit({ type: 'swarm_worker', runId, branch: L.w.branch, status: 'running', message: L.w.label })
          try {
            const text = await deps.runWorker(prompt, L.dir, (u) => {
              L.w.costUsd += u.cost
              L.w.tokens += u.totalTokens
              totalCost += u.cost
              if (deps.costCapUsd != null && deps.costCapUsd > 0 && totalCost >= deps.costCapUsd && !capped) {
                capped = true
                runCtl.abort() // stop launching further workers; in-flight ones finish
              }
            })
            L.w.summary = String(text || '').slice(0, 600)
          } catch (e) {
            L.w.summary = (e as Error).message
          }
        }
      })
    try {
      await runPool(tasks.map((t) => () => t().catch(() => undefined)), deps.concurrency, runCtl.signal, deps.deadline)
    } catch {
      /* abort/deadline/cost-cap rejected the pool — fall through to finalize/teardown */
    }

    // Phase 3: commit each worktree (sequential). Skipped on abort — partial work isn't trustworthy
    // and is discarded by the teardown. NEVER --force-discard a worker's output on a real commit
    // failure: preserve that worktree and report where it is.
    if (!deps.signal.aborted) {
      for (const L of live) {
        if (!L.created) continue
        await runGit(['add', '-A'], L.dir, td)
        const commit = await runGit(['commit', '-m', `swarm: ${L.w.label}`], L.dir, td)
        if (commit.code === 0) {
          const stat = await runGit(['diff', '--stat', 'HEAD~1..HEAD'], L.dir, td)
          L.w.diffStat = stat.out.slice(0, 1000)
          L.w.ok = !!L.w.summary
        } else {
          const dirty = await runGit(['status', '--porcelain'], L.dir, td)
          if (dirty.out.trim()) {
            // real changes but commit failed (hook/identity/lock) — DON'T discard; keep the worktree
            L.preserve = true
            L.w.ok = false
            L.w.diffStat = `⚠ Commit fehlgeschlagen — Worktree behalten unter ${L.dir}: ${commit.out.slice(0, 200)}`
          } else {
            L.w.diffStat = '(keine Änderungen)'
            L.w.ok = false
          }
        }
        deps.emit({ type: 'swarm_worker', runId, branch: L.w.branch, status: L.w.ok ? 'done' : 'failed', message: L.w.diffStat || L.w.summary })
      }
    }
  } finally {
    deps.signal.removeEventListener('abort', onParentAbort)
    // teardown on the NON-aborted `td` signal so Stop/deadline can't neuter it. Remove every
    // created worktree except those deliberately preserved (commit-failed-with-changes).
    for (const L of live) {
      if (L.created && !L.preserve) await runGit(['worktree', 'remove', '--force', L.dir], projectCwd, td)
    }
    await runGit(['worktree', 'prune'], projectCwd, td)
    if (!live.some((L) => L.preserve)) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort — clears the empty parent dir */
      }
    }
  }
  deps.emit({ type: 'swarm_run', runId, status: 'done', total: shards.length })
  return { runId, workers: live.map((L) => L.w), capped }
}
