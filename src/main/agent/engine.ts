import { randomUUID } from 'crypto'
import { appendFileSync } from 'fs'
import { join, relative } from 'path'
import { AppSettings, ChatMessage, Session, ToolResult } from '@shared/types'
import { DeepSeekClient } from './deepseek'
import { Tool, toApiTools } from './tools'
import { ToolContext } from './tools/types'
import { buildSystemPrompt } from './prompt'
import { ApprovalPolicy, isDangerousCommand } from './policy'
import { toApiMessages, toolResultMessage } from './api-messages'
import { costOf, estimateTokens } from './pricing'
import { collectSkills, buildTools } from './toolset'
import { newAssistantMessage, streamCallbacksFor } from './streaming'
import { runVerify } from './verify'
import { EngineDeps, Emit } from './deps'
import { runSecondOpinion, runArena } from './variants'
import { compactSession } from './compact'
import { distillSkill } from './distill'
import { runSubagent } from './subagent'
import { loadHooks, runHooks } from '../systems/hooks'
import { pluginHooks } from '../systems/plugins'
import { recordErrorSolution } from '../systems/memory'
import { recordSnapshot, getTurnFiles } from '../checkpoints'
import { getProject } from '../projects'
import { saveSession } from '../store'

export type { ApprovalPolicy } from './policy'

const MAX_STEPS = 60
const MAX_QUALITY_ROUNDS = 4 // initial pass + self-review + 2 verify fixes

// The engine owns: per-session locking, tool approval, and the main turn loop.
// Everything else (variants, compaction, distillation, subagents, verify) lives
// in focused modules and receives capabilities via EngineDeps.
export class AgentEngine {
  private client: DeepSeekClient
  private sessionsStarted = new Set<string>()
  private pendingApprovals = new Map<string, (approved: boolean) => void>()
  private aborters = new Map<string, AbortController>()

  constructor(private settings: AppSettings) {
    this.client = new DeepSeekClient(settings.provider)
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings
    this.client.update(settings.provider)
  }

  // --- session locking -------------------------------------------------
  // One operation per session: prevents concurrent runTurn/arena/secondOpinion
  // on the same session (message interleaving + orphaned AbortControllers).
  private acquireSession = (sessionId: string): AbortController => {
    if (this.aborters.has(sessionId)) {
      throw new Error('Diese Session arbeitet gerade — bitte warten, bis der laufende Vorgang fertig ist.')
    }
    const aborter = new AbortController()
    this.aborters.set(sessionId, aborter)
    return aborter
  }

