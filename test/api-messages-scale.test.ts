import { describe, it, expect } from 'vitest'
import { toApiMessages } from '../src/main/agent/api-messages'
import { estimateTokens } from '../src/main/agent/pricing'
import { ChatMessage, Session } from '../src/shared/types'

// Stress the per-turn hot path on a VERY long session: building the API message
// list and estimating tokens runs on every turn, so it must stay O(n), fast, and
// bounded (tool-output elision must keep old rounds tiny) even at thousands of msgs.
function bigSession(rounds: number): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (let i = 0; i < rounds; i++) {
    msgs.push({ id: 'u' + i, role: 'user', content: 'do step ' + i, createdAt: i })
    msgs.push({
      id: 'a' + i,
      role: 'assistant',
      content: 'working on ' + i + ' '.padEnd(200, 'x'),
      createdAt: i,
      reasoning: 'because '.padEnd(500, 'r'),
      toolCalls: [{ id: 'c' + i, name: 'read_file', arguments: '{"path":"f' + i + '"}' }]
    } as ChatMessage)
    msgs.push({
      id: 't' + i,
      role: 'tool',
      toolCallId: 'c' + i,
      toolName: 'read_file',
      content: 'FILE CONTENT '.repeat(4000), // ~52 KB each — old ones must be elided
      createdAt: i
    } as ChatMessage)
  }
  return msgs
}

describe('hot path at scale (very long sessions)', () => {
  it('builds API messages fast and bounded for a 2000-round session', () => {
    const messages = bigSession(2000) // 6000 messages, ~100 MB of raw tool output
    const session = { id: 's', messages } as Session

    const t0 = Date.now()
    const out = toApiMessages('SYSTEM', messages)
    const est = estimateTokens(session)
    const ms = Date.now() - t0

    // O(n): must finish quickly, not hang/OOM (generous bound catches O(n^2))
    expect(ms).toBeLessThan(3000)

    // Elision: the serialized payload must be a tiny fraction of the raw tool output.
    const rawToolBytes = messages
      .filter((m) => m.role === 'tool')
      .reduce((n, m) => n + (m.content?.length ?? 0), 0)
    const sentBytes = JSON.stringify(out).length
    expect(rawToolBytes).toBeGreaterThan(100_000_000) // ~100 MB raw
    expect(sentBytes).toBeLessThan(2_000_000) // sent payload bounded to a couple MB

    // The most recent tool output is kept verbatim-ish; the oldest is stubbed.
    const tools = out.filter((m) => m.role === 'tool')
    expect((tools[0].content as string)).toContain('gekürzt')
    expect((tools[tools.length - 1].content as string).length).toBeGreaterThan(1000)

    // token estimate is a finite positive number (no overflow/NaN)
    expect(Number.isFinite(est)).toBe(true)
    expect(est).toBeGreaterThan(0)
  })
})
