import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../paths'
import { parseFrontmatter, str } from './frontmatter'
import { MemoryEntry } from '@shared/types'

// Memory is a directory of markdown files, each holding one durable fact, with
// frontmatter (name, description, type). MEMORY.md is the lightweight index
// injected into every system prompt. Mirrors the Claude Code memory model.

function metaType(data: Record<string, string | string[]>): MemoryEntry['type'] {
  // type may be nested under metadata in our writer, but we also accept top-level
  const t = str(data.type) || str((data as any)['metadata.type'])
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
        path
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
description: ${entry.description}
type: ${entry.type}
---

${entry.body.trim()}
`
  writeFileSync(path, content, 'utf8')
  rebuildIndex()
  return { ...entry, name: slug, path }
}

export function deleteMemory(name: string): void {
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

function rebuildIndex(): void {
  const entries = loadMemory()
  const lines = entries.map((e) => `- [${e.name}](${e.name}.md) — ${e.description}`)
  const content = `# Memory Index\n\n${lines.join('\n')}\n`
  writeFileSync(PATHS.memoryIndex, content, 'utf8')
}
