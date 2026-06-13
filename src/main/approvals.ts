import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'

// Persistent per-command approval allowlist. When the user clicks "Immer erlauben"
// on a shell command, we remember the EXACT command line — SCOPED TO THE WORKING
// DIRECTORY it was approved in — so future identical runs in the same project
// auto-approve without a prompt. Two deliberate safety properties:
//   1. cwd-scoped: blessing `npm test` in project A never auto-runs in project B,
//      so a later cloned/hostile repo can't ride a previously-blessed command name.
//   2. exact-match only on the command string.
// Dangerous commands are screened by the engine BEFORE this list is consulted, and
// the allowlist only suppresses the INTERACTIVE prompt — it never overrides the
// unattended 'safe' gate. So a fork bomb can never end up auto-approved here.

export interface ApprovedCommand {
  command: string
  cwd: string
}

interface Allowlist {
  commands: ApprovedCommand[]
}

const FILE = join(PATHS.root, 'approvals.json')
let cache: Allowlist | null = null

function load(): Allowlist {
  if (cache) return cache
  if (existsSync(FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as { commands?: unknown[] }
      const commands: ApprovedCommand[] = []
      for (const c of parsed.commands ?? []) {
        if (typeof c === 'string') commands.push({ command: c, cwd: '' }) // legacy
        else if (c && typeof (c as ApprovedCommand).command === 'string')
          commands.push({ command: (c as ApprovedCommand).command, cwd: (c as ApprovedCommand).cwd ?? '' })
      }
      cache = { commands }
      return cache
    } catch {
      /* fall through */
    }
  }
  cache = { commands: [] }
  return cache
}

function persist(): void {
  if (!cache) return
  try {
    writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

const norm = (s: string): string => (s ?? '').trim()

export function isCommandApproved(cmd: unknown, cwd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  const c = norm(cmd)
  const dir = typeof cwd === 'string' ? norm(cwd) : ''
  return load().commands.some((e) => e.command === c && e.cwd === dir)
}

export function approveCommand(cmd: string, cwd: string): void {
  const led = load()
  const c = norm(cmd)
  const dir = norm(cwd)
  if (!c || led.commands.some((e) => e.command === c && e.cwd === dir)) return
  led.commands.push({ command: c, cwd: dir })
  persist()
}

export function listApprovedCommands(): ApprovedCommand[] {
  return load().commands.map((e) => ({ ...e }))
}

export function removeApprovedCommand(command: string, cwd: string): ApprovedCommand[] {
  const led = load()
  led.commands = led.commands.filter((e) => !(e.command === norm(command) && e.cwd === norm(cwd)))
  persist()
  return led.commands.map((e) => ({ ...e }))
}
