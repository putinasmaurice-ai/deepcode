import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { PATHS, ensureConfigDirs } from './paths'
import { atomicWriteText, atomicWriteJson } from './atomic'

// Backup / Restore: bundle the user's ~/.deepcode config into ONE portable JSON file (no zip
// dependency). API keys / secrets are machine-bound (safeStorage ciphertext) and intentionally
// EXCLUDED from the export — the user re-enters them after a restore. A restore on the SAME
// machine preserves the keys already entered here (it never wipes them).

export interface BackupBundle {
  app: 'deepcode'
  kind: 'backup'
  version: string
  createdAt: number
  files: Record<string, unknown>
  memory: Record<string, string>
  workflows: Record<string, unknown>
}

const PROJECTS = join(PATHS.root, 'projects.json')
const LEDGER = join(PATHS.root, 'ledger.json')

// settings secrets: encrypted blobs live at top level (_apiKeyEnc, _googleKeyEnc, …); plaintext
// fallbacks (when encryption is unavailable) live in provider.{apiKey,googleApiKey,…}.
const SECRET_KEY = /Enc$/
const SECRET_NAMES = new Set(['apiKey', 'googleApiKey', 'deepinfraApiKey', 'openaiApiKey', 'togetherApiKey'])

function stripSecrets(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripSecrets)
  if (!obj || typeof obj !== 'object') return obj
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEY.test(k) || SECRET_NAMES.has(k)) continue
    out[k] = stripSecrets(v)
  }
  return out
}

function readJson(path: string): unknown | undefined {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// A crafted backup must never write outside the target dir: accept a plain basename only.
const SAFE_NAME = /^[A-Za-z0-9._-]+\.(md|json)$/
function safeName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.includes('..')
}

export function createBackup(appVersion: string, now: number): BackupBundle {
  const files: Record<string, unknown> = {}
  const add = (name: string, path: string, transform?: (v: unknown) => unknown): void => {
    const v = readJson(path)
    if (v !== undefined) files[name] = transform ? transform(v) : v
  }
  add('settings.json', PATHS.settings, stripSecrets) // never export keys/secrets
  add('projects.json', PROJECTS)
  add('automations.json', PATHS.automations)
  add('mcp.json', PATHS.mcp)
  add('hooks.json', PATHS.hooks)
  add('ledger.json', LEDGER)

  const memory: Record<string, string> = {}
  try {
    for (const f of readdirSync(PATHS.memory)) {
      if (!f.endsWith('.md')) continue
      try {
        memory[f] = readFileSync(join(PATHS.memory, f), 'utf8')
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* no memory dir */
  }

  const workflows: Record<string, unknown> = {}
  try {
    for (const f of readdirSync(PATHS.workflows)) {
      if (!f.endsWith('.json')) continue // defs only — the runs/ subdir is a dir, skipped by the suffix check
      const v = readJson(join(PATHS.workflows, f))
      if (v !== undefined) workflows[f] = v
    }
  } catch {
    /* no workflows dir */
  }

  return { app: 'deepcode', kind: 'backup', version: appVersion, createdAt: now, files, memory, workflows }
}

const CONFIG_TARGETS: Record<string, string> = {
  'settings.json': PATHS.settings,
  'projects.json': PROJECTS,
  'automations.json': PATHS.automations,
  'mcp.json': PATHS.mcp,
  'hooks.json': PATHS.hooks,
  'ledger.json': LEDGER
}

// Re-attach THIS machine's encrypted secret fields onto the incoming settings, so a restore
// never wipes keys already entered here (the backup carries none by design).
function mergeKeepingSecrets(
  incoming: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming }
  for (const [k, v] of Object.entries(current)) {
    if (SECRET_KEY.test(k)) out[k] = v // top-level _*Enc blobs
  }
  const curProvider = (current.provider ?? {}) as Record<string, unknown>
  const provider: Record<string, unknown> = { ...((incoming.provider ?? {}) as Record<string, unknown>) }
  for (const [k, v] of Object.entries(curProvider)) {
    if (SECRET_KEY.test(k) || SECRET_NAMES.has(k)) provider[k] = v // plaintext key fallbacks
  }
  out.provider = provider
  return out
}

export function restoreBackup(bundle: BackupBundle): { restored: string[] } {
  if (!bundle || bundle.app !== 'deepcode' || bundle.kind !== 'backup') {
    throw new Error('Keine gültige DeepCode-Backup-Datei.')
  }
  ensureConfigDirs()
  const restored: string[] = []

  for (const [name, value] of Object.entries(bundle.files ?? {})) {
    const dest = CONFIG_TARGETS[name]
    if (!dest) continue // only known config files — ignore anything else
    if (name === 'settings.json') {
      const current = (readJson(PATHS.settings) ?? {}) as Record<string, unknown>
      atomicWriteJson(dest, mergeKeepingSecrets((value ?? {}) as Record<string, unknown>, current))
    } else {
      atomicWriteJson(dest, value)
    }
    restored.push(name)
  }

  for (const [name, content] of Object.entries(bundle.memory ?? {})) {
    if (!safeName(name) || typeof content !== 'string') continue
    atomicWriteText(join(PATHS.memory, name), content)
    restored.push(`memory/${name}`)
  }

  for (const [name, value] of Object.entries(bundle.workflows ?? {})) {
    if (!safeName(name)) continue
    atomicWriteJson(join(PATHS.workflows, name), value)
    restored.push(`workflows/${name}`)
  }

  return { restored }
}
