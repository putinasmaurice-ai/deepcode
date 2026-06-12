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
  // OpenAI-compatible endpoint for LOCAL models (Ollama/LM Studio).
  // Models prefixed "local:" are routed here, keyless and free.
  localBaseUrl: string
  // model the 🔓 Uncensored toggle switches to (a local, unaligned model)
  uncensoredModel: string
  // vision-capable model used automatically when a message has image attachments
  visionModel: string
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
  // notify when project files change outside the agent (editor saves, git)
  watcherEnabled: boolean
  // after a turn that changed files, run one extra self-review pass (≈2x tokens)
  selfReview: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    reasonerModel: 'deepseek-reasoner',
    temperature: 0.1, // DeepSeek empfiehlt für Coding niedrige Temperatur
    maxTokens: 8192,
    pricePerMillionInput: 0.27,
    pricePerMillionOutput: 1.1,
    reasonerPricePerMillionInput: 0.55,
    reasonerPricePerMillionOutput: 2.19,
    localBaseUrl: 'http://localhost:11434/v1',
    uncensoredModel: 'local:dolphin3',
    visionModel: 'local:qwen2.5vl:7b'
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
  watcherEnabled: false,
  selfReview: false
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

export type AgentEvent =
  | { type: 'session'; session: Session }
  | { type: 'message_start'; message: ChatMessage }
  | { type: 'reasoning_delta'; messageId: string; delta: string }
  | { type: 'content_delta'; messageId: string; delta: string }
  | { type: 'tool_call'; messageId: string; toolCall: ToolCall }
  | { type: 'tool_pending'; callId: string; name: string; args: string }
  | { type: 'tool_result'; callId: string; name: string; result: ToolResult }
  | { type: 'message_done'; message: ChatMessage }
  | { type: 'usage'; messageId: string; usage: TokenUsage }
  | { type: 'todos'; sessionId: string; todos: TodoItem[] }
  | { type: 'fs_change'; files: string[] }
  | { type: 'turn_done'; sessionId: string }
  | { type: 'error'; message: string }
  | { type: 'status'; message: string }

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
