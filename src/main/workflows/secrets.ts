import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { safeStorage } from 'electron'
import { PATHS, ensureConfigDirs } from '../paths'
import { MIN_SECRET_LEN } from '@shared/types'

// Encrypted secret store for {{secret.NAME}} used in workflow tool/shell/http arguments.
// Values are OS-encrypted via safeStorage. Unlike the API-key fallback in store.ts, this
// REFUSES to persist plaintext when encryption is unavailable — a secret store silently
// writing plaintext is worse than failing. Values never leave the main process (only names
// are listed over IPC); they are decrypted once per top-level run and masked out of all
// events / persisted runs.

const NAME_RE = /^[A-Z0-9_]{1,64}$/ // env-var style → unambiguous {{secret.NAME}} + safe JSON key

interface SecretsFile {
  v: 1
  items: Record<string, { enc: string }>
}

function encOk(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function load(): SecretsFile {
  try {
    if (existsSync(PATHS.secrets)) {
      const r = JSON.parse(readFileSync(PATHS.secrets, 'utf8'))
      if (r && typeof r === 'object' && r.items && typeof r.items === 'object') return r as SecretsFile
    }
  } catch {
    /* corrupt → treated as empty */
  }
  return { v: 1, items: {} }
}

function save(f: SecretsFile): void {
  ensureConfigDirs()
  // atomic write (tmp + rename): a torn in-place write would leave secrets.json truncated,
  // load() would swallow the parse error and return empty, and the next setSecret would then
  // overwrite — silently destroying ALL stored secrets.
  const tmp = `${PATHS.secrets}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8')
    renameSync(tmp, PATHS.secrets)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore cleanup failure */
    }
    throw e
  }
}

// Minimum secret length (shared with the renderer prompt via @shared/types). buildMaskList
// intentionally skips values shorter than this (masking a 3-char value would corrupt unrelated
// output), so a shorter secret could never be redacted from logs/events/persisted runs. Refuse
// to store one rather than silently fail to mask it.

export function isSecretNameValid(name: string): boolean {
  return NAME_RE.test(name)
}

export function listSecretNames(): string[] {
  return Object.keys(load().items).sort()
}

export function setSecret(name: string, value: string): void {
  if (!NAME_RE.test(name)) throw new Error('Ungültiger Secret-Name — erlaubt: A–Z, 0–9, _ (max 64).')
  if (String(value).length < MIN_SECRET_LEN) {
    // a shorter value cannot be reliably masked out of logs/runs (see MIN_SECRET_LEN) — refuse
    // it rather than store a secret that would leak in cleartext everywhere it is used.
    throw new Error(`Secret zu kurz — mindestens ${MIN_SECRET_LEN} Zeichen (kürzere lassen sich nicht zuverlässig maskieren).`)
  }
  if (!encOk()) throw new Error('Verschlüsselung auf diesem System nicht verfügbar — Secret wird NICHT im Klartext gespeichert.')
  const f = load()
  f.items[name] = { enc: safeStorage.encryptString(String(value)).toString('base64') }
  save(f)
}

export function deleteSecret(name: string): void {
  const f = load()
  if (f.items[name]) {
    delete f.items[name]
    save(f)
  }
}

// Decrypt every secret ONCE (per top-level run). Returns {} if encryption is unavailable.
export function loadSecretsResolved(): Record<string, string> {
  const out: Record<string, string> = {}
  if (!encOk()) return out
  for (const [n, v] of Object.entries(load().items)) {
    try {
      out[n] = safeStorage.decryptString(Buffer.from(v.enc, 'base64'))
    } catch {
      /* skip un-decryptable entry */
    }
  }
  return out
}

// Build a longest-first mask list from secret values: the raw value plus its common encoded
// forms (URI / base64). Short values (< MIN_SECRET_LEN) are excluded so we don't corrupt
// unrelated output.
export function buildMaskList(secrets: Record<string, string>): string[] {
  const out: string[] = []
  for (const v of Object.values(secrets)) {
    if (typeof v !== 'string' || v.length < MIN_SECRET_LEN) continue
    out.push(v)
    try {
      out.push(encodeURIComponent(v))
    } catch {
      /* ignore */
    }
    try {
      out.push(Buffer.from(v).toString('base64'))
    } catch {
      /* ignore */
    }
    // inner JSON-escaped form — catches a secret embedded in serialized JSON (run files,
    // tool args, agent session messages) where quotes/backslashes/newlines are escaped.
    try {
      const j = JSON.stringify(v)
      if (j.length > 2) out.push(j.slice(1, -1))
    } catch {
      /* ignore */
    }
  }
  return [...new Set(out)].filter(Boolean).sort((a, b) => b.length - a.length)
}

// Literal (not regex — secret values contain metachars) longest-first masking.
export function maskWith(list: string[], s: unknown): string {
  if (typeof s !== 'string' || !list.length) return typeof s === 'string' ? s : String(s ?? '')
  let out = s
  for (const m of list) out = out.split(m).join('•••')
  return out
}
