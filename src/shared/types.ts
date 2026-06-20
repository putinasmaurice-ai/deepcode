// Shared type definitions used by both the Electron main process and the renderer.

// Minimum length for a stored secret. Shared so the renderer's secret prompt can guard the
// value BEFORE submitting and the main-side setSecret can enforce the same rule (values shorter
// than this cannot be reliably masked out of logs/runs — see workflows/secrets.ts).
export const MIN_SECRET_LEN = 8

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  arguments: string // raw JSON string as returned by the model
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  // prompt tokens served from DeepSeek's context cache (billed far cheaper)
  cachedPromptTokens?: number
  cost: number // estimated, in USD
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  // assistant tool calls (if any)
  toolCalls?: ToolCall[]
  // for role === 'tool': which call this responds to
  toolCallId?: string
  toolName?: string
  // UI/metadata
  createdAt: number
  reasoning?: string // deepseek-reasoner chain-of-thought
  hidden?: boolean // not shown in transcript (e.g. injected context)
  error?: boolean
  usage?: TokenUsage // token usage for this assistant turn
  finishReason?: string // 'stop' | 'length' | 'tool_calls' | ...
  meta?: Record<string, unknown> // tool result metadata (diff, paths, counts…)
  variant?: 'second-opinion' | 'arena' // alternative/parallel answers
  variantModel?: string
  images?: string[] // attached images as data URIs (for vision models)
  // textual description of the attached image(s), produced by the vision model
  // (Gemini online / local) before the turn — this is what the text model (DeepSeek)
  // actually reads, since it can't see images itself.
  imageDescription?: string
}

export interface ProjectDef {
  id: string
  name: string
  cwd: string
  // always-on instructions for every session in this project
  instructions?: string
  // the active goal (set via /goal) — injected into the system prompt
  goal?: string
  goalSetAt?: number
  color?: string // accent dot in the sidebar
  // trusted = auto-approve everything in this project; restricted = read-only unattended
  trustLevel?: 'interactive' | 'trusted' | 'restricted'
  // append a CHANGELOG-DEEPCODE.md entry after every turn that changed files
  autoChangelog?: boolean
  // quality gate: command run after every turn that changed files (e.g. "npm test");
  // on failure the output is fed back and the agent fixes it automatically
  verifyCommand?: string
  createdAt: number
  updatedAt: number
}

export interface NightTask {
  id: string
  prompt: string
  cwd: string
  projectId?: string
  status: 'pending' | 'running' | 'done' | 'failed'
  summary?: string
  tokens?: number
  cost?: number
}

export interface NightShiftState {
  tasks: NightTask[]
  running: boolean
  autonomy: 'safe' | 'full'
  // wait for DeepSeek's off-peak window (UTC 16:30–00:30, up to 75% cheaper)
  waitForOffPeak?: boolean
  lastReportPath?: string
  lastRunAt?: number
}

// ---- Mission Control (autonomous outer loop) ----
// A mission breaks the per-turn MAX_STEPS ceiling by making the OUTER loop a persisted plan:
// each task is its own agent turn, machine-verified, and auto-committed on pass. V2 turns the
// plan into a branching DAG (task.deps) the overseer runs by readiness (topological), with a
// bounded REPLAN loop on exhaustion + per-milestone branch pointers — see overseer.ts.
export interface MissionTask {
  id: string
  title: string
  instruction: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  commit?: string // short HEAD hash recorded after a verified task is committed
  summary?: string
  tokens?: number
  cost?: number
  // V2 DAG: ids of prerequisite tasks that must be 'done' before this one is READY to run. The
  // overseer runs a ready task (all deps done) instead of strict array order. A cycle or a dep on
  // a missing id fails the mission CLOSED before anything runs.
  deps?: string[]
  // V2 per-milestone branch: the lightweight branch pointer created at this task's verified commit
  // (e.g. mission/<id>/m2-add-tests). Set from what the commit dep returns; LOCAL only, reviewable.
  branch?: string
  // V2 provenance: 'task' = part of the original plan, 'remediation' = inserted by a replan to
  // unblock a failed task. Distinguishes the morning-report stack + caps replan growth.
  kind?: 'task' | 'remediation'
}

