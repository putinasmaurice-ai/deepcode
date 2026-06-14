import { ToolResult } from '@shared/types'
import type { TraceRecorder } from '../trace'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  // Run-trace recorder for the current turn (observability). Absent in subagent runs
  // and tests. executeToolCall opens/closes a tool span around tool.execute via this.
  trace?: TraceRecorder
  // When true, file tools refuse paths that resolve outside the working directory.
  confineToCwd?: boolean
  // When true, the turn runs UNATTENDED (workflow agent node / cron) — the approval gate
  // blocks high-blast-radius tools (MCP / claude_code / task / git push|pr) that can't be
  // approved with no user present.
  unattended?: boolean
  // Allows a tool (e.g. the subagent/Task tool) to call back into the agent engine.
  spawnSubagent?: (agentName: string, prompt: string) => Promise<string>
  // Describe a screenshot/image (data URI) via the vision pipeline — lets preview_probe turn a
  // capturePage() PNG into text for the blind text model. Absent in subagent runs.
  describeImage?: (dataUri: string) => Promise<string | null>
  emitStatus?: (msg: string) => void
  // Checkpoint hook: called with the absolute path BEFORE a file is modified.
  snapshot?: (absPath: string) => void
  // Todo-list hook: the todo_write tool reports the agent's plan/progress here.
  emitTodos?: (todos: { text: string; status: 'open' | 'doing' | 'done' }[]) => void
}

export interface Tool {
  name: string
  description: string
  // JSON schema for parameters
  parameters: Record<string, unknown>
  permission: 'read' | 'write' | 'bash' | 'none'
  // short human label for the UI, e.g. "Read file.ts"
  summarize?: (args: any) => string
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult>
}

export function ok(content: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: true, content, meta }
}

export function fail(content: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: false, content, meta }
}
