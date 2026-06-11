import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../paths'
import { parseFrontmatter, str, arr } from './frontmatter'
import { PluginDef, SkillDef, SlashCommandDef, SubagentDef, HookDef, McpServerDef } from '@shared/types'

// A plugin is ~/.deepcode/plugins/<name>/ with a plugin.json manifest and any of:
//   skills/   commands/   agents/   hooks.json   mcp.json
// It packages multiple capabilities as one installable unit.

interface PluginManifest {
  name?: string
  version?: string
  description?: string
}

const DISABLED_FILE = join(PATHS.plugins, '.disabled.json')

function disabledSet(): Set<string> {
  if (!existsSync(DISABLED_FILE)) return new Set()
  try {
    return new Set(JSON.parse(readFileSync(DISABLED_FILE, 'utf8')) as string[])
  } catch {
    return new Set()
  }
}

function countDir(dir: string, ext: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((f) => f.endsWith(ext) || existsSync(join(dir, f, 'SKILL.md'))).length
}

export function loadPlugins(): PluginDef[] {
  if (!existsSync(PATHS.plugins)) return []
  const disabled = disabledSet()
  const out: PluginDef[] = []
  for (const entry of readdirSync(PATHS.plugins, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const root = join(PATHS.plugins, entry.name)
    let manifest: PluginManifest = {}
    const manifestPath = join(root, 'plugin.json')
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        /* ignore */
      }
    }
    const hooksCount = existsSync(join(root, 'hooks.json'))
      ? safeCount(join(root, 'hooks.json'))
      : 0
    const mcpCount = existsSync(join(root, 'mcp.json')) ? safeMcpCount(join(root, 'mcp.json')) : 0
    out.push({
      name: manifest.name || entry.name,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      path: root,
      enabled: !disabled.has(entry.name),
      provides: {
        skills: countDir(join(root, 'skills'), '.md'),
        commands: countDir(join(root, 'commands'), '.md'),
        agents: countDir(join(root, 'agents'), '.md'),
        hooks: hooksCount,
        mcp: mcpCount
      }
    })
  }
  return out
}

function safeCount(hooksPath: string): number {
  try {
    const json = JSON.parse(readFileSync(hooksPath, 'utf8'))
    return Object.values(json).reduce((n: number, v) => n + (Array.isArray(v) ? v.length : 0), 0)
  } catch {
    return 0
  }
}

function safeMcpCount(mcpPath: string): number {
  try {
    const json = JSON.parse(readFileSync(mcpPath, 'utf8'))
    return Object.keys(json.mcpServers ?? json ?? {}).length
  } catch {
    return 0
  }
}

export function togglePlugin(name: string, enabled: boolean): void {
  const disabled = disabledSet()
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  writeFileSync(DISABLED_FILE, JSON.stringify([...disabled], null, 2), 'utf8')
}

// Merge capabilities from all enabled plugins into the global system lists.
export function pluginSkills(): SkillDef[] {
  const out: SkillDef[] = []
  for (const p of loadPlugins().filter((p) => p.enabled)) {
    const dir = join(p.path, 'skills')
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      let file: string | null = null
      if (entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')))
        file = join(dir, entry.name, 'SKILL.md')
      else if (entry.isFile() && entry.name.endsWith('.md')) file = join(dir, entry.name)
      if (!file) continue
      try {
        const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
        out.push({
          name: str(data.name) || entry.name.replace(/\.md$/, ''),
          description: str(data.description),
          path: file,
          source: 'plugin',
          body
        })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

export function pluginCommands(): SlashCommandDef[] {
  const out: SlashCommandDef[] = []
  for (const p of loadPlugins().filter((p) => p.enabled)) {
    const dir = join(p.path, 'commands')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      try {
        const { data, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'))
        out.push({
          name: str(data.name) || f.replace(/\.md$/, ''),
          description: str(data.description),
          path: join(dir, f),
          template: body,
          source: 'plugin'
        })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

export function pluginSubagents(): SubagentDef[] {
  const out: SubagentDef[] = []
  for (const p of loadPlugins().filter((p) => p.enabled)) {
    const dir = join(p.path, 'agents')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      try {
        const { data, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'))
        const tools = arr(data.tools)
        out.push({
          name: str(data.name) || f.replace(/\.md$/, ''),
          description: str(data.description),
          systemPrompt: body.trim(),
          tools: tools.length ? tools : ['*'],
          model: str(data.model) || undefined,
          source: 'plugin'
        })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

export function pluginHooks(): HookDef[] {
  const out: HookDef[] = []
  for (const p of loadPlugins().filter((p) => p.enabled)) {
    const file = join(p.path, 'hooks.json')
    if (!existsSync(file)) continue
    try {
      const json = JSON.parse(readFileSync(file, 'utf8'))
      for (const [event, list] of Object.entries(json)) {
        if (!Array.isArray(list)) continue
        for (const h of list as { matcher?: string; command: string }[]) {
          out.push({ event: event as HookDef['event'], matcher: h.matcher, command: h.command, source: 'plugin' })
        }
      }
    } catch {
      /* skip */
    }
  }
  return out
}

export function pluginMcpServers(): McpServerDef[] {
  const out: McpServerDef[] = []
  for (const p of loadPlugins().filter((p) => p.enabled)) {
    const file = join(p.path, 'mcp.json')
    if (!existsSync(file)) continue
    try {
      const json = JSON.parse(readFileSync(file, 'utf8'))
      const servers = json.mcpServers ?? json
      for (const [name, cfg] of Object.entries(servers as Record<string, any>)) {
        out.push({
          name,
          transport: cfg.url ? 'sse' : 'stdio',
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          url: cfg.url,
          // Plugin-provided connectors often need auth/keys — never auto-connect
          // them at startup; the user enables what they need in the MCP panel.
          enabled: false
        })
      }
    } catch {
      /* skip */
    }
  }
  return out
}
