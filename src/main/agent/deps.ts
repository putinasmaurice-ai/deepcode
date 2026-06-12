import { AgentEvent, AppSettings } from '@shared/types'
import { DeepSeekClient } from './deepseek'

export type Emit = (e: AgentEvent) => void

// Capabilities the engine lends to extracted operations (variants, compaction,
// distillation, subagents) without exposing the whole class.
export interface EngineDeps {
  client: DeepSeekClient
  settings: AppSettings
  acquire(sessionId: string): AbortController
  release(sessionId: string): void
  // the currently held controller (for reentrant ops that must share the
  // parent's cancellation signal)
  current(sessionId: string): AbortController | undefined
}
