import { randomUUID } from 'crypto'
import { ChatMessage, ToolResult, TokenUsage } from '@shared/types'
import { EngineDeps, Emit } from './deps'
import { buildSystemPrompt } from './prompt'
import { toApiMessages, toolResultMessage } from './api-messages'
import { costOf } from './pricing'
import { recordUsage, overDailyCap } from '../ledger'
import { buildTools, collectSkills } from './toolset'
import { toApiTools } from './tools'
import { ToolContext } from './tools/types'
import { getSubagent } from '../systems/subagents'
import { pluginSubagents } from '../systems/plugins'
import { screenUnattendedCall } from './policy'

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
  signal: AbortSignal,
  onUsage?: (u: TokenUsage) => void, // trace/cost bubbling: called per billed round
  allowOverride?: string[], // restrict the worker's toolset (swarm workers = pure editors)
  forceConfine?: boolean // swarm workers: force cwd confinement even if the user disabled it
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
    // an explicit override (swarm workers) wins over the agent def / the default ['*']
    allow: allowOverride ?? agent?.tools ?? ['*']
  })
  // deepseek-reasoner does not support function calling — run it tool-less.
  const reasonerOnly = !!agent?.model && /reason/i.test(agent.model)
  const apiTools = reasonerOnly ? [] : toApiTools(tools)

  const ctx: ToolContext = {
    cwd,
    signal,
    confineToCwd: forceConfine ? true : deps.settings.confineToCwd,
    // subagents are by definition unattended → mark the context so every tool's in-execute
    // unattended guard (e.g. preview_probe) is authoritative, not just screenUnattendedCall.
    unattended: true,
    emitStatus: (m) => emit({ type: 'status', message: `[${agentName}] ${m}` })
  }

  const messages: ChatMessage[] = [
    { id: randomUUID(), role: 'user', content: prompt, createdAt: Date.now() }
  ]

  let finalText = ''
  let spentUsd = 0 // per-worker spend — bounds a subagent to maxCostPerTurn like the main loop
  const perCap = deps.settings.maxCostPerTurn
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) break
    // cost guards (matter most for swarm: N workers run in parallel). Stop this worker once it
    // hits the per-turn cap, and stop ALL work once the daily cap is reached.
    if (perCap > 0 && spentUsd >= perCap) {
      emit({ type: 'status', message: `[${agentName}] Budget-Limit ($${perCap.toFixed(2)}) erreicht — gestoppt.` })
      break
    }
    if (overDailyCap(deps.settings.maxCostPerDay)) {
      emit({ type: 'status', message: `[${agentName}] Tagesbudget erreicht — gestoppt.` })
      break
    }
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
    if (result.usage) {
      assistantMsg.usage = costOf(deps.settings.provider, result.usage, agent?.model)
      recordUsage(assistantMsg.usage)
      spentUsd += assistantMsg.usage.cost
      onUsage?.(assistantMsg.usage)
    }
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
          // Subagents run unattended → the SAME hard screen the engine applies to workflow
          // agent nodes: no dangerous shell / MCP / claude_code / task / outward git, even
          // when autoApprove.bash is on. This screen takes precedence over the permission
          // bucket so delegated work can't be an open door around gateToolCall.
          const blocked = screenUnattendedCall(call.name, args)
          if (blocked) {
            res = { ok: false, content: blocked }
          } else if (!autoApproved(tool.permission)) {
            res = {
              ok: false,
              content:
                `Tool ${call.name} (${tool.permission}) needs approval and subagents run unattended, so it was skipped. ` +
                `Enable auto-approve for "${tool.permission}" in Settings to let subagents use it, or work without this tool.`
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
