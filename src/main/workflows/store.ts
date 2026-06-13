import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS, ensureConfigDirs } from '../paths'
import { WorkflowDef, WorkflowRun } from '@shared/types'

// Persistence for visual workflows + their runs. One JSON file per workflow under
// ~/.deepcode/workflows/, runs under workflows/runs/. Atomic writes (tmp+rename).
// The executor only ever persists RUNS (never workflow defs), so a still-running
// executor can't resurrect a deleted workflow — no tombstone needed.

const MAX_RUNS = 200 // keep the newest N run files; older ones are pruned

function atomicWrite(path: string, data: unknown): void {
  ensureConfigDirs()
  // randomUUID (not pid) so two writes to the same target within one process can't collide
  // on the tmp name; clean up the tmp if the rename fails (AV lock / disk full / EPERM)
  // instead of leaving an orphan behind.
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best-effort cleanup */
    }
    throw e
  }
}

// Reject any id that isn't a plain slug — an id like '..\\..\\settings' would otherwise
// let saveWorkflow/deleteWorkflow write or unlink arbitrary .json files (settings,
// sessions) outside the workflows dir. ids are uid()/randomUUID() in normal use.
function safeId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid workflow id: ${String(id).slice(0, 40)}`)
  }
  return id
}

const wfPath = (id: string): string => join(PATHS.workflows, `${safeId(id)}.json`)
const runPath = (id: string): string => join(PATHS.workflowRuns, `${safeId(id)}.json`)

export function listWorkflows(): WorkflowDef[] {
  if (!existsSync(PATHS.workflows)) return []
  const out: WorkflowDef[] = []
  for (const f of readdirSync(PATHS.workflows)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(PATHS.workflows, f), 'utf8')) as WorkflowDef)
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getWorkflow(id: string): WorkflowDef | null {
  const p = wfPath(id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WorkflowDef
  } catch {
    return null
  }
}

export function saveWorkflow(def: WorkflowDef): WorkflowDef {
  def.updatedAt = Date.now()
  atomicWrite(wfPath(def.id), def)
  return def
}

export function deleteWorkflow(id: string): boolean {
  const p = wfPath(id)
  if (existsSync(p)) unlinkSync(p)
  return true
}

// Delete the oldest run files once the directory exceeds MAX_RUNS, so a busy
// workflow can't grow the run history without bound. Cheap because it only runs
// when a run reaches a terminal state (once per run, not per node).
function pruneRuns(): void {
  try {
    const files = readdirSync(PATHS.workflowRuns).filter((f) => f.endsWith('.json'))
    if (files.length <= MAX_RUNS) return
    const withTime = files.map((f) => {
      const full = join(PATHS.workflowRuns, f)
      let mtime = 0
      let running = false
      try {
        mtime = statSync(full).mtimeMs
        // never prune a run that is still in flight — its file is the live record the
        // editor polls and the executor is about to rewrite.
        running = (JSON.parse(readFileSync(full, 'utf8')) as WorkflowRun).status === 'running'
      } catch {
        /* unreadable → treat as prunable */
      }
      return { full, mtime, running }
    })
    const prunable = withTime.filter((x) => !x.running).sort((a, b) => a.mtime - b.mtime) // oldest first
    const excess = withTime.length - MAX_RUNS
    for (const { full } of prunable.slice(0, excess)) {
      try {
        unlinkSync(full)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export function saveRun(run: WorkflowRun): void {
  atomicWrite(runPath(run.id), run)
  if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') pruneRuns()
}

export function getRun(id: string): WorkflowRun | null {
  const p = runPath(id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WorkflowRun
  } catch {
    return null
  }
}

// Most recent runs (optionally for one workflow), capped for the run-history UI.
export function listRuns(workflowId?: string, limit = 50): WorkflowRun[] {
  if (!existsSync(PATHS.workflowRuns)) return []
  const out: WorkflowRun[] = []
  for (const f of readdirSync(PATHS.workflowRuns)) {
    if (!f.endsWith('.json')) continue
    try {
      const r = JSON.parse(readFileSync(join(PATHS.workflowRuns, f), 'utf8')) as WorkflowRun
      if (!workflowId || r.workflowId === workflowId) out.push(r)
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}
