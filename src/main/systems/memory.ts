import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../paths'
import { parseFrontmatter, str } from './frontmatter'
import { MemoryEntry } from '@shared/types'

// Memory is a directory of markdown files, each holding one durable fact, with
// frontmatter (name, description, type). MEMORY.md is the lightweight index
// injected into every system prompt. Mirrors the Claude Code memory model.

function metaType(data: Record<string, string | string[]>): MemoryEntry['type'] {
  const t = str(data.type)
  if (t === 'feedback' || t === 'project' || t === 'reference') return t
  return 'user'
}

export function loadMemory(): MemoryEntry[] {
  if (!existsSync(PATHS.memory)) return []
  const out: MemoryEntry[] = []
  for (const f of readdirSync(PATHS.memory)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue
    try {
      const path = join(PATHS.memory, f)
      const text = readFileSync(path, 'utf8')
      const { data, body } = parseFrontmatter(text)
      out.push({
        name: str(data.name) || f.replace(/\.md$/, ''),
        description: str(data.description),
        type: metaType(data),
        body: body.trim(),
        path,
        projectId: str(data.projectId) || undefined
      })
    } catch {
      /* skip */
    }
  }
  return out
}

export function memoryIndex(): string {
  if (existsSync(PATHS.memoryIndex)) {
    try {
      return readFileSync(PATHS.memoryIndex, 'utf8')
    } catch {
      /* fall through */
    }
  }
  // synthesize an index from the entries
  const entries = loadMemory()
  if (!entries.length) return ''
  return entries.map((e) => `- ${e.name}: ${e.description}`).join('\n')
}

export function saveMemory(entry: Omit<MemoryEntry, 'path'>): MemoryEntry {
  if (!existsSync(PATHS.memory)) mkdirSync(PATHS.memory, { recursive: true })
  const slug = entry.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const path = join(PATHS.memory, `${slug}.md`)
  const content = `---
name: ${slug}
description: ${JSON.stringify(entry.description)}
type: ${entry.type}
${entry.projectId ? `projectId: ${entry.projectId}\n` : ''}---

${entry.body.trim()}
`
  writeFileSync(path, content, 'utf8')
  rebuildIndex()
  return { ...entry, name: slug, path }
}

export function deleteMemory(name: string): void {
  // names are slugs (saveMemory: /[^a-z0-9]+/ → '-'); reject anything else so a renderer-
  // supplied '../sessions/x' can't traverse out of the memory dir into unlinkSync.
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) return
  const path = join(PATHS.memory, `${name}.md`)
  if (existsSync(path)) unlinkSync(path)
  rebuildIndex()
}

// Arena votes accumulate into one memory entry, so the model-preference
// knowledge ("user prefers X for coding") flows into every system prompt.
export function recordArenaVote(winner: string, loser: string): void {
  const existing = loadMemory().find((m) => m.name === 'arena-preferences')
  const counts = new Map<string, number>()
  if (existing) {
    for (const line of existing.body.split('\n')) {
      const m = line.match(/^- (.+?) schlägt (.+?): (\d+)x$/)
      if (m) counts.set(`${m[1]}>${m[2]}`, parseInt(m[3], 10))
    }
  }
  const key = `${winner}>${loser}`
  counts.set(key, (counts.get(key) ?? 0) + 1)
  const body = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => {
      const [w, l] = k.split('>')
      return `- ${w} schlägt ${l}: ${n}x`
    })
    .join('\n')
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  saveMemory({
    name: 'arena-preferences',
    description: `Modell-Präferenzen aus Arena-Votings (Favorit: ${top[0].split('>')[0]})`,
    type: 'feedback',
    body
  })
}

// Error memory: when a command fails and a follow-up succeeds, remember the
// pair so the agent proposes the known fix next time (injected via MEMORY.md).
export function recordErrorSolution(errorHead: string, solution: string): void {
  const existing = loadMemory().find((m) => m.name === 'error-solutions')
  const lines = existing ? existing.body.split('\n').filter(Boolean) : []
  const entry = `- Fehler: ${errorHead.slice(0, 140)} → Lösung: ${solution.slice(0, 160)}`
  if (lines.includes(entry)) return
  lines.unshift(entry)
  saveMemory({
    name: 'error-solutions',
    description: `Bekannte Fehler→Lösung-Paare aus früheren Sessions (${Math.min(lines.length, 30)} Einträge)`,
    type: 'reference',
    body: lines.slice(0, 30).join('\n')
  })
}

function rebuildIndex(): void {
  const entries = loadMemory()
  const lines = entries.map((e) => `- [${e.name}](${e.name}.md) — ${e.description}`)
  const content = `# Memory Index\n\n${lines.join('\n')}\n`
  writeFileSync(PATHS.memoryIndex, content, 'utf8')
}
