import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import {
  AgentEvent,
  AppSettings,
  ChatMessage,
  Session,
  ToolResult,
  TokenUsage
} from '@shared/types'
import { DeepSeekClient, ApiMessage, RawUsage } from './deepseek'
import { buildToolset, toApiTools, Tool } from './tools'
import { ToolContext } from './tools/types'
import { buildSystemPrompt } from './prompt'
import { loadSkills } from '../systems/skills'
import { loadSubagents, getSubagent } from '../systems/subagents'
import { pluginSkills, pluginSubagents, pluginHooks } from '../systems/plugins'
import { loadHooks, runHooks } from '../systems/hooks'
import { mcpManager } from '../systems/mcp'
import { saveSession } from '../store'
import { getProject } from '../projects'
import { recordSnapshot, getTurnFiles } from '../checkpoints'
import { recordErrorSolution } from '../systems/memory'
import { appendFileSync } from 'fs'
import { join, relative } from 'path'

type Emit = (e: AgentEvent) => void
// 'interactive' = ask the user; 'safe' = deny anything not pre-approved (headless);
// 'full' = auto-approve everything; 'plan' = read-only — write/shell tools are
// refused so the agent investigates and proposes instead of changing anything.
export type ApprovalPolicy = 'interactive' | 'safe' | 'full' | 'plan'

const MAX_STEPS = 60

// Commands that can be catastrophic — always require explicit approval, even when
// shell auto-approve is on. Heuristic, intentionally conservative.
const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?\b/i,
  /\brm\s+-rf?\s+[/~]/i,
  /\b(format|mkfs|fdisk)\b/i,
  /\bdd\s+if=/i,
  /\b(Remove-Item|rmdir)\b.*\b-Recurse\b/i,
  /\b:\(\)\s*\{.*\}\s*;/, // fork bomb
  />\s*\/dev\/sd[a-z]/i,
  /\bgit\s+push\b.*--force/i
]

function isDangerousCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  return DANGER_PATTERNS.some((re) => re.test(cmd))
}

export class AgentEngine {
  private client: DeepSeekClient
  private pendingApprovals = new Map<string, (approved: boolean) => void>()
  private aborters = new Map<string, AbortController>()

  constructor(private settings: AppSettings) {
    this.client = new DeepSeekClient(settings.provider)
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings
    this.client.update(settings.provider)
  }

  approve(callId: string, approved: boolean): void {
    const resolver = this.pendingApprovals.get(callId)
    if (resolver) {
      this.pendingApprovals.delete(callId)
      resolver(approved)
    }
  }

  cancel(sessionId: string): void {
    this.aborters.get(sessionId)?.abort()
  }

  // --- Build conversation history in API format ---
  // Guarantees that every assistant tool_call is followed by a matching tool
  // message — otherwise the API rejects the request (this can happen after a
  // turn is cancelled mid-tool-execution).
  private toApiMessages(system: string, messages: ChatMessage[]): ApiMessage[] {
    const out: ApiMessage[] = [{ role: 'system', content: system }]
    const respondedIds = new Set(
      messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string)
    )