export interface Mission {
  id: string
  goal: string
  cwd: string
  projectId?: string
  // machine verify gate — the ONLY thing that decides a task is 'done' (never the LLM's say-so)
  verifyCommand: string
  branch?: string
  // V2 adds 'scheduled': a mission queued for the overnight operator (MissionScheduler) to auto-start
  // inside its off-peak window / cron minute.
  status: 'planning' | 'ready' | 'running' | 'done' | 'failed' | 'stopped' | 'scheduled'
  tasks: MissionTask[]
  // wait for DeepSeek's off-peak window before running (like night shift)
  waitForOffPeak?: boolean
  // V2 REPLAN budget: when a task exhausts its retries the overseer may ask deps.replan() for
  // remediation tasks instead of halting. Bounded by maxReplans (default 2) + a hard cap on total
  // tasks added; a replan that returns nothing / makes no progress HALTS loudly.
  maxReplans?: number
  replansUsed?: number
  // V2 OVERNIGHT OPERATOR: when set, the MissionScheduler auto-starts this mission. offpeak = inside
  // DeepSeek's discount window; cron = on the given cron minute. Honors daily-cap + clean-tree +
  // one-mission-at-a-time, same as a manual start.
  schedule?: { mode: 'offpeak' | 'cron'; cron?: string }
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  reportPath?: string
}

export interface ProjectHealth {
  cwd: string
  files: number
  lines: number
  oversized: { path: string; lines: number }[] // files over 250 lines
  todos: number
  hasTests: boolean
  gitBranch: string | null
  gitDirty: number
  lastCommitAge: string | null
}

export interface TodoItem {
  text: string
  status: 'open' | 'doing' | 'done'
}

export interface Session {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  model?: string
  projectId?: string
  goal?: string // session-level goal when no project is assigned
  todos?: TodoItem[] // agent task list (todo_write tool)
}

export interface UsageSummary {
  total: { tokens: number; cost: number; sessions: number }
  month: { tokens: number; cost: number } // current calendar month
  perProject: {
    projectId: string
    name: string
    tokens: number
    cost: number
    sessions: number
  }[]
  perSession: {
    id: string
    title: string
    projectId?: string
    tokens: number
    cost: number
    updatedAt: number
  }[]
}

export interface ProviderSettings {
  apiKey: string
  baseUrl: string
  model: string
  reasonerModel: string
  temperature: number
  maxTokens: number
  // pricing for cost estimation (USD per 1M tokens)
  pricePerMillionInput: number
  pricePerMillionOutput: number
  // separate reasoner pricing (deepseek-reasoner costs more than chat)
  reasonerPricePerMillionInput: number
  reasonerPricePerMillionOutput: number
  // cheaper input price for prompt-cache HITS (DeepSeek bills cached prefix tokens
  // at a fraction of the miss price). Falls back to the miss price if 0/unset.
  cachedPricePerMillionInput?: number
  reasonerCachedPricePerMillionInput?: number
  // OpenAI-compatible endpoint for LOCAL models (Ollama/LM Studio).
  // Models prefixed "local:" are routed here, keyless and free.
  localBaseUrl: string
  // model the 🔓 Uncensored toggle switches to (a local, unaligned model)
  uncensoredModel: string
  // LOCAL vision-capable model used for image understanding in LOKAL mode (Ollama)
  visionModel: string
  // local embedding model for semantic_search (free/offline; e.g. nomic-embed-text)
  embeddingModel: string
  // ---- online vision (Google AI Studio / Gemini) ----
  // separate API key for Google AI Studio (Gemini). Stored encrypted like apiKey.
  googleApiKey: string
  // Google's OpenAI-compatible base URL (Gemini speaks the same /chat/completions)
  googleBaseUrl: string
  // online vision model used in ONLINE mode (e.g. gemini-2.5-flash-lite)
  onlineVisionModel: string
  // ---- DeepInfra (OpenAI-compatible) — models prefixed "deepinfra:" route here ----
  deepinfraApiKey: string
  deepinfraBaseUrl: string
  // extra model ids offered in the model picker (already prefixed, e.g. "deepinfra:owner/Model")
  extraModels: string[]
  // ---- OpenAI (OpenAI-compatible) — models prefixed "openai:" route here ----
  openaiApiKey: string
  openaiBaseUrl: string
  // ---- per-vendor pricing (USD per 1M tokens) for NON-DeepSeek routes ----
  // costOf must not bill google:/deepinfra:/openai: models with DeepSeek's price card. Flat (no
  // reasoner/cache split, no off-peak). Optional → costOf falls back to a built-in default.
  deepinfraPricePerMillionInput?: number
  deepinfraPricePerMillionOutput?: number
  googlePricePerMillionInput?: number
  googlePricePerMillionOutput?: number
  openaiPricePerMillionInput?: number
  openaiPricePerMillionOutput?: number
  // ---- Together AI (OpenAI-compatible) — models prefixed "together:" route here ----
  togetherApiKey: string
  togetherBaseUrl: string
  togetherPricePerMillionInput?: number
  togetherPricePerMillionOutput?: number
  // ---- Xiaomi MiMo (OpenAI-compatible) — models prefixed "mimo:" route here ----
  mimoApiKey: string
  mimoBaseUrl: string
  mimoPricePerMillionInput?: number
  mimoPricePerMillionOutput?: number
  // ---- Kilo Code gateway (OpenAI-compatible) — models prefixed "kilo:" route here ----
  kiloApiKey: string
  kiloBaseUrl: string
  kiloPricePerMillionInput?: number
  kiloPricePerMillionOutput?: number
}