  private deps(): EngineDeps {
    return {
      client: this.client,
      settings: this.settings,
      acquire: this.acquireSession,
      release: (id) => this.aborters.delete(id),
      current: (id) => this.aborters.get(id)
    }
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

  // --- delegated operations --------------------------------------------
  estimateTokens(session: Session): number {
    return estimateTokens(session)
  }
  compactSession(session: Session, emit: Emit): Promise<Session> {
    return compactSession(this.deps(), session, emit)
  }
  secondOpinion(session: Session, emit: Emit): Promise<void> {
    return runSecondOpinion(this.deps(), session, emit)
  }
  arena(session: Session, emit: Emit, modelB?: string): Promise<void> {
    return runArena(this.deps(), session, emit, modelB)
  }
  distillSkill(session: Session, hint: string): Promise<{ name: string; path: string }> {
    return distillSkill(this.deps(), session, hint)
  }

  // --- approval ----------------------------------------------------------
  private autoApproved(permission: string): boolean {
    if (permission === 'none') return true
    if (permission === 'read') return this.settings.autoApprove.read
    if (permission === 'write') return this.settings.autoApprove.write
    if (permission === 'bash') return this.settings.autoApprove.bash
    return false
  }

  private requestApproval(emit: Emit, callId: string, name: string, args: string): Promise<boolean> {
    emit({ type: 'tool_pending', callId, name, args })
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(callId, resolve)
    })
  }

  // Resolve the approval gate for one tool call. Returns the denial message,
  // or null when the call may run.
  private async gateToolCall(
    tool: Tool,
    call: { id: string; name: string; arguments: string },
    parsedArgs: any,
    policy: ApprovalPolicy,
    emit: Emit
  ): Promise<string | null> {
    const dangerous = call.name === 'run_command' && isDangerousCommand(parsedArgs.command)
    const mutating = tool.permission === 'write' || tool.permission === 'bash'
    if (policy === 'plan' && mutating) {
      return `Plan mode: "${call.name}" was NOT executed. Describe this change as part of your plan instead.`
    }
    if (policy === 'full') return null
    if (this.autoApproved(tool.permission) && !dangerous) return null
    if (policy === 'safe') {
      return `Skipped "${call.name}" — not permitted in unattended (safe) mode.`
    }
    const approved = await this.requestApproval(emit, call.id, call.name, call.arguments)
    return approved ? null : 'Tool call was denied by the user.'
  }

  // --- main turn ----------------------------------------------------------
  async runTurn(
    session: Session,
    userText: string,
    emit: Emit,
    policy: ApprovalPolicy = 'interactive',
    images?: string[]
  ): Promise<void> {
    const aborter = this.acquireSession(session.id)
    const signal = aborter.signal

    try {
      const hooks = [...loadHooks(session.cwd), ...pluginHooks()]
      // SessionStart fires once per session lifetime (first turn)
      if (!this.sessionsStarted.has(session.id)) {
        this.sessionsStarted.add(session.id)
        await runHooks('SessionStart', { cwd: session.cwd }, hooks)
      }
      const injected = await runHooks('UserPromptSubmit', { prompt: userText, cwd: session.cwd }, hooks)

      session.messages.push({
        id: randomUUID(),
        role: 'user',
        content: injected ? `${userText}\n\n<hook-context>\n${injected}\n</hook-context>` : userText,
        createdAt: Date.now(),
        images: images?.length ? images : undefined
      })
      saveSession(session)

      // images present → run this turn on the vision model (auto-routing)
      const turnModel = images?.length ? this.settings.provider.visionModel : session.model

      if (this.settings.compactThreshold > 0 && estimateTokens(session) > this.settings.compactThreshold) {
        await this.compactSession(session, emit)
      }

      const project = session.projectId ? getProject(session.projectId) : null
      // Project trust level can relax or tighten the interactive default.
      if (policy === 'interactive' && project?.trustLevel === 'trusted') policy = 'full'
      if (policy !== 'plan' && project?.trustLevel === 'restricted') policy = 'safe'

      const system = buildSystemPrompt({
        cwd: session.cwd,
        skills: collectSkills(session.cwd),
        customInstructions: this.settings.customInstructions,
        project: project
          ? { name: project.name, instructions: project.instructions, goal: project.goal }
          : null,
        sessionGoal: session.goal,
        planMode: policy === 'plan'
      })

      const tools = buildTools(this.settings, session.cwd)
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
        spawnSubagent: (agent, prompt) =>
          runSubagent(this.deps(), (p) => this.autoApproved(p), agent, prompt, session.cwd, emit, signal)
      }

      // quality loop: agent works → optional self-review → optional verify
      // command with auto-fix feedback. Hard-capped at MAX_QUALITY_ROUNDS.
      let reviewDone = false
      let verifyAttempts = 0
      for (let round = 0; round < MAX_QUALITY_ROUNDS; round++) {
        await this.runSteps(session, system, tools, ctx, policy, emit, signal, hooks, turnModel)
        if (signal.aborted) break

        const feedback = await this.qualityFeedback(
          session,
          turnTag,
          project,
          policy,
          emit,
          signal,
          () => (reviewDone ? null : ((reviewDone = true), 'review')),
          // returns the attempt number (1-based) or null when exhausted
          () => (verifyAttempts < 2 ? ++verifyAttempts : null)
        )
        if (!feedback) break
        session.messages.push({ id: randomUUID(), role: 'user', content: feedback, createdAt: Date.now() })
        saveSession(session)
      }

      this.appendChangelog(session, project?.autoChangelog ?? false, turnTag, userText)
      await runHooks('Stop', { cwd: session.cwd }, hooks)
      emit({ type: 'turn_done', sessionId: session.id })
    } catch (e) {
      if ((e as Error).name === 'AbortError' || signal.aborted) {
        emit({ type: 'status', message: 'Turn cancelled.' })
      } else {
        emit({ type: 'error', message: (e as Error).message })
      }
      emit({ type: 'turn_done', sessionId: session.id })
    } finally {
      this.aborters.delete(session.id)
      saveSession(session)
    }
  }

  // One pass of the model/tool step loop (until the model stops calling tools).
  private async runSteps(
    session: Session,
    system: string,
    tools: Tool[],
    ctx: ToolContext,
    policy: ApprovalPolicy,
    emit: Emit,
    signal: AbortSignal,
    hooks: ReturnType<typeof loadHooks>,
    model?: string
  ): Promise<void> {
    const turnModel = model ?? session.model
    const apiTools = toApiTools(tools)
    // error memory: remember "failed command → working follow-up" pairs
    let lastFailedCmd: { program: string; errorHead: string } | null = null

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) break

      const assistantMsg = newAssistantMessage()
      emit({ type: 'message_start', message: assistantMsg })
      const result = await this.client.streamChat(
        toApiMessages(system, session.messages),
        apiTools,
        streamCallbacksFor(assistantMsg, emit),
        signal,
        turnModel
      )

      assistantMsg.toolCalls = result.toolCalls.map((tc) => ({
        id: tc.id || randomUUID(),
        name: tc.name,
        arguments: tc.arguments || '{}'
      }))
      assistantMsg.finishReason = result.finishReason
      if (result.usage) {
        assistantMsg.usage = costOf(this.settings.provider, result.usage, turnModel)
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
        return // no tools -> pass complete
      }

      for (const call of assistantMsg.toolCalls) {
        if (signal.aborted) break
        const res = await this.executeToolCall(call, tools, ctx, policy, emit, hooks, session.cwd, (s) => {
          lastFailedCmd = s(lastFailedCmd)
        })
        emit({ type: 'tool_result', callId: call.id, name: call.name, result: res })
        session.messages.push(toolResultMessage(call.id, call.name, res))
      }
      // one write per round instead of per tool result (sessions get big)
      saveSession(session)
    }
  }

  // Parse, gate, run hooks around, and execute a single tool call.
  private async executeToolCall(
    call: { id: string; name: string; arguments: string },
    tools: Tool[],
    ctx: ToolContext,
    policy: ApprovalPolicy,
    emit: Emit,
    hooks: ReturnType<typeof loadHooks>,
    cwd: string,
    errMem: (update: (s: { program: string; errorHead: string } | null) => { program: string; errorHead: string } | null) => void
  ): Promise<ToolResult> {
    const tool = tools.find((t) => t.name === call.name)
    if (!tool) return { ok: false, content: `Unknown tool: ${call.name}` }

    let parsedArgs: any = {}
    try {
      parsedArgs = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      return { ok: false, content: `Invalid JSON arguments: ${call.arguments}` }
    }

    const denial = await this.gateToolCall(tool, call, parsedArgs, policy, emit)
    if (denial) return { ok: false, content: denial }

    await runHooks('PreToolUse', { toolName: call.name, toolArgs: parsedArgs, cwd }, hooks)
    let res: ToolResult
    try {
      res = await tool.execute(parsedArgs, ctx)
    } catch (e) {
      res = { ok: false, content: `Tool threw: ${(e as Error).message}` }
    }
    await runHooks('PostToolUse', { toolName: call.name, toolArgs: parsedArgs, cwd }, hooks)

    // error memory: failed command followed by a working variant of the same
    // program → remember the fix for future sessions
    if (call.name === 'run_command' && typeof parsedArgs.command === 'string') {
      const program = parsedArgs.command.trim().split(/\s+/)[0] ?? ''
      errMem((last) => {
        if (!res.ok) {
          const errorHead =
            res.content.split('\n').find((l) => /error|fehler|exception|fatal/i.test(l)) ??
            res.content.split('\n')[0] ??
            ''
          return { program, errorHead: errorHead.trim() }
        }
        if (last && last.program === program && last.errorHead) {
          try {
            recordErrorSolution(last.errorHead, parsedArgs.command.trim())
          } catch {
            /* memory write must never break the loop */
          }
          return null
        }
        return last
      })
    }
    return res
  }

  // Decide whether another quality round is needed; returns the feedback prompt.
  private async qualityFeedback(
    session: Session,
    turnTag: string,
    project: ReturnType<typeof getProject>,
    policy: ApprovalPolicy,
    emit: Emit,
    signal: AbortSignal,
    takeReview: () => 'review' | null,
    takeVerifyAttempt: () => number | null
  ): Promise<string | null> {
    const changed = getTurnFiles(session.id, turnTag)
    if (!changed.length || policy === 'plan') return null

    if (this.settings.selfReview && takeReview()) {
      emit({ type: 'status', message: '🔍 Selbst-Review der Änderungen…' })
      return (
        'Selbst-Review: Prüfe die Dateien, die du in dieser Aufgabe geändert hast, kritisch auf Bugs, ' +
        'vergessene Anpassungen an Aufrufstellen, Importfehler und Verstöße gegen die Projektkonventionen. ' +
        'Behebe gefundene Probleme direkt. Wenn alles korrekt ist, antworte nur: "Review ok."'
      )
    }

    if (project?.verifyCommand) {
      emit({ type: 'status', message: `⚙ Verify: ${project.verifyCommand}` })
      const v = await runVerify(project.verifyCommand, session.cwd, signal)
      if (v.ok) {
        emit({ type: 'status', message: '✅ Verify bestanden.' })
        return null
      }
      const attempt = takeVerifyAttempt()
      if (attempt === null) {
        // final check after the last fix still fails — tell the user honestly
        emit({
          type: 'status',
          message: '❌ Verify weiterhin fehlgeschlagen (2 Fix-Versuche aufgebraucht) — bitte manuell prüfen.'
        })
        return null
      }
      emit({
        type: 'status',
        message: `❌ Verify fehlgeschlagen — automatischer Fix (Versuch ${attempt}/2)…`
      })
      return `Der Verify-Befehl \`${project.verifyCommand}\` ist nach deinen Änderungen fehlgeschlagen:\n\n\`\`\`\n${v.output.slice(-5000)}\n\`\`\`\n\nAnalysiere die Ursache und behebe sie.`
    }
    return null
  }

  // auto-changelog (opt-in per project): record what this turn changed
  private appendChangelog(session: Session, enabled: boolean, turnTag: string, userText: string): void {
    if (!enabled) return
    try {
      const changed = getTurnFiles(session.id, turnTag)
      if (!changed.length) return
      const rels = changed.map((p) => relative(session.cwd, p) || p)
      const entry =
        `\n## ${new Date().toLocaleString()} — ${userText.replace(/\s+/g, ' ').slice(0, 90)}\n` +
        rels.map((r) => `- ${r}`).join('\n') +
        '\n'
      appendFileSync(join(session.cwd, 'CHANGELOG-DEEPCODE.md'), entry, 'utf8')
    } catch {
      /* changelog must never break the turn */
    }
  }
}
