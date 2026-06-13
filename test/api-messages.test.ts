import { describe, it, expect } from 'vitest'
import { toApiMessages } from '../src/main/agent/api-messages'
import { ChatMessage } from '../src/shared/types'

function msg(p: Partial<ChatMessage>): ChatMessage {
  return { id: Math.random().toString(36), role: 'user', content: '', createdAt: 0, ...p } as ChatMessage
}

describe('toApiMessages', () => {
  it('prepends the system prompt', () => {
    const out = toApiMessages('SYS', [msg({ role: 'user', content: 'hi' })])
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' })
  })

  it('backfills a tool message for an unanswered tool_call', () => {
    const out = toApiMessages('S', [
      msg({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] })
    ])
    const tool = out.find((m) => m.role === 'tool')
    expect(tool?.tool_call_id).toBe('c1')
    expect(tool?.content).toContain('interrupted')
  })

  it('keeps recent tool output but truncates old ones to a stub', () => {
    const history: ChatMessage[] = []
    for (let i = 0; i < 6; i++) {
      history.push(msg({ role: 'assistant', content: '', toolCalls: [{ id: 'c' + i, name: 'grep', arguments: '{}' }] }))
      history.push(msg({ role: 'tool', toolCallId: 'c' + i, toolName: 'grep', content: 'X'.repeat(40000) }))
    }
    const out = toApiMessages('S', history)
    const tools = out.filter((m) => m.role === 'tool')
    const oldest = tools[0].content as string
    const newest = tools[tools.length - 1].content as string
    expect(oldest).toContain('gekürzt')
    expect(oldest.length).toBeLessThan(400)
    expect(newest.length).toBeGreaterThan(1000) // recent kept (capped at 30k)
  })

  it('formats image attachments as multimodal content parts', () => {
    const out = toApiMessages('S', [msg({ role: 'user', content: 'look', images: ['data:image/png;base64,AAA'] })])
    const u = out.find((m) => m.role === 'user')
    expect(Array.isArray(u?.content)).toBe(true)
    const parts = u!.content as { type: string }[]
    expect(parts.some((x) => x.type === 'text')).toBe(true)
    expect(parts.some((x) => x.type === 'image_url')).toBe(true)
  })
})