export interface AppSettings {
  provider: ProviderSettings
  // auto-approve tool categories instead of prompting
  autoApprove: {
    read: boolean
    write: boolean
    bash: boolean
  }
  // default working directory for new sessions
  defaultCwd: string
  // global instructions appended to every system prompt
  customInstructions: string
  // restrict file tools to the working directory (block ../ escapes & absolute paths outside cwd)
  confineToCwd: boolean
  // auto-compact a session once its estimated tokens exceed this (0 = off)
  compactThreshold: number
  // monthly cost budget in USD (0 = off); the usage panel warns when exceeded
  monthlyBudget: number
  theme: 'dark' | 'light'
  // how attached images are understood: 'online' = Gemini (Google AI Studio),
  // 'local' = the configured local vision model (Ollama). Either way the vision model
  // only DESCRIBES the image; the text model (DeepSeek) does the actual work.
  visionMode: 'online' | 'local'
  // notify when project files change outside the agent (editor saves, git)
  watcherEnabled: boolean
  // after a turn that changed files, run one extra self-review pass (≈2x tokens)
  selfReview: boolean
  // "Beweisbare Änderungen": when a turn changed files and the project has NO verifyCommand,
  // synthesize a focused test and prove it RED-FIRST (fails on old code, passes on new). Opt-in;
  // costs an extra LLM round + a couple of test runs per turn.
  proveChanges: boolean
  // automatically distil durable facts into memory at each compaction (opt-in; /remember
  // does it on demand regardless). Costs one extra cheap LLM call per compaction.
  autoMemory: boolean
  // route mechanical agent steps to the cheap chat model and reserve the reasoner
  // for planning/debugging — cuts cost when the session model is the reasoner.
  autoRouteModels: boolean
  // hard cost ceiling per turn in USD (0 = off); the loop pauses when exceeded.
  maxCostPerTurn: number
  // daily spend ceiling in USD (0 = off). When today's recorded spend reaches it, UNATTENDED runs
  // (cron workflows, automations, night shift) are skipped so a runaway loop can't burn money.
  maxCostPerDay: number
  // optional: let the agent call the Claude Code CLI as a helper tool. DeepSeek
  // stays the orchestrator; Claude costs are billed to the user's Anthropic account.
  claudeCode: {
    enabled: boolean
    path: string // binary, default 'claude'
    permissionMode: 'plan' | 'acceptEdits' // ceiling; 'plan' = read-only
    model: string // claude alias/id; '' = default
    maxBudgetUsd: number // 0 = no cap
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    reasonerModel: 'deepseek-reasoner',
    temperature: 0.1, // DeepSeek empfiehlt für Coding niedrige Temperatur
    maxTokens: 16384, // DeepSeek erlaubt bis 8K Output je Antwort; höheres Cap lässt der Server selbst clampen, verhindert aber unnötig kurze Antworten
    pricePerMillionInput: 0.27,
    pricePerMillionOutput: 1.1,
    reasonerPricePerMillionInput: 0.55,
    reasonerPricePerMillionOutput: 2.19,
    cachedPricePerMillionInput: 0.07, // DeepSeek chat cache-hit input price
    reasonerCachedPricePerMillionInput: 0.14, // reasoner cache-hit input price
    localBaseUrl: 'http://localhost:11434/v1',
    uncensoredModel: 'local:dolphin3',
    visionModel: 'local:qwen2.5vl:7b',
    embeddingModel: 'nomic-embed-text',
    googleApiKey: '',
    googleBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    onlineVisionModel: 'gemini-2.5-flash-lite',
    deepinfraApiKey: '',
    deepinfraBaseUrl: 'https://api.deepinfra.com/v1/openai',
    extraModels: [
      'deepinfra:deepseek-ai/DeepSeek-V4-Flash', // cheaper DeepSeek via DeepInfra
      'deepinfra:openai/gpt-oss-120b',
      'deepinfra:Qwen/Qwen3-VL-235B-A22B-Instruct', // vision-language
      'together:meta-llama/Llama-4-Scout-17B-16E-Instruct', // Vision + 10M Kontext (braucht ein dediziertes Together-Endpoint)
      'together:meta-llama/Llama-3.3-70B-Instruct-Turbo', // serverless auf Together sofort nutzbar
      'mimo:mimo-v2.5-pro', // Xiaomi MiMo (Token-Plan, kostenlose Credits)
      'mimo:mimo-v2.5',
      'kilo:kilo/auto', // Kilo Code gateway — Smart-Routing (Modell-IDs im Kilo-Dashboard)
      'kilo:anthropic/claude-sonnet-4'
    ],
    openaiApiKey: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    // rough per-vendor defaults (editable) — better than billing them with DeepSeek's card
    deepinfraPricePerMillionInput: 0.3,
    deepinfraPricePerMillionOutput: 0.5,
    googlePricePerMillionInput: 0.1, // ~Gemini Flash-Lite
    googlePricePerMillionOutput: 0.4,
    openaiPricePerMillionInput: 0.5, // editable; varies widely by OpenAI model
    openaiPricePerMillionOutput: 1.5,
    togetherApiKey: '',
    togetherBaseUrl: 'https://api.together.xyz/v1',
    togetherPricePerMillionInput: 0.18, // Llama-4-Scout (editierbar; je Modell unterschiedlich)
    togetherPricePerMillionOutput: 0.59,
    mimoApiKey: '',
    mimoBaseUrl: 'https://token-plan-ams.xiaomimimo.com/v1',
    mimoPricePerMillionInput: 0, // Token-Plan: kostenlose Credits (editierbar, falls bezahlt)
    mimoPricePerMillionOutput: 0,
    kiloApiKey: '',
    kiloBaseUrl: 'https://api.kilo.ai/api/gateway',
    kiloPricePerMillionInput: 0, // routet zu versch. Modellen — pro Modell setzen, falls bezahlt
    kiloPricePerMillionOutput: 0
  },
  autoApprove: {
    read: true,
    write: false,
    bash: false
  },
  defaultCwd: '',
  customInstructions: '',
  confineToCwd: true,
  compactThreshold: 100_000, // auto-compact long sessions (large token saver)
  monthlyBudget: 0,
  theme: 'dark',
  visionMode: 'online', // default to Gemini; falls back to local if no Google key is set
  watcherEnabled: false,
  selfReview: false,
  proveChanges: false,
  autoMemory: false,
  autoRouteModels: true,
  maxCostPerTurn: 0,
  maxCostPerDay: 0,
  claudeCode: {
    enabled: false,
    path: 'claude',
    permissionMode: 'plan',
    model: '',
    maxBudgetUsd: 0
  }
}

