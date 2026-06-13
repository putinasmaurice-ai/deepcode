import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { MemoryEntry, Session } from '@shared/types'
import { EngineDeps } from './deps'
import { PATHS } from '../paths'
import { costOf } from './pricing'
import { recordUsage } from '../ledger'
import { loadMemory, memoryIndex, saveMemory } from '../systems/memory'

// /learn: distill a session into a reusable skill — the app learns repeatable
// procedures from real work (~/.deepcode/skills/<slug>/SKILL.md).
export async function distillSkill(
  deps: EngineDeps,
  session: Session,
  hint: string
): Promise<{ name: string; path: string }> {
  const transcript = session.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const calls = m.toolCalls?.length ? ` [tools: ${m.toolCalls.map((t) => t.name).join(', ')}]` : ''
      return `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}${calls}`
    })
    .join('\n\n')

  const res = await deps.client.streamChat(
    [
      {
        role: 'system',
        content:
          'You distill a coding-assistant conversation into a reusable SKILL definition. Output EXACTLY this format, nothing else:\n' +
          'NAME: <kebab-case-slug>\nDESCRIPTION: <one line, when to use this skill>\nBODY:\n<markdown playbook: numbered, generalized steps to repeat this kind of task — concrete commands/patterns, no session-specific paths unless essential>'
      },
      {
        role: 'user',
        content: `Distill this session into a skill${hint ? ` (focus: ${hint})` : ''}:\n\n${transcript.slice(0, 24000)}`
      }
    ],
    [],
    {},
    new AbortController().signal
  )
  // this is a billed round — record it like every other (engine/variants/compact)
  if (res.usage) recordUsage(costOf(deps.settings.provider, res.usage, session.model))

  const nameMatch = res.content.match(/NAME:\s*(.+)/)
  const descMatch = res.content.match(/DESCRIPTION:\s*(.+)/)
  const bodyMatch = res.content.match(/BODY:\s*\n([\s\S]+)/)
  if (!nameMatch || !bodyMatch) throw new Error('Distillation produced no usable skill format.')
  const slug = nameMatch[1]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
  // avoid silently overwriting an existing skill of the same name
  let finalSlug = slug
  for (let n = 2; existsSync(join(PATHS.skills, finalSlug, 'SKILL.md')) && n < 20; n++) {
    finalSlug = slug + '-' + n
  }
  const dir = join(PATHS.skills, finalSlug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(
    file,
    `---\nname: ${finalSlug}\ndescription: ${JSON.stringify((descMatch?.[1] ?? '').trim())}\n---\n\n${bodyMatch[1].trim()}\n`,
    'utf8'
  )
  return { name: finalSlug, path: file }
}

// /remember (+ optional auto): distill DURABLE facts from a session into memory entries —
// the conversational counterpart to distillSkill. Conservative: returns only NEW facts not
// already in the index, project-scoped where appropriate. Returns the saved entry names.
export async function distillMemories(deps: EngineDeps, session: Session, projectId?: string): Promise<string[]> {
  const transcript = session.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`)
    .join('\n\n')
  if (!transcript.trim()) return []
  const known = memoryIndex().trim().slice(0, 3000)

  const res = await deps.client.streamChat(
    [
      {
        role: 'system',
        content:
          'You extract DURABLE, reusable facts worth remembering long-term from a coding session: ' +
          'user preferences, project decisions/conventions, important gotchas. NOT transient task details. ' +
          'Skip anything already covered by the existing memory below. Return STRICT JSON only: an array of ' +
          '{ "description": one-line, "body": 1-3 sentences, "type": "user"|"feedback"|"project"|"reference" }. ' +
          'Return [] if there is nothing genuinely new and durable. Max 3 items.'
      },
      { role: 'user', content: `Existing memory:\n${known || '(none)'}\n\n---\nSession:\n${transcript.slice(0, 20000)}` }
    ],
    [],
    {},
    new AbortController().signal
  )
  if (res.usage) recordUsage(costOf(deps.settings.provider, res.usage, session.model))

  // tolerant JSON extraction (model may wrap it in prose/fences)
  const m = res.content.match(/\[[\s\S]*\]/)
  if (!m) return []
  let items: Array<{ description?: string; body?: string; type?: string }>
  try {
    items = JSON.parse(m[0])
  } catch {
    return []
  }
  if (!Array.isArray(items)) return []
  const existing = loadMemory()
  const norm = (s: string): string => s.trim().toLowerCase()
  const saved: string[] = []
  for (const it of items.slice(0, 3)) {
    const description = String(it?.description ?? '').trim()
    const body = String(it?.body ?? '').trim()
    if (!description || !body) continue
    if (existing.some((e) => norm(e.description) === norm(description))) continue // dedup
    const type = (['user', 'feedback', 'project', 'reference'].includes(String(it?.type)) ? it!.type : 'reference') as MemoryEntry['type']
    const baseSlug = description.slice(0, 48).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fact'
    // never overwrite an existing memory of the same slug (saveMemory writes <slug>.md)
    const taken = new Set([...existing.map((e) => e.name), ...saved])
    let name = baseSlug
    for (let n = 2; taken.has(name) && n < 50; n++) name = `${baseSlug}-${n}`
    const e = saveMemory({ name, description, type, body, projectId: type === 'project' ? projectId : undefined })
    saved.push(e.name)
  }
  return saved
}
