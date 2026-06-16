import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

// Root config dir, mirroring how Claude Code uses ~/.claude
// Everything user-extensible lives here: skills, commands, agents, plugins, memory, mcp, settings, sessions.
export const CONFIG_DIR = join(homedir(), '.deepcode')

export const PATHS = {
  root: CONFIG_DIR,
  settings: join(CONFIG_DIR, 'settings.json'),
  sessions: join(CONFIG_DIR, 'sessions'),
  skills: join(CONFIG_DIR, 'skills'),
  commands: join(CONFIG_DIR, 'commands'),
  agents: join(CONFIG_DIR, 'agents'),
  hooks: join(CONFIG_DIR, 'hooks.json'),
  mcp: join(CONFIG_DIR, 'mcp.json'),
  plugins: join(CONFIG_DIR, 'plugins'),
  memory: join(CONFIG_DIR, 'memory'),
  memoryIndex: join(CONFIG_DIR, 'memory', 'MEMORY.md'),
  automations: join(CONFIG_DIR, 'automations.json'),
  workflows: join(CONFIG_DIR, 'workflows'),
  workflowRuns: join(CONFIG_DIR, 'workflows', 'runs'),
  secrets: join(CONFIG_DIR, 'workflows', 'secrets.json'),
  traces: join(CONFIG_DIR, 'traces'),
  swarm: join(CONFIG_DIR, 'swarm') // isolated git worktrees for parallel swarm workers
}

// Per-project config dir (.deepcode inside the opened workspace)
export function projectConfigDir(cwd: string): string {
  return join(cwd, '.deepcode')
}

// Guard any renderer-supplied id that becomes part of a filename or directory path
// (session id, checkpoint dir). randomUUID() always satisfies this; a traversal id like
// '..\..\settings' or 'a/b' is rejected BEFORE it can reach unlinkSync / recursive rmSync.
// Mirrors the safeId already used in workflows/store.ts.
export function safeId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('invalid id')
  }
  return id
}

// Validate a user-typed folder NAME (a single path segment) before it is joined onto a
// parent dir in createDirectory. Rejects traversal, separators, the Windows-illegal chars
// (< > : " / \ | ? *), the dot-names and a trailing dot. Spaces and hyphens ARE allowed —
// "CODING APP" and "mein-projekt" are valid folder names. Returns the trimmed name or throws.
export function safeFolderName(name: unknown): string {
  const clean = String(name ?? '').trim()
  if (
    !clean ||
    clean === '.' ||
    clean === '..' ||
    /[<>:"/\\|?*]/.test(clean) ||
    /\.$/.test(clean)
  ) {
    throw new Error('Ungültiger Ordnername: ' + String(name))
  }
  return clean
}

export function ensureConfigDirs(): void {
  const dirs = [
    PATHS.root,
    PATHS.sessions,
    PATHS.skills,
    PATHS.commands,
    PATHS.agents,
    PATHS.plugins,
    PATHS.memory,
    PATHS.workflows,
    PATHS.workflowRuns,
    PATHS.traces
  ]
  for (const d of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}
