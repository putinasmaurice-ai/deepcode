import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Session } from '@shared/types'
import { EngineDeps } from './deps'
import { PATHS } from '../paths'

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
  const dir = join(PATHS.skills, slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(
    file,
    `---\nname: ${slug}\ndescription: ${(descMatch?.[1] ?? '').trim()}\n---\n\n${bodyMatch[1].trim()}\n`,
    'utf8'
  )
  return { name: slug, path: file }
}
