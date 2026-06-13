import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { safeStorage } from 'electron'
import { PATHS, ensureConfigDirs } from './paths'
import { AppSettings, DEFAULT_SETTINGS, Session } from '@shared/types'

// ---- Settings ----

function encryptionOk(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function loadSettings(): AppSettings {
  ensureConfigDirs()
  try {
    if (existsSync(PATHS.settings)) {
      const raw = JSON.parse(readFileSync(PATHS.settings, 'utf8'))
      const merged: AppSettings = {
        ...DEFAULT_SETTINGS,
        ...raw,
        provider: { ...DEFAULT_SETTINGS.provider, ...(raw.provider ?? {}) },
        autoApprove: { ...DEFAULT_SETTINGS.autoApprove, ...(raw.autoApprove ?? {}) },
        claudeCode: { ...DEFAULT_SETTINGS.claudeCode, ...(raw.claudeCode ?? {}) }
      }
      // Decrypt the API key from OS secure storage if present.
      if (raw._apiKeyEnc && encryptionOk()) {
        try {
          merged.provider.apiKey = safeStorage.decryptString(Buffer.from(raw._apiKeyEnc, 'base64'))
        } catch {
          /* leave whatever plaintext key may exist */
        }
      }
      return merged
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
  const key = settings.provider.apiKey ?? ''
  // Persist the key encrypted; never write it in plaintext when encryption works.
  const onDisk: any = {
    ...settings,
    provider: { ...settings.provider, apiKey: '' }
  }
  if (key && encryptionOk()) {
    try {
      onDisk._apiKeyEnc = safeStorage.encryptString(key).toString('base64')
    } catch {
      onDisk.provider.apiKey = key // fall back to plaintext if encryption fails
    }
  } else if (key) {
    onDisk.provider.apiKey = key // encryption unavailable on this platform
  }
  writeFileSync(PATHS.settings, JSON.stringify(onDisk, null, 2), 'utf8')
}

// ---- Sessions ----

function sessionPath(id: string): string {
  return join(PATHS.sessions, `${id}.json`)
}

// In-memory metadata cache: listSessions() is called after every turn; without
// this it re-parses every session JSON (grows linearly with history).
let sessionCache: Map<string, Session> | null = null

function ensureSessionCache(): Map<string, Session> {
  if (sessionCache) return sessionCache
  ensureConfigDirs()
  sessionCache = new Map()
  for (const f of readdirSync(PATHS.sessions)) {
    if (!f.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(PATHS.sessions, f), 'utf8')) as Session
      sessionCache.set(s.id, { ...s, messages: [] }) // metadata only
    } catch (err) {
      console.error('Corrupt session file skipped:', f, err)
    }
  }
  return sessionCache
}

export function listSessions(): Session[] {
  return [...ensureSessionCache().values()].sort((a, b) => b.updatedAt - a.updatedAt)
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
  // atomic write: tmp + rename, so a crash mid-write can't corrupt the session
  const target = sessionPath(session.id)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8')
  renameSync(tmp, target)
  ensureSessionCache().set(session.id, { ...session, messages: [] })
}

export function deleteSession(id: string): void {
  const p = sessionPath(id)
  if (existsSync(p)) unlinkSync(p)
  sessionCache?.delete(id)
}
