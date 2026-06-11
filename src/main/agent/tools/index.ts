import { Tool } from './types'
import { fsTools } from './fs'
import { bashTool } from './bash'
import { makeTaskTool } from './task'
import { makeSkillTool } from './skill'
import { SubagentDef, SkillDef } from '@shared/types'
import { ApiToolDef } from '../deepseek'

export type { Tool } from './types'

// Build the active tool set for a turn. MCP tools are appended dynamically.
export function buildToolset(opts: {
  subagents: SubagentDef[]
  skills?: SkillDef[]
  mcpTools?: Tool[]
  includeTask?: boolean // false for subagents (no recursive delegation)
  allow?: string[] // restrict to these tool names ("*" = all); used by subagents
}): Tool[] {
  let tools: Tool[] = [...fsTools, bashTool]
  if (opts.includeTask !== false) tools.push(makeTaskTool(opts.subagents))
  if (opts.skills?.length) tools.push(makeSkillTool(opts.skills))
  if (opts.mcpTools?.length) tools = tools.concat(opts.mcpTools)

  if (opts.allow && !opts.allow.includes('*')) {
    const allow = new Set(opts.allow)
    tools = tools.filter((t) => allow.has(t.name))
  }
  return tools
}

// Convert internal Tool defs to the OpenAI/DeepSeek function-tool wire format.
export function toApiTools(tools: Tool[]): ApiToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }))
}
