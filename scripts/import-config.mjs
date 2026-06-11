// One-shot importer: pulls Skills, Plugins, MCP servers and global memory from
// the user's ~/.codex and ~/.claude config into DeepCode's ~/.deepcode config.
// Idempotent: skips items that already exist.

import { homedir } from 'os'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  renameSync,
  statSync
} from 'fs'

const HOME = homedir()
const DC = join(HOME, '.deepcode')
const CLAUDE = join(HOME, '.claude')
const CODEX = join(HOME, '.codex')

const log = (s) => console.log(s)
const ensure = (d) => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}
ensure(DC)
ensure(join(DC, 'skills'))
ensure(join(DC, 'plugins'))
ensure(join(DC, 'memory'))

const summary = { skills: 0, plugins: 0, mcp: 0, memories: 0 }

const COPY_FILTER = (src) =>
  !/[\\/](\.git|\.github|node_modules)([\\/]|$)/.test(src)

// ---------- 1) Standalone skills ----------
function importSkillsFrom(dir, source) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const src = join(dir, name)
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    if (!existsSync(join(src, 'SKILL.md'))) continue
    const dest = join(DC, 'skills', name)
    if (existsSync(dest)) {
      log(`  skill exists, skip: ${name}`)
      continue
    }
    cpSync(src, dest, { recursive: true, filter: COPY_FILTER })
    summary.skills++
    log(`  + skill (${source}): ${name}`)
  }
}
log('Importing standalone skills…')
importSkillsFrom(join(CLAUDE, 'skills'), 'claude')
importSkillsFrom(join(CODEX, 'skills'), 'codex')

