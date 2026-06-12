import { randomUUID } from 'crypto'
import { ChatMessage, ToolResult } from '@shared/types'
import { EngineDeps, Emit } from './deps'
import { buildSystemPrompt } from './prompt'
import { toApiMessages, toolResultMessage } from './api-messages'
import { costOf } from './pricing'
import { buildTools, collectSkills } from './toolset'
import { toApiTools } from './tools'
import { ToolContext } from './tools/types'
import { getSubagent } from '../systems/subagents'
import { pluginSubagents } from '../systems/plugins'

const MAX_STEPS = 60

// Nested subagent loop: a delegated agent with its own system prompt and a
// (possibly restricted) tool set. Auto-approves only within configured
// permissions; returns its final text to the parent turn.
export async function runSubagent(
  deps: EngineDeps,
  autoApproved: (toolPermission: string) => boolean,
  agentName: string,
  prompt: string,
  cwd: string,
  emit: Emit,
  signal: AbortSignal
): Promise<string> {
  const agent = getSubagent(agentName, cwd) ?? pluginSubagents().find((a) => a.name === agentName)
  const systemBase = buildSystemPrompt({
    cwd,
    skills: collectSkills(cwd),
    customInstructions: deps.settings.customInstructions
  })
  const system = agent
    ? `${systemBase}\n\n# Subagent role: ${agent.name}\n${agent.systemPrompt}`
    : `${systemBase}\n\n# Subagent role: general-purpose assistant`

  emit({ type: 'status', message: `Subagent "${agentName}" started.` })

  const tools = buildTools(deps.settings, cwd, {
    includeTask: false,
    allow: agent?.tools ?? ['*']
  })
  // deepseek-reasoner does not support function calling — run it tool-less.
  const reasonerOnly = !!agent?.model && /reason/i.test(agent.model)
  const apiTools = reasonerOnly ? [] : toApiTools(tools)

  const ctx: ToolContext = {
    cwd,
    signal,
    confineToCwd: deps.settings.confineToCwd,
    emitStatus: (m) => emit({ type: 'status', message: `[${agentName}] ${m}` })
  }

  const messages: ChatMessage[] = [
    { id: randomUUID(), role: 'user', content: prompt, createdAt: Date.now() }
  ]

  let finalText = ''
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) break
    const result = await deps.client.streamChat(
      toApiMessages(system, messages),
      apiTools,
      {},
      signal,
      agent?.model
    )
    const assistantMsg: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: result.content,
      createdAt: Date.now(),
      finishReason: result.finishReason,
      toolCalls: result.toolCalls.map((tc) => ({
        id: tc.id || randomUUID(),
        name: tc.name,
        arguments: tc.arguments || '{}'
      }))
    }
    if (result.usage) assistantMsg.usage = costOf(deps.settings.provider, result.usage, agent?.model)
    messages.push(assistantMsg)
    finalText = result.content || finalText

    // If the response was truncated, don't execute possibly-incomplete tool calls.
    if (result.finishReason === 'length') break
    if (!assistantMsg.toolCalls?.length) break

    for (const call of assistantMsg.toolCalls) {
      if (signal.aborted) break
      const tool = tools.find((t) => t.name === call.name)
      let res: ToolResult
      if (!tool) res = { ok: false, content: `Unknown tool: ${call.name}` }
      else {
        try {
          const args = call.arguments ? JSON.parse(call.arguments) : {}
          if (!autoApproved(tool.permission)) {
            res = {
              ok: false,
              content: `Tool ${call.name} requires approval; not available to subagents in this mode.`
            }
          } else {
            res = await tool.execute(args, ctx)
          }
        } catch (e) {
          res = { ok: false, content: `Tool error: ${(e as Error).message}` }
        }
      }
      messages.push(toolResultMessage(call.id, call.name, res))
    }
  }

  emit({ type: 'status', message: `Subagent "${agentName}" finished.` })
  return finalText || '(subagent produced no text output)'
}