// ---- Tool plumbing ----

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON schema
  // permission category that gates execution
  permission: 'read' | 'write' | 'bash' | 'none'
}

export interface ToolResult {
  ok: boolean
  content: string
  // structured payload for rich UI (diffs, file lists, etc.)
  meta?: Record<string, unknown>
}

// ---- Streaming events main -> renderer ----

// sessionId is stamped on every per-turn event by the engine so the renderer can
// ignore events from background sessions (night shift / automations) that would
// otherwise bleed into the currently-open chat.
export type AgentEvent =
  | { type: 'session'; session: Session }
  | { type: 'user_message'; sessionId: string; id: string } // reconcile optimistic local- id with the persisted server id
  | { type: 'message_start'; sessionId?: string; message: ChatMessage }
  | { type: 'reasoning_delta'; sessionId?: string; messageId: string; delta: string }
  | { type: 'content_delta'; sessionId?: string; messageId: string; delta: string }
  | { type: 'tool_call'; sessionId?: string; messageId: string; toolCall: ToolCall }
  | { type: 'tool_pending'; sessionId?: string; callId: string; name: string; args: string }
  // the agent asks the user to securely enter a secret (e.g. SMTP_PASS). Session-less like the
  // other UI prompts; the VALUE is NEVER sent back through an event — it travels renderer→IPC
  // submitSecret→setSecret only, so it can't enter the transcript / LLM / trace / logs.
  | { type: 'secret_request'; sessionId?: string; callId: string; name: string; reason?: string }
  | { type: 'tool_result'; sessionId?: string; callId: string; name: string; result: ToolResult }
  | { type: 'message_done'; sessionId?: string; message: ChatMessage }
  | { type: 'usage'; sessionId?: string; messageId: string; usage: TokenUsage }
  | { type: 'todos'; sessionId: string; todos: TodoItem[] }
  // live run-trace: emitted on every span begin/end and on turn finish, carrying the FULL
  // current Trace; the renderer upserts it by trace.id (Trace is defined later — forward ref).
  | { type: 'trace'; sessionId?: string; trace: Trace }
  | { type: 'fs_change'; files: string[] }
  // a runtime error from the live preview webview (console error / failed load) — drives a
  // one-click "Fix this" affordance in the preview pane. Session-less, like fs_change.
  | { type: 'preview_error'; message: string; url?: string }
  // swarm mode: N parallel agents in isolated git worktrees — run-level + per-worker progress
  | { type: 'swarm_run'; sessionId?: string; runId: string; status: 'start' | 'done' | 'error'; total?: number; message?: string }
  | { type: 'swarm_worker'; sessionId?: string; runId: string; branch: string; status: 'running' | 'done' | 'failed'; message?: string }
  | { type: 'turn_done'; sessionId: string }
  | { type: 'status'; sessionId?: string; message: string }
  | { type: 'error'; message: string }
  // visual workflow runs: per-run and per-node status so the editor can trace live
  | { type: 'workflow_run'; runId: string; workflowId: string; status: 'start' | 'done' | 'error' | 'cancelled'; message?: string }
  | { type: 'workflow_node'; runId: string; nodeId: string; status: WorkflowNodeStatus; output?: string; error?: string }
  // Mission Control progress: per-mission + per-task status. Session-less (like workflow_run) —
  // the overseer runs throwaway sessions per task and emits under a background 'mission' id.
  | { type: 'mission'; missionId: string; taskId?: string; status: string; message?: string }
  // self-healing progress (the coder repairing a failed workflow node, then replaying)
  | {
      type: 'workflow_heal'
      workflowId: string
      runId: string
      status: 'start' | 'agent' | 'patched' | 'replay' | 'healed' | 'failed'
      nodeId?: string
      message?: string
    }