// ---------- 2) Claude marketplace plugins ----------
function findPluginManifests(root) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 6 || !existsSync(d)) return
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === '.git' || e.name === 'node_modules') continue
      const p = join(d, e.name)
      const manifest = join(p, '.claude-plugin', 'plugin.json')
      if (existsSync(manifest)) out.push({ root: p, manifest })
      walk(p, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

log('Importing plugins…')
const mpRoot = join(CLAUDE, 'plugins', 'marketplaces')
const plugins = existsSync(mpRoot) ? findPluginManifests(mpRoot) : []
for (const { root, manifest } of plugins) {
  let meta
  try {
    meta = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    continue
  }
  const name = meta.name || root.split(/[\\/]/).pop()
  const dest = join(DC, 'plugins', name)
  if (existsSync(dest)) {
    log(`  plugin exists, skip: ${name}`)
    continue
  }
  cpSync(root, dest, { recursive: true, filter: COPY_FILTER })

  // convert manifest -> plugin.json at root
  const desc =
    typeof meta.description === 'string'
      ? meta.description
      : meta.description?.text || ''
  writeFileSync(
    join(dest, 'plugin.json'),
    JSON.stringify(
      { name, version: meta.version || '0.1.0', description: desc },
      null,
      2
    ),
    'utf8'
  )
  // .mcp.json -> mcp.json (DeepCode reads json.mcpServers ?? json)
  if (existsSync(join(dest, '.mcp.json')) && !existsSync(join(dest, 'mcp.json'))) {
    try {
      renameSync(join(dest, '.mcp.json'), join(dest, 'mcp.json'))
    } catch {
      /* ignore */
    }
  }
  // Disable Claude-format hooks (incompatible schema) so they don't run broken.
  if (existsSync(join(dest, 'hooks', 'hooks.json'))) {
    try {
      renameSync(join(dest, 'hooks', 'hooks.json'), join(dest, 'hooks', 'hooks.claude.bak'))
    } catch {
      /* ignore */
    }
  }
  if (existsSync(join(dest, 'hooks.json'))) {
    try {
      renameSync(join(dest, 'hooks.json'), join(dest, 'hooks.claude.bak'))
    } catch {
      /* ignore */
    }
  }
  summary.plugins++
  log(`  + plugin: ${name}`)
}

// ---------- 3) MCP servers (from ~/.claude.json project configs) ----------
log('Importing MCP servers…')
const mcpPath = join(DC, 'mcp.json')
let mcpDoc = { mcpServers: {} }
if (existsSync(mcpPath)) {
  try {
    mcpDoc = JSON.parse(readFileSync(mcpPath, 'utf8'))
    if (!mcpDoc.mcpServers) mcpDoc = { mcpServers: mcpDoc }
  } catch {
    mcpDoc = { mcpServers: {} }
  }
}
const claudeJson = join(HOME, '.claude.json')
if (existsSync(claudeJson)) {
  try {
    const o = JSON.parse(readFileSync(claudeJson, 'utf8'))
    const collected = {}
    if (o.mcpServers) Object.assign(collected, o.mcpServers)
    for (const proj of Object.values(o.projects || {})) {
      if (proj.mcpServers) Object.assign(collected, proj.mcpServers)
    }
    for (const [n, cfg] of Object.entries(collected)) {
      if (mcpDoc.mcpServers[n]) {
        log(`  mcp exists, skip: ${n}`)
        continue
      }
      // Import disabled by default — they spawn external processes; enable in the UI.
      mcpDoc.mcpServers[n] = {
        command: cfg.command,
        args: cfg.args || [],
        env: cfg.env || {},
        url: cfg.url,
        enabled: false
      }
      summary.mcp++
      log(`  + mcp: ${n} (${cfg.command} ${(cfg.args || []).join(' ')}) [disabled]`)
    }
  } catch (e) {
    log('  (could not read ~/.claude.json: ' + e.message + ')')
  }
}
writeFileSync(mcpPath, JSON.stringify(mcpDoc, null, 2), 'utf8')

// ---------- 4) Global memory (Codex AGENTS.md -> memory + customInstructions) ----------
log('Importing global memory…')
function slug(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function saveMemory(name, description, type, body) {
  const path = join(DC, 'memory', `${slug(name)}.md`)
  if (existsSync(path)) {
    log(`  memory exists, skip: ${name}`)
    return
  }
  writeFileSync(
    path,
    `---\nname: ${slug(name)}\ndescription: ${description}\ntype: ${type}\n---\n\n${body.trim()}\n`,
    'utf8'
  )
  summary.memories++
  log(`  + memory: ${name}`)
}

let agentsBody = ''
const agentsPath = join(CODEX, 'AGENTS.md')
if (existsSync(agentsPath)) {
  agentsBody = readFileSync(agentsPath, 'utf8')
  saveMemory(
    'global-coding-rules',
    "User's global coding rules and preferences (imported from Codex AGENTS.md)",
    'feedback',
    agentsBody
  )
}
// Rebuild memory index
const memFiles = readdirSync(join(DC, 'memory')).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
const idx = ['# Memory Index', '']
for (const f of memFiles) {
  try {
    const t = readFileSync(join(DC, 'memory', f), 'utf8')
    const d = (t.match(/description:\s*(.*)/) || [])[1] || ''
    idx.push(`- [${f.replace(/\.md$/, '')}](${f}) — ${d}`)
  } catch {
    /* ignore */
  }
}
writeFileSync(join(DC, 'memory', 'MEMORY.md'), idx.join('\n') + '\n', 'utf8')

// ---------- 5) Settings: DeepSeek API key + customInstructions ----------
log('Updating settings…')
const settingsPath = join(DC, 'settings.json')
let settings = {}
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    settings = {}
  }
}
settings.provider = settings.provider || {}
settings.provider.apiKey = process.env.DEEPSEEK_KEY || settings.provider.apiKey || ''
settings.provider.baseUrl = settings.provider.baseUrl || 'https://api.deepseek.com'
settings.provider.model = settings.provider.model || 'deepseek-chat'
settings.provider.reasonerModel = settings.provider.reasonerModel || 'deepseek-reasoner'
if (settings.provider.temperature == null) settings.provider.temperature = 0.2
if (settings.provider.maxTokens == null) settings.provider.maxTokens = 8192
if (settings.provider.pricePerMillionInput == null) settings.provider.pricePerMillionInput = 0.27
if (settings.provider.pricePerMillionOutput == null) settings.provider.pricePerMillionOutput = 1.1
if (!settings.defaultCwd) settings.defaultCwd = join(HOME, 'Desktop')
// Apply the user's global rules as always-on custom instructions.
if (agentsBody && !settings.customInstructions) {
  settings.customInstructions = agentsBody.trim()
}
delete settings._apiKeyEnc // force re-encryption on next in-app save
writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
log('  + DeepSeek API key set, custom instructions applied')

log('\n=== Import summary ===')
log(`Skills imported:   ${summary.skills}`)
log(`Plugins imported:  ${summary.plugins}`)
log(`MCP servers added: ${summary.mcp} (disabled by default — enable in the MCP panel)`)
log(`Memories added:    ${summary.memories}`)
