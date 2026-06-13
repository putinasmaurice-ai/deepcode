import { AppSettings, SkillDef, SubagentDef } from '@shared/types'
import { Tool, buildToolset } from './tools'
import { loadSkills } from '../systems/skills'
import { loadSubagents } from '../systems/subagents'
import { pluginSkills, pluginSubagents } from '../systems/plugins'
import { loadMemory } from '../systems/memory'
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
  settings: AppSettings,
  cwd: string,
  opts?: { includeTask?: boolean; allow?: string[] }
): Tool[] {
  const cc = settings.claudeCode
  return buildToolset({
    subagents: collectSubagents(cwd),
    skills: collectSkills(cwd),
    memories: loadMemory(),
    mcpTools: mcpManager.getTools(),
    includeTask: opts?.includeTask,
    allow: opts?.allow,
    semanticSearch: { localBaseUrl: settings.provider.localBaseUrl, embeddingModel: settings.provider.embeddingModel },
    claudeCode: cc?.enabled
      ? {
          path: cc.path,
          permissionMode: cc.permissionMode,
          model: cc.model,
          maxBudgetUsd: cc.maxBudgetUsd
        }
      : undefined
  })
}