    for (const m of messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content })
      } else if (m.role === 'assistant') {
        const msg: ApiMessage = { role: 'assistant', content: m.content || '' }
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments }
          }))
          if (!m.content) msg.content = null
        }
        out.push(msg)
        // backfill any tool_calls that never got a response
        for (const tc of m.toolCalls ?? []) {
          if (!respondedIds.has(tc.id)) {
            out.push({
              role: 'tool',
              content: '(no result — the previous turn was interrupted)',
              tool_call_id: tc.id,
              name: tc.name
            })
            respondedIds.add(tc.id)
          }
        }
      } else if (m.role === 'tool') {
        out.push({
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId,
          name: m.toolName
        })
      }
    }
    return out
  }

  private collectSkills(cwd: string) {
    return [...loadSkills(cwd), ...pluginSkills()]
  }
  private collectSubagents(cwd: string) {
    return [...loadSubagents(cwd), ...pluginSubagents()]
  }

  private buildTools(cwd: string, opts?: { includeTask?: boolean; allow?: string[] }): Tool[] {
    return buildToolset({
      subagents: this.collectSubagents(cwd),
      skills: this.collectSkills(cwd),
      mcpTools: mcpManager.getTools(),
      includeTask: opts?.includeTask,
      allow: opts?.allow
    })
  }

  private autoApproved(tool: Tool): boolean {
    if (tool.permission === 'none') return true
    if (tool.permission === 'read') return this.settings.autoApprove.read
    if (tool.permission === 'write') return this.settings.autoApprove.write
    if (tool.permission === 'bash') return this.settings.autoApprove.bash
    return false
  }

  private costOf(usage: RawUsage, model?: string): TokenUsage {
    if (model?.startsWith('local:')) return { ...usage, cost: 0 } // local = free
    const p = this.settings.provider
    const cost =
      (usage.promptTokens / 1_000_000) * (p.pricePerMillionInput || 0) +
      (usage.completionTokens / 1_000_000) * (p.pricePerMillionOutput || 0)
    return { ...usage, cost }
  }

  private async requestApproval(
    emit: Emit,
    callId: string,
    name: string,
    args: string
  ): Promise<boolean> {
    emit({ type: 'tool_pending', callId, name, args })
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(callId, resolve)
    })
  }

  // --- Main entry: run one user turn to completion ---
  async runTurn(
    session: Session,
    userText: string,
    emit: Emit,
    policy: ApprovalPolicy = 'interactive'
  ): Promise<void> {
    const aborter = new AbortController()
    this.aborters.set(session.id, aborter)
    const signal = aborter.signal

    try {
      const hooks = [...loadHooks(session.cwd), ...pluginHooks()]

      // UserPromptSubmit hooks may inject extra context
      const injected = await runHooks('UserPromptSubmit', { prompt: userText, cwd: session.cwd }, hooks)

      const userMsg: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: injected ? `${userText}\n\n<hook-context>\n${injected}\n</hook-context>` : userText,
        createdAt: Date.now()
      }
      session.messages.push(userMsg)
      saveSession(session)

      // Auto-compact if the session has grown past the configured token threshold.
      if (this.settings.compactThreshold > 0 && this.estimateTokens(session) > this.settings.compactThreshold) {
        await this.compactSession(session, emit)
      }

      const skills = this.collectSkills(session.cwd)
      const project = session.projectId ? getProject(session.projectId) : null

      // Project trust level can relax or tighten the interactive default.
      if (policy === 'interactive' && project?.trustLevel === 'trusted') policy = 'full'
      if (policy !== 'plan' && project?.trustLevel === 'restricted') policy = 'safe'

      const system = buildSystemPrompt({
        cwd: session.cwd,
        skills,
        customInstructions: this.settings.customInstructions,
        project: project
          ? { name: project.name, instructions: project.instructions, goal: project.goal }
          : null,
        sessionGoal: session.goal,
        planMode: policy === 'plan'
      })

      const tools = this.buildTools(session.cwd)
      const apiTools = toApiTools(tools)

      const turnTag = String(Date.now())
      const ctx: ToolContext = {
        cwd: session.cwd,
        signal,
        confineToCwd: this.settings.confineToCwd,
        emitStatus: (m) => emit({ type: 'status', message: m }),
        snapshot: (absPath) => recordSnapshot(session.id, turnTag, absPath),
        emitTodos: (todos) => {
          session.todos = todos
          saveSession(session)
          emit({ type: 'todos', sessionId: session.id, todos })
        },
        spawnSubagent: (agent, prompt) => this.runSubagent(agent, prompt, session.cwd, emit, signal)
      }

      // error memory: remember "failed command → working follow-up" pairs
      let lastFailedCmd: { program: string; errorHead: string } | null = null

      // quality loop: after the agent finishes, optionally self-review and/or
      // run the project's verify command — failures feed back automatically.
      let reviewDone = false
      let verifyAttempts = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) break

        const apiMessages = this.toApiMessages(system, session.messages)
        const assistantMsg: ChatMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: '',
          createdAt: Date.now()
        }
        emit({ type: 'message_start', message: assistantMsg })

        const result = await this.client.streamChat(
          apiMessages,
          apiTools,
          {
            onReasoning: (d) => {
              assistantMsg.reasoning = (assistantMsg.reasoning ?? '') + d
              emit({ type: 'reasoning_delta', messageId: assistantMsg.id, delta: d })
            },
            onContent: (d) => {
              assistantMsg.content += d
              emit({ type: 'content_delta', messageId: assistantMsg.id, delta: d })
            }
          },
          signal,
          session.model
        )

        assistantMsg.toolCalls = result.toolCalls.map((tc) => ({
          id: tc.id || randomUUID(),
          name: tc.name,
          arguments: tc.arguments || '{}'
        }))
        assistantMsg.finishReason = result.finishReason
        if (result.usage) {
          assistantMsg.usage = this.costOf(result.usage, session.model)
          emit({ type: 'usage', messageId: assistantMsg.id, usage: assistantMsg.usage })
        }
        session.messages.push(assistantMsg)
        emit({ type: 'message_done', message: assistantMsg })
        saveSession(session)

        if (!assistantMsg.toolCalls.length) {
          if (result.finishReason === 'length') {
            emit({
              type: 'status',
              message:
                'Response was cut off at the max-tokens limit. Increase "Max tokens" in Settings for longer answers.'
            })
          }
          break // no tools -> turn complete
        }

        // Execute each tool call sequentially
        for (const call of assistantMsg.toolCalls) {
          if (signal.aborted) break
          const tool = tools.find((t) => t.name === call.name)
          let resultMsg: ChatMessage

          if (!tool) {
            resultMsg = this.toolResultMessage(call.id, call.name, {
              ok: false,
              content: `Unknown tool: ${call.name}`
            })
          } else {
            let parsedArgs: any = {}
            try {
              parsedArgs = call.arguments ? JSON.parse(call.arguments) : {}
            } catch {
              resultMsg = this.toolResultMessage(call.id, call.name, {
                ok: false,
                content: `Invalid JSON arguments: ${call.arguments}`
              })
              session.messages.push(resultMsg)
              emit({ type: 'tool_result', callId: call.id, name: call.name, result: { ok: false, content: resultMsg.content } })
              continue
            }

            // approval gate
            let approved = this.autoApproved(tool)
            const dangerous = call.name === 'run_command' && isDangerousCommand(parsedArgs.command)
            const mutating = tool.permission === 'write' || tool.permission === 'bash'
            if (policy === 'plan' && mutating) {
              approved = false // plan mode: investigate + propose only, never modify
            } else if (policy === 'full') {
              approved = true
            } else if (!approved || dangerous) {
              if (policy === 'safe') {
                approved = false // headless: never run un-approved/dangerous tools
              } else {
                approved = await this.requestApproval(emit, call.id, call.name, call.arguments)
              }
            }
            if (!approved) {
              const res: ToolResult = {
                ok: false,
                content:
                  policy === 'plan' && mutating
                    ? `Plan mode: "${call.name}" was NOT executed. Describe this change as part of your plan instead.`
                    : policy === 'safe'
                      ? `Skipped "${call.name}" — not permitted in unattended (safe) mode.`
                      : 'Tool call was denied by the user.'
              }
              resultMsg = this.toolResultMessage(call.id, call.name, res)
              session.messages.push(resultMsg)
              emit({ type: 'tool_result', callId: call.id, name: call.name, result: res })
              continue
            }

            // PreToolUse hooks
            await runHooks('PreToolUse', { toolName: call.name, toolArgs: parsedArgs, cwd: session.cwd }, hooks)

            let res: ToolResult
            try {
              res = await tool.execute(parsedArgs, ctx)
            } catch (e) {
              res = { ok: false, content: `Tool threw: ${(e as Error).message}` }
            }

            // PostToolUse hooks
            await runHooks('PostToolUse', { toolName: call.name, toolArgs: parsedArgs, cwd: session.cwd }, hooks)

            // error memory: failed command followed by a working variant of the
            // same program → remember the fix for future sessions
            if (call.name === 'run_command' && typeof parsedArgs.command === 'string') {
              const program = parsedArgs.command.trim().split(/\s+/)[0] ?? ''
              if (!res.ok) {
                const errorHead =
                  res.content.split('\n').find((l) => /error|fehler|exception|fatal/i.test(l)) ??
                  res.content.split('\n')[0] ??
                  ''
                lastFailedCmd = { program, errorHead: errorHead.trim() }
              } else if (lastFailedCmd && lastFailedCmd.program === program && lastFailedCmd.errorHead) {
                try {
                  recordErrorSolution(lastFailedCmd.errorHead, parsedArgs.command.trim())
                } catch {
                  /* memory write must never break the loop */
                }
                lastFailedCmd = null
              }
            }

            resultMsg = this.toolResultMessage(call.id, call.name, res)
            emit({ type: 'tool_result', callId: call.id, name: call.name, result: res })
          }

          session.messages.push(resultMsg)
          saveSession(session)
        }
      }

      // ---- quality gates ----
      if (signal.aborted) break
      const changedSoFar = getTurnFiles(session.id, turnTag)
      if (!changedSoFar.length || policy === 'plan') break

      // (1) one self-review pass over the own changes (opt-in, ≈1 extra round)
      if (this.settings.selfReview && !reviewDone) {
        reviewDone = true
        emit({ type: 'status', message: '🔍 Selbst-Review der Änderungen…' })
        session.messages.push({
          id: randomUUID(),
          role: 'user',
          content:
            'Selbst-Review: Prüfe die Dateien, die du in dieser Aufgabe geändert hast, kritisch auf Bugs, ' +
            'vergessene Anpassungen an Aufrufstellen, Importfehler und Verstöße gegen die Projektkonventionen. ' +
            'Behebe gefundene Probleme direkt. Wenn alles korrekt ist, antworte nur: "Review ok."',
          createdAt: Date.now()
        })
        saveSession(session)
        continue
      }

      // (2) project verify command (e.g. npm test) with auto-fix feedback
      if (project?.verifyCommand && verifyAttempts < 2) {
        emit({ type: 'status', message: `⚙ Verify: ${project.verifyCommand}` })
        const v = await this.runVerify(project.verifyCommand, session.cwd, signal)
        if (v.ok) {
          emit({ type: 'status', message: '✅ Verify bestanden.' })
          break
        }
        verifyAttempts++
        emit({
          type: 'status',
          message: `❌ Verify fehlgeschlagen — automatischer Fix (Versuch ${verifyAttempts}/2)…`
        })
        session.messages.push({
          id: randomUUID(),
          role: 'user',
          content: `Der Verify-Befehl \`${project.verifyCommand}\` ist nach deinen Änderungen fehlgeschlagen:\n\n\`\`\`\n${v.output.slice(-5000)}\n\`\`\`\n\nAnalysiere die Ursache und behebe sie.`,
          createdAt: Date.now()
        })
        saveSession(session)
        continue
      }
      break
      }

      // auto-changelog (opt-in per project): record what this turn changed
      if (project?.autoChangelog) {
        try {
          const changed = getTurnFiles(session.id, turnTag)
          if (changed.length) {
            const rels = changed.map((p) => relative(session.cwd, p) || p)
            const entry =
              `\n## ${new Date().toLocaleString()} — ${userText.replace(/\s+/g, ' ').slice(0, 90)}\n` +
              rels.map((r) => `- ${r}`).join('\n') +
              '\n'
            appendFileSync(join(session.cwd, 'CHANGELOG-DEEPCODE.md'), entry, 'utf8')
          }
        } catch {
          /* changelog must never break the turn */
        }
      }

      await runHooks('Stop', { cwd: session.cwd }, hooks)
      emit({ type: 'turn_done', sessionId: session.id })
    } catch (e) {
      if ((e as Error).name === 'AbortError' || signal.aborted) {
        emit({ type: 'status', message: 'Turn cancelled.' })
        emit({ type: 'turn_done', sessionId: session.id })
      } else {
        emit({ type: 'error', message: (e as Error).message })
        emit({ type: 'turn_done', sessionId: session.id })
      }
    } finally {
      this.aborters.delete(session.id)
      saveSession(session)
    }
  }

  // Rough token estimate (~4 chars/token) used for the auto-compaction trigger.
  estimateTokens(session: Session): number {
    let chars = 0
    for (const m of session.messages) chars += (m.content?.length ?? 0) + (m.reasoning?.length ?? 0)
    return Math.ceil(chars / 4)
  }

  // Summarize older turns into one synthetic message to keep context small while
  // preserving recent turns and tool-call/result pairing.
  async compactSession(session: Session, emit: Emit): Promise<Session> {
    const msgs = session.messages
    if (msgs.length < 8) {
      emit({ type: 'status', message: 'Nothing to compact yet.' })
      return session
    }
    // Keep the last ~6 messages verbatim; summarize everything before, but never
    // split an assistant tool_calls block from its tool responses.
    let cut = Math.max(2, msgs.length - 6)
    while (cut < msgs.length && msgs[cut].role === 'tool') cut++ // don't start the tail on an orphan tool msg
    const older = msgs.slice(0, cut)
    const recent = msgs.slice(cut)

    const transcript = older
      .map((m) => {
        if (m.role === 'tool') return `TOOL(${m.toolName}): ${m.content.slice(0, 800)}`
        const tc = m.toolCalls?.length ? ` [called: ${m.toolCalls.map((t) => t.name).join(', ')}]` : ''
        return `${m.role.toUpperCase()}: ${m.content.slice(0, 2000)}${tc}`
      })
      .join('\n\n')

    emit({ type: 'status', message: 'Compacting conversation…' })
    const aborter = new AbortController()
    let summary = ''
    try {
      const res = await this.client.streamChat(
        [
          {
            role: 'system',
            content:
              'You compress a coding-assistant conversation. Produce a dense summary that preserves: the user goals, decisions made, files created/edited (with paths), key findings, commands run and their outcomes, and any open TODOs. Keep it factual and compact.'
          },
          { role: 'user', content: `Summarize this conversation so work can continue:\n\n${transcript}` }
        ],
        [],
        {},
        aborter.signal,
        session.model
      )
      summary = res.content
    } catch (e) {
      emit({ type: 'error', message: `Compaction failed: ${(e as Error).message}` })
      return session
    }

    const synthetic: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: `<conversation-summary>\n${summary}\n</conversation-summary>`,
      createdAt: Date.now(),
      hidden: false
    }
    session.messages = [synthetic, ...recent]
    saveSession(session)
    emit({ type: 'status', message: `Compacted ${older.length} messages into a summary.` })
    return session
  }

  // Second opinion: re-answer the conversation with the reasoner model (no tools)
  // and stream it as a tagged alternative message. DeepSeek is cheap — exploit it.
  async secondOpinion(session: Session, emit: Emit): Promise<void> {
    const aborter = new AbortController()
    this.aborters.set(session.id, aborter)
    try {
      const model = this.settings.provider.reasonerModel || this.settings.provider.model
      const project = session.projectId ? getProject(session.projectId) : null
      const system = buildSystemPrompt({
        cwd: session.cwd,
        skills: [],
        customInstructions: this.settings.customInstructions,
        project: project
          ? { name: project.name, instructions: project.instructions, goal: project.goal }
          : null,
        sessionGoal: session.goal
      })
      const apiMessages = this.toApiMessages(
        system +
          '\n\n# Second-opinion mode\nReview the conversation and give YOUR OWN independent answer to the last user request. If the previous assistant answer has flaws, point them out concretely; if it is good, say so briefly and add what is missing.',
        session.messages
      )
      const msg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        variant: 'second-opinion',
        variantModel: model
      }
      emit({ type: 'message_start', message: msg })
      const result = await this.client.streamChat(
        apiMessages,
        [],
        {
          onReasoning: (d) => {
            msg.reasoning = (msg.reasoning ?? '') + d
            emit({ type: 'reasoning_delta', messageId: msg.id, delta: d })
          },
          onContent: (d) => {
            msg.content += d
            emit({ type: 'content_delta', messageId: msg.id, delta: d })
          }
        },
        aborter.signal,
        model
      )
      msg.finishReason = result.finishReason
      if (result.usage) {
        msg.usage = this.costOf(result.usage, model)
        emit({ type: 'usage', messageId: msg.id, usage: msg.usage })
      }
      session.messages.push(msg)
      saveSession(session)
      emit({ type: 'message_done', message: msg })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') emit({ type: 'error', message: (e as Error).message })
    } finally {
      this.aborters.delete(session.id)
      emit({ type: 'turn_done', sessionId: session.id })
    }
  }

  // Model arena: answer the last user request with TWO models in parallel and
  // stream both as tagged messages — the user votes, the vote becomes memory.
  async arena(session: Session, emit: Emit, modelB?: string): Promise<void> {
    const aborter = new AbortController()
    this.aborters.set(session.id, aborter)
    const modelA = session.model || this.settings.provider.model
    const b = modelB || this.settings.provider.reasonerModel || modelA

    const project = session.projectId ? getProject(session.projectId) : null
    const system =
      buildSystemPrompt({
        cwd: session.cwd,
        skills: [],
        customInstructions: this.settings.customInstructions,
        project: project
          ? { name: project.name, instructions: project.instructions, goal: project.goal }
          : null,
        sessionGoal: session.goal
      }) +
      '\n\n# Arena mode\nAnswer the last user request directly and completely. Tools are unavailable — answer from the conversation context.'

    const apiMessages = this.toApiMessages(system, session.messages)

    const runOne = async (model: string): Promise<ChatMessage> => {
      const msg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        variant: 'arena',
        variantModel: model
      }
      emit({ type: 'message_start', message: msg })
      const result = await this.client.streamChat(
        apiMessages,
        [],
        {
          onReasoning: (d) => {
            msg.reasoning = (msg.reasoning ?? '') + d
            emit({ type: 'reasoning_delta', messageId: msg.id, delta: d })
          },
          onContent: (d) => {
            msg.content += d
            emit({ type: 'content_delta', messageId: msg.id, delta: d })
          }
        },
        aborter.signal,
        model
      )
      msg.finishReason = result.finishReason
      if (result.usage) {
        msg.usage = this.costOf(result.usage, model)
        emit({ type: 'usage', messageId: msg.id, usage: msg.usage })
      }
      emit({ type: 'message_done', message: msg })
      return msg
    }

    try {
      const settled = await Promise.allSettled([runOne(modelA), runOne(b)])
      for (const r of settled) {
        if (r.status === 'fulfilled') session.messages.push(r.value)
        else emit({ type: 'error', message: `Arena: ${(r.reason as Error).message}` })
      }
      saveSession(session)
    } finally {
      this.aborters.delete(session.id)
      emit({ type: 'turn_done', sessionId: session.id })
    }
  }

  // Distill a session into a reusable skill (~/.deepcode/skills/<slug>/SKILL.md):
  // the app learns repeatable procedures from real work.
  async distillSkill(session: Session, hint: string): Promise<{ name: string; path: string }> {
    const transcript = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        const calls = m.toolCalls?.length ? ` [tools: ${m.toolCalls.map((t) => t.name).join(', ')}]` : ''
        return `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}${calls}`
      })
      .join('\n\n')

    const aborter = new AbortController()
    const res = await this.client.streamChat(
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
      aborter.signal
    )
    const nameMatch = res.content.match(/NAME:\s*(.+)/)
    const descMatch = res.content.match(/DESCRIPTION:\s*(.+)/)
    const bodyMatch = res.content.match(/BODY:\s*\n([\s\S]+)/)
    if (!nameMatch || !bodyMatch) throw new Error('Distillation produced no usable skill format.')
    const slug = nameMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
    const { mkdirSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const { PATHS } = await import('../paths')
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

  // Run the project's verify command (quality gate). 3-minute cap, output tail.
  private runVerify(
    command: string,
    cwd: string,
    signal: AbortSignal
  ): Promise<{ ok: boolean; output: string }> {
    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : '/bin/bash'
    const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command]
    return new Promise((resolve) => {
      let out = ''
      const child = spawn(shell, args, { cwd, windowsHide: true })
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
      const onAbort = (): void => {
        child.kill('SIGKILL')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const append = (c: Buffer): void => {
        out += c.toString('utf8')
        if (out.length > 60_000) out = out.slice(-60_000)
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, output: `Verify konnte nicht starten: ${e.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve({ ok: code === 0, output: out.trim() || `(exit ${code})` })
      })
    })
  }

  private toolResultMessage(callId: string, name: string, res: ToolResult): ChatMessage {
    return {
      id: randomUUID(),
      role: 'tool',
      content: res.content.slice(0, 100_000),
      toolCallId: callId,
      toolName: name,
      createdAt: Date.now(),
      error: !res.ok,
      meta: res.meta
    }
  }

  // --- Nested subagent loop ---
  private async runSubagent(
    agentName: string,
    prompt: string,
    cwd: string,
    emit: Emit,
    signal: AbortSignal
  ): Promise<string> {
    const agent = getSubagent(agentName, cwd) ?? pluginSubagents().find((a) => a.name === agentName)
    const systemBase = buildSystemPrompt({
      cwd,
      skills: this.collectSkills(cwd),
      customInstructions: this.settings.customInstructions
    })
    const system = agent
      ? `${systemBase}\n\n# Subagent role: ${agent.name}\n${agent.systemPrompt}`
      : `${systemBase}\n\n# Subagent role: general-purpose assistant`

    emit({ type: 'status', message: `Subagent "${agentName}" started.` })

    const tools = this.buildTools(cwd, {
      includeTask: false,
      allow: agent?.tools ?? ['*']
    })
    // deepseek-reasoner does not support function calling — run it tool-less.
    const reasonerOnly = !!agent?.model && /reason/i.test(agent.model)
    const apiTools = reasonerOnly ? [] : toApiTools(tools)

    const ctx: ToolContext = {
      cwd,
      signal,
      confineToCwd: this.settings.confineToCwd,
      emitStatus: (m) => emit({ type: 'status', message: `[${agentName}] ${m}` })
    }

    const messages: ChatMessage[] = [
      { id: randomUUID(), role: 'user', content: prompt, createdAt: Date.now() }
    ]

    let finalText = ''
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) break
      const apiMessages = this.toApiMessages(system, messages)
      const assistantMsg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: Date.now()
      }
      const result = await this.client.streamChat(
        apiMessages,
        apiTools,
        {},
        signal,
        agent?.model
      )
      assistantMsg.content = result.content
      assistantMsg.toolCalls = result.toolCalls.map((tc) => ({
        id: tc.id || randomUUID(),
        name: tc.name,
        arguments: tc.arguments || '{}'
      }))
      assistantMsg.finishReason = result.finishReason
      if (result.usage) assistantMsg.usage = this.costOf(result.usage)
      messages.push(assistantMsg)
      finalText = result.content || finalText

      // If the response was truncated, don't execute possibly-incomplete tool calls.
      if (result.finishReason === 'length') break
      if (!assistantMsg.toolCalls.length) break

      for (const call of assistantMsg.toolCalls) {
        if (signal.aborted) break
        const tool = tools.find((t) => t.name === call.name)
        let res: ToolResult
        if (!tool) res = { ok: false, content: `Unknown tool: ${call.name}` }
        else {
          try {
            const args = call.arguments ? JSON.parse(call.arguments) : {}
            // subagents auto-approve within configured permissions; gated tools are skipped
            if (!this.autoApproved(tool)) {
              res = { ok: false, content: `Tool ${call.name} requires approval; not available to subagents in this mode.` }
            } else {
              res = await tool.execute(args, ctx)
            }
          } catch (e) {
            res = { ok: false, content: `Tool error: ${(e as Error).message}` }
          }
        }
        messages.push(this.toolResultMessage(call.id, call.name, res))
      }
    }

    emit({ type: 'status', message: `Subagent "${agentName}" finished.` })
    return finalText || '(subagent produced no text output)'
  }
}
