import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { Session } from '@shared/types'

// Exports a session transcript as a readable Markdown file into the session's
// working directory. Returns the written path.

export function exportSessionMarkdown(session: Session): string {
  const lines: string[] = []
  lines.push(`# ${session.title || 'DeepCode Session'}`)
  lines.push('')
  lines.push(`- Arbeitsverzeichnis: \`${session.cwd}\``)
  lines.push(`- Erstellt: ${new Date(session.createdAt).toLocaleString()}`)
  lines.push(`- Modell: ${session.model ?? 'default'}`)
  lines.push('')
  if (session.todos?.length) {
    lines.push('')
    lines.push('## Aufgaben')
    for (const t of session.todos) lines.push(`- [${t.status === 'done' ? 'x' : ' '}] ${t.text}`)
  }
  lines.push('')
  lines.push('---')

  for (const m of session.messages) {
    if (m.role === 'user') {
      const visible = m.content.replace(/^<attached-context>[\s\S]*?<\/attached-context>\s*/, '')
      lines.push('')
      lines.push(`## 🧑 Du`)
      lines.push('')
      lines.push(visible || '(Anhänge)')
    } else if (m.role === 'assistant') {
      lines.push('')
      lines.push(`## 🐋 DeepCode`)
      lines.push('')
      if (m.content) lines.push(m.content)
      for (const tc of m.toolCalls ?? []) {
        lines.push('')
        lines.push(`> 🔧 \`${tc.name}\` ${tc.arguments.slice(0, 200)}`)
      }
      if (m.usage) {
        lines.push('')
        lines.push(
          `_${m.usage.totalTokens.toLocaleString()} Tokens · $${m.usage.cost.toFixed(4)}_`
        )
      }
    } else if (m.role === 'tool') {
      const head = m.content.split('\n').slice(0, 6).join('\n')
      lines.push('')
      lines.push(`<details><summary>Ergebnis: ${m.toolName}</summary>`)
      lines.push('')
      lines.push('```')
      lines.push(head)
      if (m.content.split('\n').length > 6) lines.push('…')
      lines.push('```')
      lines.push('</details>')
    }
  }

  const stamp = new Date(session.updatedAt).toISOString().slice(0, 10)
  const safeTitle = (session.title || 'session').replace(/[^a-zA-Z0-9äöüÄÖÜß _-]/g, '').slice(0, 40).trim() || 'session'
  // don't silently overwrite a prior export of the same title+day (or a same-named
  // other session): add a numeric suffix when the target already exists.
  const base = `deepcode-${safeTitle}-${stamp}`
  let path = join(session.cwd, `${base}.md`)
  for (let n = 2; existsSync(path) && n < 1000; n++) path = join(session.cwd, `${base}-${n}.md`)
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}
