import { ToolResult } from '@shared/types'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  // When true, file tools refuse paths that resolve outside the working directory.
  confineToCwd?: boolean
  // Allows a tool (e.g. the subagent/Task tool) to call back into the agent engine.
  spawnSubagent?: (agentName: string, prompt: string) => Promise<string>
  emitStatus?: (msg: string) => void
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
