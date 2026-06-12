import { AppSettings, SkillDef, SubagentDef } from '@shared/types'
import { Tool, buildToolset } from './tools'
import { loadSkills } from '../systems/skills'
import { loadSubagents } from '../systems/subagents'
import { pluginSkills, pluginSubagents } from '../systems/plugins'
import { mcpManager } from '../systems/mcp'

// Assembles the live tool/skill/subagent sets for a working directory
// (user + project + plugin sources, plus connected MCP tools).

export function collectSkills(cwd: string): SkillDef[] {
  return [...loadSkills(cwd), ...pluginSkills()]
}

export function collectSubagents(cwd: string): SubagentDef[] {
  return [...loadSubagents(cwd), ...pluginSubagents()]
}

export function buildTools(
  _settings: AppSettings,
  cwd: string,
  opts?: { includeTask?: boolean; allow?: string[] }
): Tool[] {
  return buildToolset({
    subagents: collectSubagents(cwd),
    skills: collectSkills(cwd),
    mcpTools: mcpManager.getTools(),
    includeTask: opts?.includeTask,
    allow: opts?.allow
  })
}