// ---- Feature system descriptors (Skills / Hooks / Commands / Subagents / MCP / Plugins / Automations) ----

export interface SkillDef {
  name: string
  description: string
  path: string
  source: 'user' | 'project' | 'plugin'
  body?: string
}

export interface SlashCommandDef {
  name: string
  description: string
  path: string
  template: string
  source: 'user' | 'project' | 'plugin'
}

export interface SubagentDef {
  name: string
  description: string
  systemPrompt: string
  tools: string[] // tool names this subagent may use ("*" = all)
  model?: string
  source: 'user' | 'project' | 'plugin'
}

export type HookEvent =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SessionStart'

export interface HookDef {
  event: HookEvent
  matcher?: string // regex on tool name (for Pre/PostToolUse)
  command: string // shell command to run
  source: 'user' | 'project' | 'plugin'
}

export interface McpServerDef {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
  status?: 'disconnected' | 'connecting' | 'connected' | 'error'
  tools?: string[]
  error?: string
}

export interface PluginDef {
  name: string
  version: string
  description: string
  path: string
  enabled: boolean
  provides: {
    skills: number
    commands: number
    agents: number
    hooks: number
    mcp: number
  }
}

export interface AutomationDef {
  id: string
  name: string
  schedule: string // cron expression
  prompt: string
  cwd: string
  enabled: boolean
  // 'safe' = only auto-approved reads run unattended; 'full' = writes + shell too
  autonomy?: 'safe' | 'full'
  lastRun?: number
  nextRun?: number
}

export interface MemoryEntry {
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  body: string
  path: string
  // optional scope: when set, this memory only applies to that project (global otherwise)
  projectId?: string
}

