import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import { safeStorage } from 'electron'
import { PATHS, ensureConfigDirs, safeId } from './paths'
import { deleteSessionCheckpoints } from './checkpoints'
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
      // Google AI Studio key — same encrypted-at-rest treatment as the DeepSeek key.
      if (raw._googleKeyEnc && encryptionOk()) {
        try {
          merged.provider.googleApiKey = safeStorage.decryptString(Buffer.from(raw._googleKeyEnc, 'base64'))
        } catch {
          /* leave whatever plaintext key may exist */
        }
      }
      // DeepInfra key — same treatment.
      if (raw._deepinfraKeyEnc && encryptionOk()) {
        try {
          merged.provider.deepinfraApiKey = safeStorage.decryptString(Buffer.from(raw._deepinfraKeyEnc, 'base64'))
        } catch {
          /* leave whatever plaintext key may exist */
        }
      }
      // Dev/test hook only: lets automated launches (Playwright/CI) supply a key when
      // safeStorage can't decrypt outside the interactive user session. Never set in
      // normal use.
      if (process.env.DEEPCODE_DEV_API_KEY) merged.provider.apiKey = process.env.DEEPCODE_DEV_API_KEY
      if (process.env.DEEPCODE_DEV_GOOGLE_KEY) merged.provider.googleApiKey = process.env.DEEPCODE_DEV_GOOGLE_KEY
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
  const gkey = settings.provider.googleApiKey ?? ''
  const dikey = settings.provider.deepinfraApiKey ?? ''
  // Persist keys encrypted; never write them in plaintext when encryption works.
  const onDisk: any = {
    ...settings,
    provider: { ...settings.provider, apiKey: '', googleApiKey: '', deepinfraApiKey: '' }
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
  if (gkey && encryptionOk()) {
    try {
      onDisk._googleKeyEnc = safeStorage.encryptString(gkey).toString('base64')
    } catch {
      onDisk.provider.googleApiKey = gkey
    }
  } else if (gkey) {
    onDisk.provider.googleApiKey = gkey
  }
  if (dikey && encryptionOk()) {
    try {
      onDisk._deepinfraKeyEnc = safeStorage.encryptString(dikey).toString('base64')
    } catch {
      onDisk.provider.deepinfraApiKey = dikey
    }
  } else if (dikey) {
    onDisk.provider.deepinfraApiKey = dikey
  }
  // atomic write (tmp + rename) so a crash/power-loss mid-write can't truncate settings.json
  // and silently wipe the three encrypted API keys (loadSettings would then overwrite with
  // defaults). A unique tmp name avoids a torn write if two windows save concurrently.
  const tmp = `${PATHS.settings}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf8')
    renameSync(tmp, PATHS.settings)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore cleanup failure */
    }
    throw e
  }
}

// ---- Sessions ----

function sessionPath(id: string): string {
  return join(PATHS.sessions, `${safeId(id)}.json`) // reject traversal ids before any fs op
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
  let p: string
  try {
    p = sessionPath(id) // invalid/traversal id → treat as not-found, never throw to the caller
  } catch {
    return null
  }
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Session
  } catch {
    return null
  }
}

// Tombstones for deleted sessions. A turn still running when the user deletes its
// chat would otherwise re-create the file/cache via its next saveSession (incl. the
// unconditional one in runTurn's finally), resurrecting a deleted chat as a zombie.
const tombstoned = new Set<string>()

export function saveSession(session: Session): void {
  if (tombstoned.has(session.id)) return // deleted mid-turn — don't resurrect it
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
  let p: string
  try {
    p = sessionPath(id) // validate the id ONCE here before it reaches unlink + recursive rmSync
  } catch {
    return // invalid/traversal id — nothing to delete, and must never reach checkpoints rmSync
  }
  tombstoned.add(id)
  if (existsSync(p)) unlinkSync(p)
  sessionCache?.delete(id)
  deleteSessionCheckpoints(id) // don't leave orphaned snapshot dirs behind
}
