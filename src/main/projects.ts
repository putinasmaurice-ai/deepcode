import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from './atomic'
import { PATHS, ensureConfigDirs } from './paths'
import { ProjectDef } from '@shared/types'
import { listSessions, deleteSession } from './store'

// Projects are a first-class grouping for sessions: a name + working dir +
// always-on instructions + the active goal. Stored in ~/.deepcode/projects.json.

const FILE = join(PATHS.root, 'projects.json')

export function loadProjects(): ProjectDef[] {
  ensureConfigDirs()
  if (!existsSync(FILE)) return []
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as ProjectDef[]
  } catch {
    return []
  }
}

export function getProject(id: string): ProjectDef | null {
  return loadProjects().find((p) => p.id === id) ?? null
}

export function upsertProject(p: ProjectDef): ProjectDef[] {
  const list = loadProjects()
  const idx = list.findIndex((x) => x.id === p.id)
  p.updatedAt = Date.now()
  if (idx >= 0) list[idx] = p
  else list.push(p)
  atomicWriteJson(FILE, list)
  return list
}

export function deleteProject(id: string): ProjectDef[] {
  const list = loadProjects().filter((x) => x.id !== id)
  atomicWriteJson(FILE, list)
  // cascade: a project's sessions would otherwise orphan in the usage panel
  for (const s of listSessions()) {
    if (s.projectId === id) deleteSession(s.id)
  }
  return list
}
