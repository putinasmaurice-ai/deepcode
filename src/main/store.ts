import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { PATHS, ensureConfigDirs } from './paths'
import { AppSettings, DEFAULT_SETTINGS, Session } from '@shared/types'

// ---- Settings ----

export function loadSettings(): AppSettings {
  ensureConfigDirs()
  try {
    if (existsSync(PATHS.settings)) {
      const raw = JSON.parse(readFileSync(PATHS.settings, 'utf8'))
      // deep-merge over defaults so new fields are filled in
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        provider: { ...DEFAULT_SETTINGS.provider, ...(raw.provider ?? {}) },
        autoApprove: { ...DEFAULT_SETTINGS.autoApprove, ...(raw.autoApprove ?? {}) }
      }
    }
  } catch (err) {
    console.error('Failed to load settings:', err)
  }
  const s = { ...DEFAULT_SETTINGS, defaultCwd: homedir() }
  saveSettings(s)
  return s
}

export function saveSettings(settings: AppSettings): void {
  ensureConfigDirs()
  writeFileSync(PATHS.settings, JSON.stringify(settings, null, 2), 'utf8')
}

// ---- Sessions ----

function sessionPath(id: string): string {
  return join(PATHS.sessions, `${id}.json`)
}

export function listSessions(): Session[] {
  ensureConfigDirs()
  const out: Session[] = []
  for (const f of readdirSync(PATHS.sessions)) {
    if (!f.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(PATHS.sessions, f), 'utf8')) as Session
      // strip heavy messages for the list view
      out.push({ ...s, messages: [] })
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSession(id: string): Session | null {
  const p = sessionPath(id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Session
  } catch {
    return null
  }
}

export function saveSession(session: Session): void {
  ensureConfigDirs()
  session.updatedAt = Date.now()
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), 'utf8')
}

export function deleteSession(id: string): void {
  const p = sessionPath(id)
  if (existsSync(p)) unlinkSync(p)
}
