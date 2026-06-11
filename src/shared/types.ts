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
}

export interface Session {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  model?: string
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    reasonerModel: 'deepseek-reasoner',
    temperature: 0.2,
    maxTokens: 8192,
    pricePerMillionInput: 0.27,
    pricePerMillionOutput: 1.1
  },
  autoApprove: {
    read: true,
    write: false,
    bash: false
  },
  defaultCwd: '',
  customInstructions: '',
  confineToCwd: true,
  compactThreshold: 0
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
