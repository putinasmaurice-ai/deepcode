import { randomUUID } from 'crypto'
import { appendFileSync } from 'fs'
import { join, relative } from 'path'
import { AgentEvent, AppSettings, ChatMessage, Session, TokenUsage, ToolResult, TraceStatus, WorkflowDef } from '@shared/types'
import { DeepSeekClient, ApiMessage } from './deepseek'
import { Tool, toApiTools } from './tools'
import { ToolContext } from './tools/types'
import { buildSystemPrompt } from './prompt'
import { ApprovalPolicy, isDangerousCommand, screenUnattendedCall } from './policy'
import { isCommandApproved, approveCommand } from '../approvals'
import { toApiMessages, toolResultMessage } from './api-messages'
import { costOf, estimateTokens } from './pricing'
import { collectSkills, buildTools } from './toolset'
import { newAssistantMessage, streamCallbacksFor } from './streaming'
import { EngineDeps, Emit } from './deps'
import { runSecondOpinion, runArena } from './variants'
import { compactSession } from './compact'
import { distillSkill, distillMemories } from './distill'
import { generateWorkflow } from '../workflows/generate'
import { loadSkillScenarios, runSkillScenarios } from '../systems/skill-test'
import type { SkillTestResult } from '@shared/skill-test'
import { runSubagent } from './subagent'
import { loadHooks, runHooks, runPreToolUseHooks } from '../systems/hooks'
import { pluginHooks } from '../systems/plugins'
import { recordErrorSolution } from '../systems/memory'
import { buildMemoryContext } from '../systems/memory-search'
import { recordSnapshot, getTurnFiles, getTurnSnapshots } from '../checkpoints'
import { getProject } from '../projects'
import { saveSessionSoon, flushSession } from '../store'
import { recordUsage, overDailyCap } from '../ledger'
import { recordTurnSample } from '../samples'
import { TraceRecorder } from './trace'
import { runStructuredVerify } from './verify-report'
import { focusFeedback } from '@shared/test-report'
import { detectTestFramework, proveRedFirst, isTestFile } from './verify-synth'
import { runSwarm, buildPlanPrompt, parseShards, formatSwarmReport, isGitRepo } from './swarm'
import { chooseVisionModel } from './vision-route'
import { gateDecision } from './gate-decision'
import { setSecret, isSecretNameValid } from '../workflows/secrets'

export type { ApprovalPolicy } from './policy'

const MAX_STEPS = 60
const MAX_QUALITY_ROUNDS = 4 // initial pass + self-review + 2 verify fixes
const SWARM_MAX_WORKERS = 6 // parallel swarm workers (runPool caps in-flight at 8 regardless)
const MAX_AUTO_CONTINUE = 2 // auto-resume a max-tokens-truncated text answer at most this often per turn

// First-party DeepSeek route (bare model id, no vendor prefix → api.deepseek.com). Its V3.2/V4
// thinking-mode REQUIRES reasoning_content replayed on tool-call turns (400 otherwise); hosted
// deepseek via deepinfra:/openrouter: ignores it, so reasoning replay is enabled ONLY on this route.
function firstPartyDeepSeek(model: string | undefined): boolean {
  if (!model) return true
  return !/^(local|google|deepinfra|openai|together|mimo|kilo|openrouter):/i.test(model) && /deepseek/i.test(model)
}
const SWARM_MAX_MS = 30 * 60_000 // absolute wall-clock ceiling for a whole swarm run
// swarm workers are pure code-editors in an isolated worktree (no deps installed, orchestrator
// commits) → only read/edit/search tools; NO shell/git/jobs/web/task/preview/mcp.
const SWARM_WORKER_TOOLS = ['read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir', 'glob', 'grep', 'semantic_search']

// Vision pre-extraction prompt: turn an image into precise text the (blind) coding model
// can act on. Emphasises verbatim text/code/errors over interpretation.
const DESCRIBE_PROMPT =
  'Du bist ein präzises Vision-Modul für einen Coding-Assistenten, der das Bild NICHT sehen kann. ' +
  'Beschreibe das/die Bild(er) vollständig, sachlich und strukturiert. Erfasse insbesondere: ' +
  'jeglichen sichtbaren Text, Code und Fehlermeldungen WÖRTLICH (inkl. Zeilen/Formatierung), ' +
  'UI-Elemente und ihren Zustand, Diagramme/Architektur, Tabellen, Layout und – falls relevant – Farben. ' +
  'Keine Interpretation und keine Lösung — nur eine genaue, neutrale Beschreibung des Inhalts.'

// The engine owns: per-session locking, tool approval, and the main turn loop.
// Everything else (variants, compaction, distillation, subagents, verify) lives
// in focused modules and receives capabilities via EngineDeps.
export class AgentEngine {
  private client: DeepSeekClient
  private sessionsStarted = new Set<string>()
  private pendingApprovals = new Map<string, (approved: boolean) => void>()
  // command + cwd behind each pending run_command approval, so "always allow" can
  // persist it scoped to the directory it was approved in
  private pendingCommand = new Map<string, { command: string; cwd: string }>()
  // open secure secret-entry prompts, keyed by callId. The settled VALUE goes straight to
  // setSecret in main — it is never carried in an event/tool-arg/transcript (see submitSecret).
  // settle() returns the OUTCOME ({ set, error? }) so the renderer's submitSecret IPC can learn
  // whether the store succeeded (the error text is a static constraint message — never the value).
  private pendingSecretRequests = new Map<string, (value: string | null) => { set: boolean; error?: string }>()
  private aborters = new Map<string, AbortController>()
  // cancels that arrived BEFORE a turn registered its aborter (e.g. a workflow cancelled
  // at the instant an agent node starts). acquireSession honours these so the race can't
  // let an already-cancelled turn run to completion.
  private pendingCancels = new Set<string>()
  private warnedReasonerNoTools = new Set<string>() // session ids already warned about reasoner-strips-tools
  // the live session object of each in-flight turn, so mid-turn edits (rename / cwd /
  // model) mutate the SAME object the turn will save — otherwise the turn's saveSession
  // overwrites the edit (last-writer-wins).
  private liveSessions = new Map<string, Session>()
  // per-session queue of mid-turn steering messages (injected at the next runSteps step boundary)
  private steerQueue = new Map<string, string[]>()
  // Lets the chat agent run a saved workflow by id-or-name and read back per-node results.
  // Wired by the IPC layer (which owns workflow store + executor deps); absent → the
  // run_workflow tool is simply not exposed to the agent.
  private workflowRunner?: (idOrName: string, input: string | undefined, cwd: string) => Promise<import('@shared/types').WorkflowRunResult>

  constructor(private settings: AppSettings) {
    this.client = new DeepSeekClient(settings.provider)
  }

