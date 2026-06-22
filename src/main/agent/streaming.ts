import { randomUUID } from 'crypto'
import { ChatMessage } from '@shared/types'
import { StreamCallbacks } from './deepseek'
import { Emit } from './deps'

// Shared streaming plumbing: one assistant message that live-forwards
// reasoning/content deltas to the renderer. Used by the turn loop, second
// opinion and the arena (previously three identical copies).

export function newAssistantMessage(extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    ...extra
  }
}

export function streamCallbacksFor(msg: ChatMessage, emit: Emit): StreamCallbacks {
  return {
    onReasoning: (d) => {
      msg.reasoning = (msg.reasoning ?? '') + d
      emit({ type: 'reasoning_delta', messageId: msg.id, delta: d })
    },
    onContent: (d) => {
      msg.content += d
      emit({ type: 'content_delta', messageId: msg.id, delta: d })
    },
    // surface connect-retry / backoff notes during otherwise-silent stretches so the UI shows
    // "working, retrying" instead of looking hung.
    onStatus: (message) => emit({ type: 'status', message })
  }
}
