import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS } from '../paths'
import { Mission, MissionTask } from '@shared/types'

// Persistence for Mission Control: one JSON file per mission under ~/.deepcode/missions/.
// Atomic writes (tmp + rename) so a crash mid-write can't corrupt a mission file, mirroring
// workflows/store.ts. The overseer persists after EVERY task state change so a restart can
// resume — skipping done tasks and not re-committing them.

const DIR = join(PATHS.root, 'missions')

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
}

// Reject any id that isn't a plain slug — an id like '..\\..\\settings' would otherwise let
// saveMission/deleteMission write or unlink arbitrary .json files outside the missions dir.
// ids are randomUUID() in normal use. Mirrors the safeId in workflows/store.ts.
function safeId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid mission id: ${String(id).slice(0, 40)}`)
  }
  return id
}

const missionPath = (id: string): string => join(DIR, `${safeId(id)}.json`)

function atomicWrite(path: string, data: unknown): void {
  ensureDir()
  // randomUUID (not pid) so two writes to the same target within one process can't collide on
  // the tmp name; clean up the tmp if the rename fails (AV lock / disk full / EPERM).
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

export function listMissions(): Mission[] {
  if (!existsSync(DIR)) return []
  const out: Mission[] = []
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Mission)
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getMission(id: string): Mission | null {
  const p = missionPath(id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Mission
  } catch {
    return null
  }
}

export function saveMission(m: Mission): Mission {
  m.updatedAt = Date.now()
  atomicWrite(missionPath(m.id), m)
  return m
}

export function deleteMission(id: string): boolean {
  const p = missionPath(id)
  if (existsSync(p)) unlinkSync(p)
  return true
}

// Merge a patch for ONE task into the persisted mission by id, without rewriting the whole task
// list from a stale in-memory snapshot. Re-reads from disk so a long overseer run can't clobber
// a concurrent user edit, and won't resurrect a task removed mid-run (skipped when not found).
// Mirrors nightshift.ts updateTask.
export function updateMissionTask(missionId: string, taskId: string, patch: Partial<MissionTask>): void {
  const cur = getMission(missionId)
  if (!cur) return
  const idx = cur.tasks.findIndex((t) => t.id === taskId)
  if (idx < 0) return
  cur.tasks[idx] = { ...cur.tasks[idx], ...patch }
  saveMission(cur)
}
