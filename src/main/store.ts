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
      // OpenAI key — same treatment.
      if (raw._openaiKeyEnc && encryptionOk()) {
        try {
          merged.provider.openaiApiKey = safeStorage.decryptString(Buffer.from(raw._openaiKeyEnc, 'base64'))
        } catch {
          /* leave whatever plaintext key may exist */
        }
      }
      // Together AI key — same treatment.
      if (raw._togetherKeyEnc && encryptionOk()) {
        try {
          merged.provider.togetherApiKey = safeStorage.decryptString(Buffer.from(raw._togetherKeyEnc, 'base64'))
        } catch {
          /* leave whatever plaintext key may exist */
        }
      }
      // Xiaomi MiMo key — same treatment.
      if (raw._mimoKeyEnc && encryptionOk()) {
        try {
          merged.provider.mimoApiKey = safeStorage.decryptString(Buffer.from(raw._mimoKeyEnc, 'base64'))
        } catch {
          /* leave whatever plaintext key may exist */
        }
      }
      // Kilo Code key — same treatment.
      if (raw._kiloKeyEnc && encryptionOk()) {
        try {
          merged.provider.kiloApiKey = safeStorage.decryptString(Buffer.from(raw._kiloKeyEnc, 'base64'))
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
  const oakey = settings.provider.openaiApiKey ?? ''
  const tkey = settings.provider.togetherApiKey ?? ''
  const mkey = settings.provider.mimoApiKey ?? ''
  const kkey = settings.provider.kiloApiKey ?? ''
  // Persist keys encrypted; never write them in plaintext when encryption works.
  const onDisk: any = {
    ...settings,
    provider: { ...settings.provider, apiKey: '', googleApiKey: '', deepinfraApiKey: '', openaiApiKey: '', togetherApiKey: '', mimoApiKey: '', kiloApiKey: '' }
  }
  // clamp maxTokens: a cleared field persists 0/NaN which the API rejects — coerce back to default.
  const mt = Number(onDisk.provider.maxTokens)
  if (!Number.isFinite(mt) || mt < 1) onDisk.provider.maxTokens = DEFAULT_SETTINGS.provider.maxTokens
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
  if (oakey && encryptionOk()) {
    try {
      onDisk._openaiKeyEnc = safeStorage.encryptString(oakey).toString('base64')
    } catch {
      onDisk.provider.openaiApiKey = oakey
    }
  } else if (oakey) {
    onDisk.provider.openaiApiKey = oakey
  }
  if (tkey && encryptionOk()) {
    try {
      onDisk._togetherKeyEnc = safeStorage.encryptString(tkey).toString('base64')
    } catch {
      onDisk.provider.togetherApiKey = tkey
    }
  } else if (tkey) {
    onDisk.provider.togetherApiKey = tkey
  }
  if (mkey && encryptionOk()) {
    try {
      onDisk._mimoKeyEnc = safeStorage.encryptString(mkey).toString('base64')
    } catch {
      onDisk.provider.mimoApiKey = mkey
    }
  } else if (mkey) {
    onDisk.provider.mimoApiKey = mkey
  }
  if (kkey && encryptionOk()) {
    try {
      onDisk._kiloKeyEnc = safeStorage.encryptString(kkey).toString('base64')
    } catch {
      onDisk.provider.kiloApiKey = kkey
    }
  } else if (kkey) {
    onDisk.provider.kiloApiKey = kkey
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
  // no pretty-print: saveSession runs on every agent step (~100+ writes/turn); the 2-space indent
  // ~doubled bytes + CPU for a machine-read file. Minified is parsed identically by getSession.
  writeFileSync(tmp, JSON.stringify(session), 'utf8')
  renameSync(tmp, target)
  ensureSessionCache().set(session.id, { ...session, messages: [] })
}

// Debounced session persistence. The engine calls this on EVERY step (~100x/turn); coalescing
// those writes into at most one per window kills the O(n^2) bytes+CPU amplification on long
// sessions. The metadata cache is updated IMMEDIATELY (so listSessions/sidebar stay current);
// only the disk write is deferred. flushSession forces any pending write out NOW — runTurn's
// finally calls it, so a COMPLETED turn is always on disk synchronously. Intra-turn disk state
// may lag <=600ms, which is fine: the live turn works from the in-memory session object.
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>()
const SAVE_DEBOUNCE_MS = 600

export function saveSessionSoon(session: Session): void {
  if (tombstoned.has(session.id)) return // deleted mid-turn — don't resurrect it
  session.updatedAt = Date.now()
  ensureSessionCache().set(session.id, { ...session, messages: [] }) // list stays current immediately
  const id = session.id
  const existing = pendingSaves.get(id)
  if (existing) clearTimeout(existing)
  pendingSaves.set(
    id,
    setTimeout(() => {
      pendingSaves.delete(id)
      saveSession(session)
    }, SAVE_DEBOUNCE_MS)
  )
}

export function flushSession(session: Session): void {
  const t = pendingSaves.get(session.id)
  if (t) {
    clearTimeout(t)
    pendingSaves.delete(session.id)
  }
  saveSession(session)
}

export function deleteSession(id: string): void {
  let p: string
  try {
    p = sessionPath(id) // validate the id ONCE here before it reaches unlink + recursive rmSync
  } catch {
    return // invalid/traversal id — nothing to delete, and must never reach checkpoints rmSync
  }
  tombstoned.add(id)
  const pending = pendingSaves.get(id) // cancel a queued debounced write so it can't resurrect the file
  if (pending) {
    clearTimeout(pending)
    pendingSaves.delete(id)
  }
  if (existsSync(p)) unlinkSync(p)
  sessionCache?.delete(id)
  deleteSessionCheckpoints(id) // don't leave orphaned snapshot dirs behind
}