  setWorkflowRunner(fn: (idOrName: string, input: string | undefined, cwd: string) => Promise<import('@shared/types').WorkflowRunResult>): void {
    this.workflowRunner = fn
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
    // a cancel that raced ahead of this registration still takes effect
    if (this.pendingCancels.delete(sessionId)) aborter.abort()
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

  // Apply a field edit (title/cwd/model) to a turn's live session object if one is
  // running, so the running turn persists the edit instead of clobbering it. Returns
  // the live session when a turn is in flight, else null (caller edits the disk copy).
  applyLiveEdit(id: string, patch: Partial<Session>): Session | null {
    const s = this.liveSessions.get(id)
    if (!s) return null
    Object.assign(s, patch)
    return s
  }

  // Mid-turn steering: text the user sends WHILE a turn is running. If a turn is in flight for this
  // session it's queued and injected as a user message at the next step boundary in runSteps — so
  // the agent course-corrects within the current turn instead of waiting for it to finish. Returns
  // true when accepted into a running turn; false if nothing is running (caller sends it normally).
  steer(id: string, text: string): boolean {
    if (!text.trim() || !this.liveSessions.has(id)) return false
    const q = this.steerQueue.get(id) ?? []
    q.push(text.trim())
    this.steerQueue.set(id, q)
    return true
  }

  approve(callId: string, approved: boolean, remember?: boolean): void {
    // "Immer erlauben": persist the exact command (scoped to its cwd) so it
    // auto-approves next time in the same project. Read before settle() clears it.
    if (approved && remember) {
      const meta = this.pendingCommand.get(callId)
      if (meta) approveCommand(meta.command, meta.cwd)
    }
    const settle = this.pendingApprovals.get(callId)
    if (settle) settle(approved) // settle() removes the abort listener + clears both maps
    else this.pendingCommand.delete(callId)
  }

  // --- secure secret entry ----------------------------------------------
  // Ask the user to enter a secret directly (renderer prompt). Mirrors requestApproval's
  // settle-once / abort→settle(null) structure. The submitted VALUE only ever travels
  // renderer→IPC submitSecret→setSecret here — it is NEVER emitted, returned to the LLM,
  // put in a tool arg, or logged. Resolves { set: true } only when a valid value was stored.
  // On a rejected (not cancelled) value it resolves { set: false, error } — the error is the
  // STATIC constraint message from setSecret (min length / no OS encryption), never the value —
  // so the agent can re-prompt with the real reason instead of treating it as a cancel.
  requestSecretInput(name: string, reason: string | undefined, signal: AbortSignal, emit: Emit): Promise<{ set: boolean; error?: string }> {
    const callId = randomUUID()
    // session-less prompt (like tool_pending / preview_error) — the renderer shows a secure
    // input field. No value is ever attached to this (or any) event.
    emit({ type: 'secret_request', callId, name, reason })
    return new Promise<{ set: boolean; error?: string }>((resolve) => {
      const onAbort = (): void => {
        settle(null)
      }
      // single settle path: detach the abort listener, drop the entry, and only setSecret
      // a non-null value for a valid name (else the prompt was cancelled / refused). Returns the
      // outcome so submitSecret can relay it to the renderer (NOT to the LLM via this resolve).
      const settle = (value: string | null): { set: boolean; error?: string } => {
        signal.removeEventListener('abort', onAbort)
        this.pendingSecretRequests.delete(callId)
        let result: { set: boolean; error?: string }
        if (value != null && isSecretNameValid(name)) {
          try {
            setSecret(name, value) // value goes ONLY to the encrypted store; never re-emitted
            result = { set: true }
          } catch (e) {
            // setSecret can reject (too short / encryption unavailable). The message is a static
            // constraint string with NO secret value, so it is safe to surface — but the VALUE
            // itself is never returned. Report it wasn't stored (and why) so the await can't hang.
            result = { set: false, error: (e as Error).message }
          }
        } else {
          result = { set: false } // genuine cancel/abort — no error reason
        }
        resolve(result)
        return result
      }
      if (signal.aborted) return void settle(null)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingSecretRequests.set(callId, settle)
    })
  }

  // Renderer's response to a secret_request. The value lands here and is forwarded by the
  // stored settle() straight into setSecret — it must never leave main again. Returns the store
  // OUTCOME ({ set, error? }) to the renderer so it can show a failure (error is a static
  // constraint message, never the value); a stale/unknown callId (turn already ended) → set:false.
  submitSecret(callId: string, value: string | null): { set: boolean; error?: string } {
    const settle = this.pendingSecretRequests.get(callId)
    return settle ? settle(value) : { set: false }
  }

  // recordIfPending: only the workflow agent path (fresh per-node uuid sessions, never
  // reused) opts in to remembering a cancel that arrived before the turn registered its
  // aborter. Foreground callers must NOT — otherwise pressing Esc while idle would leave a
  // pending cancel that instantly kills the user's NEXT message on that chat session.
  cancel(sessionId: string, recordIfPending = false): void {
    const aborter = this.aborters.get(sessionId)
    if (aborter) aborter.abort()
    else if (recordIfPending) this.pendingCancels.add(sessionId)
  }

  // Drop any pending cancel recorded for a session whose turn is already complete — stops
  // a throwaway workflow session id from leaking into pendingCancels forever when an abort
  // races in after the turn finished but before its listener was removed.
  clearPendingCancel(sessionId: string): void {
    this.pendingCancels.delete(sessionId)
  }

  // DeepSeek is blind — so when a message carries images, the configured vision model
  // DESCRIBES them first and the text model works from that description. ONLINE mode uses
  // Gemini (Google AI Studio); LOKAL uses the configured local vision model (Ollama).
  // Returns the description text, or null if it failed (the caller then proceeds text-only).
  private async describeImages(
    images: string[],
    signal: AbortSignal,
    emit: Emit,
    budget?: { usd: number; tokens: number } // per-turn budget: vision spend counts toward maxCostPerTurn
  ): Promise<string | null> {
    const p = this.settings.provider
    // pure routing decision (security-critical LOKAL→local: coercion lives in vision-route.ts and is
    // unit-tested there) — keeps the cloud-leak guard testable in isolation from the network.
    const { modelId, label, usedLocalFallback } = chooseVisionModel({
      visionMode: this.settings.visionMode,
      visionModel: p.visionModel,
      onlineVisionModel: p.onlineVisionModel,
      hasGoogleKey: !!(p.googleApiKey && p.googleApiKey.trim())
    })
    if (usedLocalFallback) {
      emit({ type: 'status', message: '👁 Kein Google-Key gesetzt — nutze lokales Vision-Modell. Trage den Key in den Settings ein für Gemini.' })
    }
    emit({ type: 'status', message: `👁 Analysiere ${images.length} Bild(er) mit ${label}…` })
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: DESCRIBE_PROMPT },
          ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
        ]
      }
    ]
    try {
      // no tools — the vision model only describes. Meter it through the ledger (costOf prices
      // google:/local: by the model id — local is free) so screenshot/attachment vision can't
      // run up invisible spend in an agent loop (e.g. repeated preview_probe screenshots).
      const res = await this.client.streamChat(messages, [], {}, signal, modelId)
      if (res.usage) {
        const usage = costOf(this.settings.provider, res.usage, modelId)
        recordUsage(usage)
        // count vision spend toward the per-turn cap the same way LLM rounds do, so an agent
        // loop (e.g. repeated preview_probe screenshots) can't bypass maxCostPerTurn.
        if (budget) {
          budget.usd += usage.cost
          budget.tokens += usage.totalTokens
        }
      }
      return res.content.trim() || null
    } catch (e) {
      if ((e as Error).name === 'AbortError' || signal.aborted) throw e
      emit({ type: 'status', message: `👁 Bildanalyse fehlgeschlagen (${label}): ${(e as Error).message}` })
      return null
    }
  }

  // Wrap an emit so every per-turn event carries its sessionId. The renderer uses
  // this to drop events from background sessions (night shift / automations) that
  // would otherwise bleed into whatever chat the user currently has open.
  private scoped(sessionId: string, emit: Emit): Emit {
    return (e) => emit('sessionId' in e && (e as { sessionId?: string }).sessionId ? e : ({ ...e, sessionId } as AgentEvent))
  }

  // public wrapper so the IPC layer can scope the emit it hands to chat builtins (/wf, /learn,
  // /remember, /compact) and to secondOpinion/arena — those run async LLM calls during which the
  // user may switch chats, and their (otherwise unscoped) events would bleed into the open chat.
  scopeEmit(sessionId: string, emit: Emit): Emit {
    return this.scoped(sessionId, emit)
  }

  // --- delegated operations --------------------------------------------
  estimateTokens(session: Session): number {
    return estimateTokens(session)
  }
  compactSession(session: Session, emit: Emit, onUsage?: (u: TokenUsage) => void): Promise<Session> {
    return compactSession(this.deps(), session, emit, onUsage)
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

  extractMemories(session: Session): Promise<string[]> {
    return distillMemories(this.deps(), session, session.projectId)
  }

  generateWorkflow(description: string, id: string, now: number): Promise<WorkflowDef> {
    return generateWorkflow(this.deps(), description, id, now)
  }

  // One-shot, tool-less completion that bills usage against the configured model — the same
  // pattern testSkill/generate.ts use, exposed so callers outside the engine (Mission Control's
  // plan generator) can run a single LLM round without reaching into the private client.
  // An optional signal makes the billed round abortable: Mission Control threads the overseer's
  // signal so a Stop pressed during plan-replan unwinds the in-flight round promptly instead of
  // after it returns. Omitted (testSkill etc.) → a fresh never-aborted signal, behaviour unchanged.
  async complete(system: string, user: string, signal?: AbortSignal): Promise<string> {
    const res = await this.client.streamChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      [],
      {},
      signal ?? new AbortController().signal
    )
    if (res.usage) recordUsage(costOf(this.settings.provider, res.usage, this.settings.provider.model))
    return res.content
  }

  // Validate a skill against its tests.json scenarios. Scenarios with a `mock` response run
  // offline/free; the rest run the skill body + prompt through the model (no tools).
  async testSkill(skillName: string, cwd?: string): Promise<{ found: boolean; results: SkillTestResult[] }> {
    const { found, scenarios, body } = loadSkillScenarios(skillName, cwd)
    if (!found) return { found: false, results: [] }
    const complete = async (system: string, prompt: string): Promise<string> => {
      const res = await this.client.streamChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        [],
        {},
        new AbortController().signal
      )
      if (res.usage) recordUsage(costOf(this.settings.provider, res.usage, this.settings.provider.model))
      return res.content
    }
    const results = await runSkillScenarios(body, scenarios, complete)
    return { found: true, results }
  }

  // --- approval ----------------------------------------------------------
  private autoApproved(permission: string): boolean {
    if (permission === 'none') return true
    if (permission === 'read') return this.settings.autoApprove.read
    if (permission === 'write') return this.settings.autoApprove.write
    if (permission === 'bash') return this.settings.autoApprove.bash
    return false
  }

  private requestApproval(
    emit: Emit,
    callId: string,
    name: string,
    args: string,
    signal: AbortSignal,
    command?: string,
    cwd?: string
  ): Promise<boolean> {
    if (command) this.pendingCommand.set(callId, { command, cwd: cwd ?? '' })
    emit({ type: 'tool_pending', callId, name, args })
    return new Promise<boolean>((resolve) => {
      // settle() is the single resolve path: it detaches the abort listener (so it
      // doesn't accumulate on the per-turn signal across many approvals) and clears
      // both maps. Cancelling the turn while this prompt is open resolves it denied,
      // so the promise (and the session lock) never leak.
      const onAbort = (): void => settle(false)
      const settle = (v: boolean): void => {
        signal.removeEventListener('abort', onAbort)
        this.pendingApprovals.delete(callId)
        this.pendingCommand.delete(callId)
        resolve(v)
      }
      if (signal.aborted) return settle(false)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingApprovals.set(callId, settle)
    })
  }

  // Resolve the approval gate for one tool call. Returns the denial message,
  // or null when the call may run.
  private async gateToolCall(
    tool: Tool,
    call: { id: string; name: string; arguments: string },
    parsedArgs: any,
    policy: ApprovalPolicy,
    emit: Emit,
    cwd: string,
    signal: AbortSignal,
    unattended = false
  ): Promise<string | null> {
    // Unattended (workflow agent node / cron): block high-blast-radius tools that can't be
    // approved because no user is present — mirrors the workflow tool-node gate, and also
    // stops the agent node from being an open door around it (MCP drop-table, claude_code,
    // delegating to a subagent via `task`, git push/PR). Read-only + file/safe-shell stay.
    // dangerous shell + MCP/claude_code/task + outward git (structured AND raw run_command) — one
    // shared screen, so it can't drift from the subagent loop's gate. Only when unattended.
    const unattendedBlock = unattended ? screenUnattendedCall(call.name, parsedArgs) : null
    const isCmd = call.name === 'run_command'
    // Screen both foreground and background shell commands for catastrophic patterns.
    const cmdArg =
      isCmd || call.name === 'run_background_command' ? (parsedArgs.command as unknown) : undefined
    const dangerous = typeof cmdArg === 'string' && isDangerousCommand(cmdArg)
    const isMcp = call.name.startsWith('mcp__')
    const mutating = tool.permission === 'write' || tool.permission === 'bash'
    // The pure decision tree (order + messages live in gate-decision.ts, unit-tested). We compute
    // the side-effectful inputs here and only ACT on the verdict below.
    const decision = gateDecision({
      policy,
      toolName: call.name,
      mutating,
      dangerous,
      isMcp,
      isCmd,
      unattendedBlock,
      autoApproved: this.autoApproved(tool.permission),
      commandApproved: isCmd && !dangerous && isCommandApproved(parsedArgs.command, cwd)
    })
    if (decision.kind === 'deny') return decision.reason
    if (decision.kind === 'allow') return null
    if (decision.kind === 'allowlist') {
      emit({ type: 'status', message: `Auto-erlaubt (Allowlist): ${String(parsedArgs.command).slice(0, 80)}` })
      return null
    }
    const approved = await this.requestApproval(
      emit,
      call.id,
      call.name,
      call.arguments,
      signal,
      isCmd && !dangerous ? parsedArgs.command : undefined,
      cwd
    )
    return approved ? null : 'Tool call was denied by the user.'
  }

  // --- main turn ----------------------------------------------------------
  async runTurn(
    session: Session,
    userText: string,
    rawEmit: Emit,
    policy: ApprovalPolicy = 'interactive',
    images?: string[],
    unattended = false,
    // restrict this turn to a specific tool allowlist (e.g. the workflow chat dock = workflow +
    // read + secret tools only, so its frictionless 'full' mode can't reach write_file/run_command/
    // web_request/git/MCP). Undefined = the full default toolset (the normal main-chat path).
    toolAllow?: string[]
  ): Promise<void> {
    const aborter = this.acquireSession(session.id)
    const signal = aborter.signal
    this.liveSessions.set(session.id, session) // expose for mid-turn edits
    // session-scoped emit: stamps sessionId so background turns don't bleed into
    // the foreground chat (see scoped()).
    const emit = this.scoped(session.id, rawEmit)
    // run-trace: outer-scoped so the finally can close it on every exit (ok/cancel/error)
    let trace: TraceRecorder | null = null
    let turnStatus: TraceStatus = 'ok'

    try {
      const hooks = [...loadHooks(session.cwd), ...pluginHooks()]
      // SessionStart fires once per session lifetime (first turn)
      if (!this.sessionsStarted.has(session.id)) {
        this.sessionsStarted.add(session.id)
        await runHooks('SessionStart', { cwd: session.cwd }, hooks)
      }
      const injected = await runHooks('UserPromptSubmit', { prompt: userText, cwd: session.cwd }, hooks)

      const userMsgId = randomUUID()
      session.messages.push({
        id: userMsgId,
        role: 'user',
        content: injected ? `${userText}\n\n<hook-context>\n${injected}\n</hook-context>` : userText,
        createdAt: Date.now(),
        images: images?.length ? images : undefined
      })
      saveSessionSoon(session)
      // let the renderer reconcile its optimistic 'local-' id with the real one,
      // so Regenerate/Edit work on a freshly-sent message (not just after reopen).
      emit({ type: 'user_message', sessionId: session.id, id: userMsgId })

      // the turn key: identical value keys the FS checkpoints (recordSnapshot below) AND, threaded
      // into the trace, lets Time Machine correlate this turn's reasoning to its file pre-images
      // EXACTLY. Created here (before the trace) so both share it; the ToolContext snapshot reuses it.
      const turnTag = String(Date.now())

      // open the run-trace now so a running turn shows up in the Trace panel immediately
      const tr = new TraceRecorder(
        {
          sessionId: session.id,
          title: userText,
          cwd: session.cwd,
          model: session.model || this.settings.provider.model,
          unattended,
          turnTag
        },
        { onUpdate: (t) => emit({ type: 'trace', sessionId: session.id, trace: t }) }
      )
      trace = tr

      // budget accumulates across this whole turn (all quality rounds + vision describes) so the
      // per-turn cap covers vision spend the same way it covers LLM rounds. Declared up here so
      // even the initial user-image describe below is metered against it.
      const budget = { usd: 0, tokens: 0 }

      // images present → the vision model (Gemini online / local) describes them, then the
      // text model works from that description. Persist the description on the message so a
      // reopen/regenerate keeps it (and the transcript thumbnails still render the image).
      if (images?.length) {
        const desc = await this.describeImages(images, signal, emit, budget)
        const msg = session.messages.find((m) => m.id === userMsgId)
        if (msg) {
          msg.imageDescription = desc ?? '[Bild konnte nicht analysiert werden — bitte beschreibe es kurz im Text.]'
          saveSessionSoon(session)
        }
      }

      if (this.settings.compactThreshold > 0 && estimateTokens(session) > this.settings.compactThreshold) {
        const cs = tr.begin('compact', 'Kontext verdichten')
        let cCost = 0
        let cTok = 0
        await this.compactSession(session, emit, (u) => {
          cCost += u.cost
          cTok += u.totalTokens
        })
        tr.end(cs, { status: 'ok', costUsd: cCost, tokens: cTok })
      }

      const project = session.projectId ? getProject(session.projectId) : null
      // Project trust level can relax or tighten the interactive default.
      if (policy === 'interactive' && project?.trustLevel === 'trusted') policy = 'full'
      if (policy !== 'plan' && project?.trustLevel === 'restricted') policy = 'safe'

      // project-scoped + semantically-narrowed memory for THIS turn (falls back to the full
      // index if embeddings are unavailable or the store is small). Never blocks the turn.
      let memoryText: string | undefined
      try {
        memoryText = await buildMemoryContext(userText, session.projectId, this.settings.provider, signal)
      } catch {
        /* fall back to the full index inside buildSystemPrompt */
      }

      const system = buildSystemPrompt({
        cwd: session.cwd,
        skills: collectSkills(session.cwd),
        customInstructions: this.settings.customInstructions,
        project: project
          ? { name: project.name, instructions: project.instructions, goal: project.goal }
          : null,
        sessionGoal: session.goal,
        planMode: policy === 'plan',
        memoryText
      })

      const tools = buildTools(this.settings, session.cwd, { projectId: session.projectId, allow: toolAllow })
      const ctx: ToolContext = {
        cwd: session.cwd,
        signal,
        confineToCwd: this.settings.confineToCwd,
        unattended,
        emitStatus: (m) => emit({ type: 'status', message: m }),
        snapshot: (absPath) => recordSnapshot(session.id, turnTag, absPath),
        // let the FOREGROUND chat agent build/run/iterate saved workflows: run one by id-or-name
        // and read back per-node results. Bound to this session's cwd; absent when no runner is
        // wired. NEVER wired under `unattended` (a workflow agent node / cron run): the IPC
        // workflowRunner always starts a FRESH top-level run (depth 0, new ancestors, new fan-out
        // counter), so exposing it there would let an agent node re-enter the executor and recurse
        // without bound, bypassing every guardedSub cycle/depth/child-run cap.
        runWorkflow: !unattended && this.workflowRunner ? (id, input) => this.workflowRunner!(id, input, session.cwd) : undefined,
        emitTodos: (todos) => {
          session.todos = todos
          saveSessionSoon(session)
          emit({ type: 'todos', sessionId: session.id, todos })
        },
        trace: tr,
        // preview_probe turns a screenshot (data URI) into text via the same vision pipeline;
        // pass budget so its vision spend counts toward the per-turn cap (can't bypass it).
        describeImage: (dataUri) => this.describeImages([dataUri], signal, emit, budget),
        // secure secret entry: a SECRET prompt needs a present user, so it's wired only when
        // NOT unattended (cron / workflow agent node have nobody to type the value) and NOT in
        // plan mode (read-only — must not write a secret to disk). The value never returns through
        // this path — only { set } does.
        requestSecret:
          !unattended && policy !== 'plan' ? (name, reason) => this.requestSecretInput(name, reason, signal, emit) : undefined,
        spawnSubagent: async (agentName, prompt) => {
          // nest the subagent under the tool span that spawned it (the 'task' tool);
          // bubble its summed cost/tokens onto the span via onUsage.
          const ss = tr.begin('subagent', agentName || 'subagent', tr.currentToolSpanId)
          let sc = 0
          let st = 0
          try {
            const text = await runSubagent(
              this.deps(),
              (p) => this.autoApproved(p),
              agentName,
              prompt,
              session.cwd,
              emit,
              signal,
              (u) => {
                sc += u.cost
                st += u.totalTokens
              }
            )
            // runSubagent returns normally even on abort (it breaks the loop, doesn't throw),
            // so check the signal here — otherwise a cancelled subagent shows ✅ in the trace.
            tr.end(ss, { status: signal.aborted ? 'cancelled' : 'ok', costUsd: sc, tokens: st })
            return text
          } catch (e) {
            tr.end(ss, {
              status: signal.aborted ? 'cancelled' : 'error',
              costUsd: sc,
              tokens: st,
              error: (e as Error).message
            })
            throw e
          }
        }
      }

      // quality loop: agent works → optional self-review → optional verify
      // command with auto-fix feedback. Hard-capped at MAX_QUALITY_ROUNDS.
      let reviewDone = false
      let verifyAttempts = 0
      const synthState = { requested: false, attempts: 0 } // "Beweisbare Änderungen" per-turn state
      const turnStart = Date.now()
      const cap = this.settings.maxCostPerTurn
      for (let round = 0; round < MAX_QUALITY_ROUNDS; round++) {
        const roundModel = session.model
        const roundSpan = tr.begin('round', `Runde ${round + 1}`)
        await this.runSteps(session, system, tools, ctx, policy, emit, signal, hooks, roundModel, budget, roundSpan)
        if (signal.aborted) {
          tr.end(roundSpan, { status: 'cancelled' })
          break
        }
        // budget breached inside runSteps → stop the whole turn (don't run more rounds)
        if (cap > 0 && budget.usd >= cap) {
          tr.end(roundSpan, { status: 'ok' })
          break
        }

        const feedback = await this.qualityFeedback(
          session,
          turnTag,
          project,
          policy,
          emit,
          signal,
          () => (reviewDone ? null : ((reviewDone = true), 'review')),
          // returns the attempt number (1-based) or null when exhausted
          () => (verifyAttempts < 2 ? ++verifyAttempts : null),
          tr,
          roundSpan,
          synthState
        )
        tr.end(roundSpan, { status: 'ok' })
        if (!feedback) break
        // tag the auto-generated quality feedback so the UI shows it as an automatic review, not a
        // human "You" message (the model still receives the full text — see toApiMessages).
        const autoKind = feedback.startsWith('Selbst-Review:')
          ? 'self-review'
          : feedback.startsWith('Der Verify-Befehl')
            ? 'verify-fix'
            : 'prove'
        session.messages.push({ id: randomUUID(), role: 'user', content: feedback, createdAt: Date.now(), auto: autoKind })
        saveSessionSoon(session)
      }

      // record this turn's outcome so the Crystal Ball can forecast future turns
      if (budget.tokens > 0) {
        recordTurnSample({
          cost: budget.usd,
          tokens: budget.tokens,
          durationMs: Date.now() - turnStart,
          model: session.model || this.settings.provider.model,
          at: Date.now()
        })
      }
      this.appendChangelog(session, project?.autoChangelog ?? false, turnTag, userText)
      await runHooks('Stop', { cwd: session.cwd }, hooks)
      emit({ type: 'turn_done', sessionId: session.id })
    } catch (e) {
      if ((e as Error).name === 'AbortError' || signal.aborted) {
        turnStatus = 'cancelled'
        emit({ type: 'status', message: 'Turn cancelled.' })
      } else {
        turnStatus = 'error'
        emit({ type: 'error', message: (e as Error).message })
      }
      emit({ type: 'turn_done', sessionId: session.id })
    } finally {
      // close the trace on EVERY path — a cancelled/errored turn still gets a complete tree
      trace?.finish(turnStatus)
      this.aborters.delete(session.id)
      this.liveSessions.delete(session.id)
      this.steerQueue.delete(session.id) // drop any un-consumed steering (turn is over)
      flushSession(session) // guaranteed end-of-turn persist (drains any debounced intra-turn writes)
    }
  }

  // Swarm mode: plan the task into independent shards, then run N subagents IN PARALLEL, each in
  // its own isolated git worktree+branch (edits can't collide), and report the branches. A
  // first-class path — NOT the unattended-blocked `task` tool. Returns a chat-ready report.
  async runSwarm(session: Session, task: string, rawEmit: Emit, signal: AbortSignal): Promise<string> {
    const emit = this.scoped(session.id, rawEmit)
    if (overDailyCap(this.settings.maxCostPerDay)) return '🐝 Tagesbudget erreicht — Schwarm übersprungen.'
    if (!(await isGitRepo(session.cwd, signal))) return '🐝 Schwarm-Modus braucht ein git-Repository (führe `git init` aus oder öffne ein Repo).'
    emit({ type: 'status', message: '🐝 Plane parallele Teilaufgaben…' })
    let shards
    try {
      const res = await this.client.streamChat(
        [{ role: 'user', content: buildPlanPrompt(task, SWARM_MAX_WORKERS) }],
        [],
        {},
        signal,
        this.settings.provider.model
      )
      if (res.usage) recordUsage(costOf(this.settings.provider, res.usage, this.settings.provider.model))
      shards = parseShards(res.content, SWARM_MAX_WORKERS)
    } catch (e) {
      if (signal.aborted) return '🐝 Abgebrochen.'
      return `🐝 Planung fehlgeschlagen: ${(e as Error).message}`
    }
    if (!shards.length) return '🐝 Konnte die Aufgabe nicht in parallele Teilaufgaben zerlegen — bitte konkreter formulieren.'
    emit({ type: 'status', message: `🐝 ${shards.length} Worker starten (parallel, isolierte git-Worktrees)…` })
    // swarm-local abort: fires on the parent signal (Stop/Escape) OR the 30-min ceiling — so the
    // ceiling ACTUALLY stops in-flight workers (runPool's deadline alone wouldn't abort them).
    const swarmAc = new AbortController()
    const onParentAbort = (): void => swarmAc.abort()
    signal.addEventListener('abort', onParentAbort, { once: true })
    if (signal.aborted) swarmAc.abort()
    const ceiling = setTimeout(() => swarmAc.abort(), SWARM_MAX_MS)
    try {
      const { workers, capped } = await runSwarm(shards, session.cwd, session.id, {
        runWorker: (prompt, cwd, onUsage) =>
          runSubagent(
            this.deps(),
            (p) => this.autoApproved(p),
            'general-purpose',
            prompt,
            cwd,
            emit,
            swarmAc.signal,
            (u) => onUsage({ cost: u.cost, totalTokens: u.totalTokens }),
            // worktrees have no node_modules and the orchestrator commits — workers are PURE
            // EDITORS: restrict to read/edit/search tools (no shell/git/build/network/etc), so a
            // worker can't run tests/git in a depless worktree or race siblings on the .git lock.
            SWARM_WORKER_TOOLS,
            // force confineToCwd — swarm workers are jailed to their worktree regardless of setting
            true
          ),
        emit,
        signal: swarmAc.signal,
        deadline: Date.now() + SWARM_MAX_MS,
        concurrency: SWARM_MAX_WORKERS,
        // a single run may not blow past the day's budget: the daily cap is checked only at START,
        // so bound the whole parallel run to it too (un-launched workers are skipped once hit).
        costCapUsd: this.settings.maxCostPerDay || undefined
      })
      return formatSwarmReport(workers, capped)
    } finally {
      clearTimeout(ceiling)
      signal.removeEventListener('abort', onParentAbort)
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
    model?: string,
    budget?: { usd: number; tokens: number },
    roundSpanId?: string // trace: parent span for this round's llm/tool spans
  ): Promise<void> {
    const baseModel = model ?? session.model
    const apiTools = toApiTools(tools)
    // Cost routing: the reasoner cannot drive the tool loop at all — deepseek.ts
    // strips tools for reasoner models, so a reasoner step returns text-only and ends
    // the pass. So when a reasoner is the session model and auto-routing is on, run the
    // WHOLE agentic loop on the cheap, tool-capable chat model. This both saves money
    // and makes a reasoner-as-session-model actually able to use tools.
    const reasonerM = this.settings.provider.reasonerModel
    const cheapM = this.settings.provider.model
    const route = this.settings.autoRouteModels && baseModel === reasonerM && !!cheapM && cheapM !== reasonerM
    const stepModel = route ? cheapM : baseModel
    // reasoner can't call tools (deepseek.ts strips them) → with auto-routing OFF, a reasoner
    // session silently loses ALL tools and ends each step text-only. Warn once per session.
    if (!route && baseModel === reasonerM && cheapM && cheapM !== reasonerM && apiTools.length > 0 && !this.warnedReasonerNoTools.has(session.id)) {
      this.warnedReasonerNoTools.add(session.id)
      emit({ type: 'status', message: '⚠ Das Reasoner-Modell kann keine Tools nutzen — aktiviere Auto-Routing (Settings) oder wähle das Chat-Modell für Aufgaben mit Tools.' })
    }
    const cap = this.settings.maxCostPerTurn
    // error memory: remember "failed command → working follow-up" pairs
    let lastFailedCmd: { program: string; errorHead: string } | null = null
    let autoContinues = 0 // how many times we've auto-resumed a max-tokens-truncated answer this turn

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) break

      // Mid-turn steering: messages the user sent while this turn was running are injected here —
      // BEFORE the next LLM round — as user messages, so the agent course-corrects at this step
      // instead of after the whole turn. (Renderer already showed them optimistically.)
      const steers = this.steerQueue.get(session.id)
      if (steers && steers.length) {
        this.steerQueue.set(session.id, [])
        const injectedIds: string[] = []
        for (const t of steers) {
          const id = randomUUID()
          session.messages.push({ id, role: 'user', content: t, createdAt: Date.now() })
          injectedIds.push(id)
        }
        // reconcile the renderer's optimistic 'local-' messages with the real ids (like a normal
        // send). Emit in REVERSE: the renderer always reconciles the LAST local- user message, so
        // the last-injected id must land first for multiple steers to map in the right order.
        for (let i = injectedIds.length - 1; i >= 0; i--) {
          emit({ type: 'user_message', sessionId: session.id, id: injectedIds[i] })
        }
        emit({ type: 'status', message: '⏩ Deine Eingabe wurde übernommen.' })
        saveSessionSoon(session)
      }

      const assistantMsg = newAssistantMessage()
      emit({ type: 'message_start', message: assistantMsg })
      const llmSpan = ctx.trace?.begin('llm', stepModel || 'model', roundSpanId)
      let result: Awaited<ReturnType<typeof this.client.streamChat>>
      try {
        result = await this.client.streamChat(
          toApiMessages(system, session.messages, { replayReasoning: firstPartyDeepSeek(stepModel) }),
          apiTools,
          streamCallbacksFor(assistantMsg, emit),
          signal,
          stepModel
        )
      } catch (e) {
        ctx.trace?.end(llmSpan, { status: signal.aborted ? 'cancelled' : 'error', error: (e as Error).message })
        throw e
      }

      assistantMsg.toolCalls = result.toolCalls.map((tc) => ({
        id: tc.id || randomUUID(),
        name: tc.name,
        arguments: tc.arguments || '{}'
      }))
      assistantMsg.finishReason = result.finishReason
      if (result.usage) {
        assistantMsg.usage = costOf(this.settings.provider, result.usage, stepModel)
        recordUsage(assistantMsg.usage)
        if (budget) {
          budget.usd += assistantMsg.usage.cost
          budget.tokens += assistantMsg.usage.totalTokens
        }
        emit({ type: 'usage', messageId: assistantMsg.id, usage: assistantMsg.usage })
      }
      // close the LLM span with its cost/tokens + a brief detail (finish reason / tool count)
      ctx.trace?.end(llmSpan, {
        status: 'ok',
        costUsd: assistantMsg.usage?.cost,
        tokens: assistantMsg.usage?.totalTokens,
        detail: assistantMsg.toolCalls.length
          ? `${assistantMsg.toolCalls.length} Tool-Call(s)`
          : result.finishReason || undefined
      })
      session.messages.push(assistantMsg)
      emit({ type: 'message_done', message: assistantMsg })
      saveSessionSoon(session)

      // Per-turn budget guard: stop spending once the cap is hit (pause, don't churn).
      if (cap > 0 && budget && budget.usd >= cap) {
        emit({
          type: 'status',
          message: `Budget-Limit ($${cap.toFixed(2)}) für diesen Turn erreicht — gestoppt. Erhöhe "Max-Kosten/Turn" in Settings oder sende "weiter".`
        })
        return
      }
      // Daily cap guard (unattended only): a single long workflow/cron turn must not blow
      // past maxCostPerDay mid-turn — re-check after each billed round (mirrors subagent.ts).
      if (ctx.unattended && overDailyCap(this.settings.maxCostPerDay)) {
        emit({ type: 'status', message: 'Tagesbudget erreicht — unbeaufsichtigter Lauf gestoppt.' })
        return
      }

      if (!assistantMsg.toolCalls.length) {
        if (result.finishReason === 'length') {
          // auto-resume a truncated text answer (capped) so it finishes on its own instead of
          // stopping mid-sentence. The nudge is hidden (not a visible "You" message); the model's
          // continuation arrives as the next assistant turn.
          if (autoContinues < MAX_AUTO_CONTINUE) {
            autoContinues++
            emit({
              type: 'status',
              message: `Antwort am Token-Limit abgeschnitten — setze automatisch fort (${autoContinues}/${MAX_AUTO_CONTINUE})…`
            })
            session.messages.push({
              id: randomUUID(),
              role: 'user',
              content: 'Fahre exakt dort fort, wo du aufgehört hast — nichts wiederholen, direkt weiterschreiben.',
              createdAt: Date.now(),
              hidden: true
            })
            saveSessionSoon(session)
            continue
          }
          emit({
            type: 'status',
            message:
              'Response was cut off at the max-tokens limit. Increase "Max tokens" in Settings for longer answers.'
          })
        } else if (result.finishReason === 'content_filter') {
          emit({ type: 'status', message: 'Antwort wurde vom Inhalts-Filter des Providers gestoppt.' })
        } else if (!assistantMsg.content.trim() && !assistantMsg.reasoning?.trim()) {
          // empty answer + no action that the stream-error guards didn't already throw on: a
          // provider hiccup — tell the user instead of ending the turn silently with a blank bubble.
          emit({
            type: 'status',
            message: 'Das Modell hat eine leere Antwort ohne Aktion geliefert — evtl. ein Provider-Problem. Bitte erneut versuchen oder das Modell wechseln.'
          })
        }
        return // no tools -> pass complete
      }

      for (const call of assistantMsg.toolCalls) {
        if (signal.aborted) break
        const res = await this.executeToolCall(call, tools, ctx, policy, emit, hooks, session.cwd, (s) => {
          lastFailedCmd = s(lastFailedCmd)
        }, roundSpanId)
        emit({ type: 'tool_result', callId: call.id, name: call.name, result: res })
        session.messages.push(toolResultMessage(call.id, call.name, res))
      }
      // one write per round instead of per tool result (sessions get big)
      saveSessionSoon(session)
    }
    // Exhausted the step budget without a tool-free answer — say so instead of
    // ending silently, so the user knows to continue (the agent isn't "stuck").
    if (!signal.aborted) {
      emit({
        type: 'status',
        message: `Step limit (${MAX_STEPS}) reached — work may be unfinished. Send "weiter" to continue.`
      })
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
    errMem: (update: (s: { program: string; errorHead: string } | null) => { program: string; errorHead: string } | null) => void,
    roundSpanId?: string // trace: parent (round) span for this tool span
  ): Promise<ToolResult> {
    const tool = tools.find((t) => t.name === call.name)
    if (!tool) {
      // record these error modes too — they cost a follow-up LLM round and an operator
      // auditing the trace wants to see them (no currentToolSpanId: nothing spawns under them).
      const es = ctx.trace?.begin('tool', call.name, roundSpanId, call.name)
      ctx.trace?.end(es, { status: 'error', error: `Unknown tool: ${call.name}` })
      return { ok: false, content: `Unknown tool: ${call.name}` }
    }

    let parsedArgs: any = {}
    try {
      parsedArgs = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      const es = ctx.trace?.begin('tool', call.name, roundSpanId, call.name)
      ctx.trace?.end(es, { status: 'error', error: `Invalid JSON arguments: ${call.arguments}` })
      return { ok: false, content: `Invalid JSON arguments: ${call.arguments}` }
    }

    // open a tool span; label it with the tool's own summary (never raw secrets/args). The
    // span is set as the "current tool" so a subagent spawned inside it nests beneath it.
    let label: string | undefined
    try {
      label = tool.summarize?.(parsedArgs)
    } catch {
      /* summarize must never break the call */
    }
    const toolSpan = ctx.trace?.begin('tool', call.name, roundSpanId, label || call.name)
    if (ctx.trace && toolSpan) ctx.trace.currentToolSpanId = toolSpan
    try {
      const denial = await this.gateToolCall(tool, call, parsedArgs, policy, emit, cwd, ctx.signal, ctx.unattended ?? false)
      if (denial) {
        ctx.trace?.end(toolSpan, { status: 'error', error: denial })
        return { ok: false, content: denial }
      }

      // A PreToolUse hook may VETO the call (exit non-zero / DEEPCODE_BLOCK token). When it
      // does, short-circuit: skip tool.execute and surface the reason like a denied approval.
      const gate = await runPreToolUseHooks({ toolName: call.name, toolArgs: parsedArgs, cwd }, hooks)
      if (gate.block) {
        const reason = gate.reason || 'Tool call was blocked by a PreToolUse hook.'
        ctx.trace?.end(toolSpan, { status: 'error', error: reason })
        return { ok: false, content: reason }
      }
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
      // a successful fs write tool returns a before→after diff in meta — surface it in the trace
      // so the Traces panel can show WHAT changed, not just that the tool ran (gate on ok so a
      // failed/rolled-back edit attaches nothing). Presence of meta.diff is the trigger, not the
      // tool name, so any future tool that produces a diff lights up for free.
      const m = res.meta as
        | { diff?: unknown; linesAdded?: unknown; linesRemoved?: unknown; path?: unknown }
        | undefined
      const added = typeof m?.linesAdded === 'number' ? m.linesAdded : 0
      const removed = typeof m?.linesRemoved === 'number' ? m.linesRemoved : 0
      // gate on a REAL line change, not the diff string length: lineDiff(x,x) on an identical
      // overwrite still emits context-only lines (added=removed=0), which would attach a useless
      // "+0/−0" toggle. Requiring added>0||removed>0 excludes exactly that no-op case.
      const hasDiff = res.ok && typeof m?.diff === 'string' && m.diff.length > 0 && (added > 0 || removed > 0)
      ctx.trace?.end(toolSpan, {
        status: res.ok ? 'ok' : ctx.signal.aborted ? 'cancelled' : 'error',
        error: res.ok ? undefined : res.content,
        diff: hasDiff ? (m!.diff as string) : undefined,
        diffAdded: hasDiff ? added : undefined,
        diffRemoved: hasDiff ? removed : undefined,
        diffPath: hasDiff && typeof m!.path === 'string' ? (m!.path as string) : undefined
      })
      return res
    } finally {
      if (ctx.trace) ctx.trace.currentToolSpanId = undefined
    }
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
    takeVerifyAttempt: () => number | null,
    trace?: TraceRecorder,
    roundSpanId?: string,
    synth?: { requested: boolean; attempts: number }
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
      const vs = trace?.begin('verify', `Verify: ${project.verifyCommand}`, roundSpanId)
      const v = await runStructuredVerify(project.verifyCommand, session.cwd, signal)
      trace?.end(vs, {
        status: v.ok ? 'ok' : 'error',
        detail: v.report ? `${v.report.passed}/${v.report.total} grün` : undefined,
        error: v.ok ? undefined : v.report ? `${v.report.failures.length} Test(s) rot` : 'Verify-Befehl fehlgeschlagen'
      })
      if (v.ok) {
        emit({ type: 'status', message: '✅ Verify bestanden.' })
        return null
      }
      const attempt = takeVerifyAttempt()
      if (attempt === null) {
        emit({ type: 'status', message: '❌ Verify weiterhin fehlgeschlagen (2 Fix-Versuche aufgebraucht) — bitte manuell prüfen.' })
        return null
      }
      // focused per-test feedback when a JSON report parsed; else the raw tail (backward compatible)
      const detail =
        v.report && v.report.failures.length ? focusFeedback(v.report) : `\`\`\`\n${v.output.slice(-5000)}\n\`\`\``
      emit({ type: 'status', message: `❌ Verify fehlgeschlagen — automatischer Fix (Versuch ${attempt}/2)…` })
      return `Der Verify-Befehl \`${project.verifyCommand}\` ist fehlgeschlagen:\n\n${detail}\n\nAnalysiere die Ursache und behebe sie.`
    }

    // No verifyCommand: optional "Beweisbare Änderungen" — synthesize a test and prove it
    // red-first (fails on the reverted code, passes on the new). Bounded; opt-in.
    if (this.settings.proveChanges && synth) {
      // an unattended run (workflow agent / cron / night shift) must respect the daily cap here
      // too — proveChanges adds an LLM round + test runs that the in-runTurn loop wouldn't catch.
      if (overDailyCap(this.settings.maxCostPerDay)) return null
      const fw = detectTestFramework(session.cwd)
      if (!fw) return null // unknown framework → can't synthesize
      const snaps = getTurnSnapshots(session.id, turnTag)
      // prefer a test the turn CREATED (snapshot.existed===false) over a pre-existing edited test,
      // so the proof targets the synthesized test, not an unrelated one.
      const testFile =
        snaps.find((s) => !s.existed && isTestFile(s.path))?.path ?? changed.find(isTestFile)
      if (!testFile) {
        if (synth.requested) return null // already asked once and no test appeared → give up
        synth.requested = true
        emit({ type: 'status', message: `🧪 Beweis: schreibe einen Test (${fw.name})…` })
        return (
          `Beweise deine Änderung mit einem Test (Framework: ${fw.name}). Schreibe einen FOKUSSIERTEN Test ` +
          `${fw.testGlobHint}, der GENAU das neue/geänderte Verhalten prüft (kein trivialer Test). ` +
          `Schreibe nur den Test — ich führe ihn danach automatisch aus.`
        )
      }
      if (synth.attempts >= 2) return null // bounded
      synth.attempts++
      const sp = trace?.begin('verify', `Beweis (${fw.name})`, roundSpanId)
      emit({ type: 'status', message: '🧪 Prüfe Test rot→grün…' })
      let res: Awaited<ReturnType<typeof proveRedFirst>>
      try {
        res = await proveRedFirst(testFile, snaps, fw.runFile(testFile), session.cwd, signal, this.settings.confineToCwd)
      } catch (e) {
        trace?.end(sp, { status: 'error', error: (e as Error).message })
        // a restore failure is data-safety-critical — surface it LOUDLY, not as a quiet status
        emit({ type: 'error', message: `Beweis-Schritt: ${(e as Error).message}` })
        return null
      }
      if (res.incomplete) {
        // a changed file couldn't be reverted (>5MB/binary) → can't prove red-first; accept the
        // test without a false "non-discriminating" rejection.
        trace?.end(sp, { status: 'ok', detail: 'Beweis übersprungen (große/binäre Änderung)' })
        emit({ type: 'status', message: '🧪 Beweis übersprungen — eine große/binäre Datei wurde geändert und ließ sich nicht zuverlässig zurücksetzen.' })
        return null
      }
      if (!res.discriminates) {
        trace?.end(sp, { status: 'error', error: 'Test nicht aussagekräftig (grün gegen alten Code)' })
        emit({ type: 'status', message: '🧪 Test bestand auch gegen den alten Code — nicht aussagekräftig.' })
        return `Dein Test \`${testFile}\` besteht AUCH gegen den alten Code — er prüft die Änderung also nicht. Schreibe ihn so um, dass er das KONKRETE neue Verhalten prüft (gegen den alten Code fehlschlagen würde).`
      }
      if (!res.green) {
        trace?.end(sp, { status: 'error', error: 'Test rot gegen aktuellen Code' })
        emit({ type: 'status', message: '🧪 Test schlägt fehl — behebe den Code…' })
        return `Dein Test \`${testFile}\` schlägt gegen den aktuellen Code fehl:\n\n\`\`\`\n${res.output.slice(-2000)}\n\`\`\`\n\nBehebe die Ursache, bis der Test grün ist.`
      }
      trace?.end(sp, { status: 'ok' })
      emit({ type: 'status', message: '✅ Bewiesen: Test schlägt gegen alten Code fehl und besteht gegen neuen.' })
      return null
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
