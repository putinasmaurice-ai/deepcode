import { appendFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'

const MAX_LOG_BYTES = 5 * 1024 * 1024 // rotate audit.log past ~5 MB

// Mask common secret shapes so resolved {{secret.*}} tokens never hit the log
// in cleartext. Best-effort; never throws.
export function redactSecrets(s: string): string {
  try {
    return s
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, '***')
      .replace(/(?:gho|ghp|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, '***')
      .replace(/AKIA[0-9A-Z]{16}/g, '***')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '***')
      .replace(
        /((?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE|AUTH)[A-Za-z0-9_-]*)(\s*[:=]\s*"?)([^"\s]+)("?)/gi,
        '$1$2***$4'
      )
  } catch {
    return s
  }
}

// Rename audit.log to audit.log.1 (overwriting any existing .1) when it grows
// past the size cap. Best-effort; never throws.
function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
  } catch {
    /* ignore (missing file or rename failure) */
  }
}

// Append-only audit trail of side-effecting actions (shell commands, hook
// executions). Stored at ~/.deepcode/audit.log. Best-effort; never throws.
export function auditLog(kind: string, detail: string): void {
  try {
    const file = join(PATHS.root, 'audit.log')
    rotateIfNeeded(file)
    const safe = redactSecrets(detail).replace(/\s+/g, ' ').slice(0, 500)
    const line = `${new Date().toISOString()}\t${kind}\t${safe}\n`
    appendFileSync(file, line, 'utf8')
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
