// Shared type definitions used by both the Electron main process and the renderer.

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
  // route mechanical agent steps to the cheap chat model and reserve the reasoner
  // for planning/debugging — cuts cost when the session model is the reasoner.
  autoRouteModels: boolean
  // hard cost ceiling per turn in USD (0 = off); the loop pauses when exceeded.
  maxCostPerTurn: number
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
      'deepinfra:Qwen/Qwen3-VL-235B-A22B-Instruct' // vision-language
    ]
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
  autoRouteModels: true,
  maxCostPerTurn: 0,
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
  | { type: 'tool_result'; sessionId?: string; callId: string; name: string; result: ToolResult }
  | { type: 'message_done'; sessionId?: string; message: ChatMessage }
  | { type: 'usage'; sessionId?: string; messageId: string; usage: TokenUsage }
  | { type: 'todos'; sessionId: string; todos: TodoItem[] }
  | { type: 'fs_change'; files: string[] }
  | { type: 'turn_done'; sessionId: string }
  | { type: 'status'; sessionId?: string; message: string }
  | { type: 'error'; message: string }
  // visual workflow runs: per-run and per-node status so the editor can trace live
  | { type: 'workflow_run'; runId: string; workflowId: string; status: 'start' | 'done' | 'error' | 'cancelled'; message?: string }
  | { type: 'workflow_node'; runId: string; nodeId: string; status: WorkflowNodeStatus; output?: string; error?: string }

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
}