// ---- Visual workflow builder (n8n-style, simpler) ----

// (shared) node-type union — see KNOWN_NODE_TYPES in shared/workflows.ts for the runtime set
export type WorkflowNodeType =
  | 'trigger' // entry point (manual / cron / on-chat)
  | 'agent' // run a prompt through the full agent loop
  | 'tool' // run one built-in tool directly (no LLM)
  | 'shell' // run a shell command
  | 'http' // fetch a URL (web_fetch)
  | 'condition' // branch on a simple expression (true/false edges)
  | 'switch' // multi-way branch: route by matching a value against named cases (+ default)
  | 'transform' // template / regex-extract / set a variable
  | 'subworkflow' // run another workflow
  | 'loop' // forEach over a list: run a body workflow per item, collect results
  | 'parallel' // run N branch workflows concurrently, merge results
  | 'merge' // combine several variables into one (array/concat/object)
  | 'delay' // wait N seconds (rate-limiting / polling pauses)
  | 'notify' // send a desktop notification
  | 'store' // persistent key/value state across runs (get/set/incr/has/delete)
  | 'code' // run a small sandboxed JS snippet over the vars (no require/network)
  | 'parse' // parse {{last}} as JSON / CSV / HTML → extract fields
  | 'channel' // send to a channel (telegram/slack/discord/webhook) — sugar over web_request
  | 'email' // send an email over SMTP (host/port/auth via secret)
  | 'output' // emit a result (notify / return to chat)

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType
  label?: string
  // free-form per-type configuration (prompt, tool name+args, command, url,
  // expression, template, target workflow id, output var name, …); typed per node in the UI
  config: Record<string, unknown>
  x?: number // canvas position (set by the editor)
  y?: number
}

export interface WorkflowEdge {
  id: string
  source: string // node id
  target: string // node id
  sourceHandle?: string // 'true' | 'false' for condition branches; undefined = default
}

export interface WorkflowDef {
  id: string
  name: string
  description?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  createdAt: number
  updatedAt: number
  // self-healing: when a node fails on an UNATTENDED run (cron/file-watch/chat), let the
  // in-process coder diagnose + patch the node config or a referenced file, then replay from
  // the failed node. Bounded by maxHealAttempts (default 1). Interactive "Reparieren" works
  // regardless of this flag.
  autoHeal?: boolean
  maxHealAttempts?: number
}

export type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

