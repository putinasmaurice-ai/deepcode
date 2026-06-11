import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS, projectConfigDir } from '../paths'
import { parseFrontmatter, str, arr } from './frontmatter'
import { SubagentDef } from '@shared/types'

// A subagent is ~/.deepcode/agents/<name>.md:
//   ---
//   name: code-reviewer
//   description: Reviews a diff for bugs and style issues
//   tools: [read_file, grep, glob]      # subset, or omit for all
//   model: deepseek-reasoner             # optional override
//   ---
//   <system prompt for the subagent>

function loadAgentDir(dir: string, source: SubagentDef['source']): SubagentDef[] {
  const out: SubagentDef[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    try {
      const text = readFileSync(join(dir, entry.name), 'utf8')
      const { data, body } = parseFrontmatter(text)
      const tools = arr(data.tools)
      out.push({
        name: str(data.name) || entry.name.replace(/\.md$/, ''),
        description: str(data.description) || '(no description)',
        systemPrompt: body.trim(),
        tools: tools.length ? tools : ['*'],
        model: str(data.model) || undefined,
        source
      })
    } catch {
      /* skip */
    }
  }
  return out
}

export function loadSubagents(cwd?: string): SubagentDef[] {
  const agents = loadAgentDir(PATHS.agents, 'user')
  if (cwd) agents.push(...loadAgentDir(join(projectConfigDir(cwd), 'agents'), 'project'))
  return agents
}

export function getSubagent(name: string, cwd?: string): SubagentDef | null {
  return loadSubagents(cwd).find((a) => a.name === name) ?? null
}
