import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS, ensureConfigDirs } from './paths'
import { ProjectDef } from '@shared/types'

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
  writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8')
  return list
}

export function deleteProject(id: string): ProjectDef[] {
  const list = loadProjects().filter((x) => x.id !== id)
  writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8')
  return list
}
