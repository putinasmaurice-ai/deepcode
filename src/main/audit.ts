import { appendFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'

// Append-only audit trail of side-effecting actions (shell commands, hook
// executions). Stored at ~/.deepcode/audit.log. Best-effort; never throws.
export function auditLog(kind: string, detail: string): void {
  try {
    const line = `${new Date().toISOString()}\t${kind}\t${detail.replace(/\s+/g, ' ').slice(0, 500)}\n`
    appendFileSync(join(PATHS.root, 'audit.log'), line, 'utf8')
  } catch {
    /* ignore */
  }
}

// Build a minimal environment for spawned processes: pass through the essentials
// and DEEPCODE_* vars, but strip anything that looks like a secret.
const SECRET_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE|AWS_|SSH_|GH_TOKEN|GITHUB_TOKEN)/i
const KEEP = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA'
])

export function safeEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (KEEP.has(k) || (k.startsWith('DEEPCODE_') && !SECRET_RE.test(k))) out[k] = v
  }
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v
  return out
}