export interface WorkflowRunNode {
  nodeId: string
  status: WorkflowNodeStatus
  output?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

export interface WorkflowRun {
  id: string
  workflowId: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  nodes: WorkflowRunNode[]
  vars?: Record<string, string>
  startedAt: number
  endedAt?: number
  error?: string // why the run failed (node error / loop or step limit) — surfaced terminally
  // In-memory ONLY (never persisted — maskRunForPersist drops it): everything a self-heal
  // replay needs to resume from the failed node with the EXACT live/unmasked input state.
  healSeed?: {
    fromNodeId: string
    vars: Record<string, string> // the live vars as the failed node SAW them (pre-node snapshot)
    seedOutputs: Record<string, string> // upstream node outputs so {{node.<id>}} still resolves
  }
}

// Flat, agent-facing result of running a workflow end-to-end (used by the chat agent's
// runWorkflow tool capability). Secrets are masked in every output/error before it is returned.
export interface WorkflowRunResult {
  ok: boolean
  status: string
  output?: string
  error?: string
  nodes: { id: string; label?: string; status: string; output?: string; error?: string }[]
}

// A swarm/* branch produced by a swarm run — surfaced in the merge-gate panel.
export interface SwarmBranch {
  branch: string
  subject: string // commit subject ("swarm: <label>")
  stat: string // git diff --stat HEAD...branch
}

// ---- Agent run trace (observability) ----
// A correlated, persisted tree of what one chat TURN actually did: quality rounds,
// each LLM call (with cost), each tool call (with duration / ok-error), nested
// subagents, verify + compaction. Mirrors the WorkflowRun shape but adds the
// cost/tokens + a parentId tree the workflow analog lacks. One JSON per turn.
export type TraceStatus = 'running' | 'ok' | 'error' | 'cancelled'
export type TraceSpanKind = 'round' | 'llm' | 'tool' | 'subagent' | 'verify' | 'compact'

export interface TraceSpan {
  id: string
  parentId?: string // undefined = top-level (direct child of the turn); otherwise nests under that span
  kind: TraceSpanKind
  name: string // model id / tool name / "Runde 1" / "Verify: npm test" / subagent name
  status: TraceStatus
  startedAt: number
  endedAt?: number
  costUsd?: number // llm / subagent / compact spans only (tools are free compute)
  tokens?: number
  detail?: string // short, already-truncated action summary (no full tool I/O)
  error?: string // short error head when status==='error'
  // before→after line diff for a successful write_file/edit_file/apply_patch tool span — lets the
  // Traces panel show WHAT a tool changed, not just that it ran. Capped; only set on fs write tools.
  diff?: string
  diffAdded?: number
  diffRemoved?: number
  diffPath?: string // the edited file path (relative-ish display), when a single file was touched
}

export interface Trace {
  id: string
  sessionId: string
  title: string // first ~80 chars of the user prompt
  cwd: string
  model: string
  status: TraceStatus
  startedAt: number
  endedAt?: number
  costUsd: number // sum of all cost-bearing spans (includes subagents)
  tokens: number
  spans: TraceSpan[] // flat; the tree is rebuilt via parentId in the UI
  unattended?: boolean
  // the engine turn key (String(Date.now()) at turn start) — IDENTICAL to the checkpoint turnTag,
  // so Time Machine can correlate this reasoning trace to that turn's FS pre-image snapshots EXACTLY
  // (not by fuzzy timestamp proximity). Absent on traces written before this field existed.
  turnTag?: string
}

// ---- Time Machine (causal replay + branch-from-here) ----
// Time Machine fuses the three PERSISTED, per-turn, millisecond-timestamped stores into ONE
// scrubbable timeline: traces (reasoning/tool span tree + cost), checkpoints (restorable FS
// pre-images), session messages (conversation + cost). A "tick" is one agent TURN, keyed by its
// millisecond turnTag. It is honest about what is NOT replayable: background jobs live in-memory
// only (jobs.ts), preview frames aren't persisted, traces cap at 300 and checkpoints at 100 per
// session, and pre-images over 5MB / locked files are skipped (never reconstructable).

// One file a turn touched, as recorded in that turn's checkpoint pre-image.
export interface TimelineTickFile {
  path: string // absolute path
  rel: string // path relative to the session cwd (for display)
  existed: boolean // did the file exist BEFORE the turn ran?
  skipped: boolean // pre-image NOT captured (locked or >5MB) → cannot be reconstructed
}

// A single fused point on a session's timeline (one agent turn).
export interface TimelineTick {
  tick: number // ms timestamp = the turn key (sort ascending = chronological)
  iso: string // localized human time, prebuilt main-side
  sessionId: string
  traceId?: string // present when the turn's trace survived (not pruned past MAX_TRACES)
  checkpointTag?: string // present when the turn changed files (a checkpoint exists)
  status: TraceStatus | 'unknown'
  model?: string
  costUsd: number
  tokens: number
  spanCount: number
  toolCount: number
  topError?: string // short head of the first failing span, if any
  files: TimelineTickFile[] // files this turn changed
  restorable: boolean // ≥1 non-skipped file → branch-from-here can reconstruct something
  userExcerpt?: string // first user message of the turn (clipped)
  assistantExcerpt?: string // first assistant text of the turn (clipped)
  messageCount: number
  hasTrace: boolean
  hasCheckpoint: boolean
  skippedFiles: number // count of files whose pre-image was skipped (honesty badge)
}

// The expanded detail for one selected tick.
export interface TickDetail {
  tick: TimelineTick
  trace?: Trace // full span tree (reasoning) when it survived
  messages: ChatMessage[] // the turn's messages (clipped main-side)
  diff?: string // unified diff of the turn's file changes (pre-image → after), capped
}

// A timemachine/* branch produced by branch-from-here — surfaced in the fork list (mirrors SwarmBranch).
export interface TimeMachineFork {
  branch: string // timemachine/<sessionSlug>-t<tick>
  subject: string // commit subject
  stat: string // git diff --stat HEAD...branch
}

// Result of forking the repo state at a past tick into a new local branch.
export interface ForkResult {
  ok: boolean
  branch?: string
  sha?: string // short HEAD of the new branch
  applied: number // files written from a captured pre-image
  skipped: number // touched files whose pre-image could NOT be reconstructed (honest gap)
  deleted: number // files that did not yet exist at the tick → removed on the fork
  message: string
}
