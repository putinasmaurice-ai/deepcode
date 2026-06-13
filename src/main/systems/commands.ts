import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS, projectConfigDir } from '../paths'
import { parseFrontmatter, str } from './frontmatter'
import { pluginCommands } from './plugins'
import { SlashCommandDef } from '@shared/types'

// A slash command is ~/.deepcode/commands/<name>.md whose body is a prompt
// template. Typing "/name some args" expands the template ($ARGUMENTS is
// replaced with the text after the command) and submits it as the user turn.

function loadCommandDir(dir: string, source: SlashCommandDef['source']): SlashCommandDef[] {
  const out: SlashCommandDef[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    try {
      const text = readFileSync(join(dir, entry.name), 'utf8')
      const { data, body } = parseFrontmatter(text)
      const name = (str(data.name) || entry.name.replace(/\.md$/, '')).replace(/^\//, '')
      out.push({
        name,
        description: str(data.description) || body.split('\n')[0].slice(0, 80),
        path: join(dir, entry.name),
        template: body,
        source
      })
    } catch {
      /* skip */
    }
  }
  return out
}

export function loadCommands(cwd?: string): SlashCommandDef[] {
  const cmds = loadCommandDir(PATHS.commands, 'user')
  if (cwd) cmds.push(...loadCommandDir(join(projectConfigDir(cwd), 'commands'), 'project'))
  return cmds
}

export function expandCommand(name: string, args: string, cwd?: string): string | null {
  // include plugin-provided commands — the listing endpoints advertise them, so dispatch must
  // resolve them too (file commands win on a name clash). Otherwise "/pluginCmd" was sent literally.
  const cmd = [...loadCommands(cwd), ...pluginCommands()].find((c) => c.name === name)
  if (!cmd) return null
  if (cmd.template.includes('$ARGUMENTS')) return cmd.template.replaceAll('$ARGUMENTS', args)
  return args ? `${cmd.template}\n\n${args}` : cmd.template
}
