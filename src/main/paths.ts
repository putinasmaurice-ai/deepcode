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
  automations: join(CONFIG_DIR, 'automations.json')
}

// Per-project config dir (.deepcode inside the opened workspace)
export function projectConfigDir(cwd: string): string {
  return join(cwd, '.deepcode')
}

export function ensureConfigDirs(): void {
  const dirs = [
    PATHS.root,
    PATHS.sessions,
    PATHS.skills,
    PATHS.commands,
    PATHS.agents,
    PATHS.plugins,
    PATHS.memory
  ]
  for (const d of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}
