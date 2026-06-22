import { describe, it, expect } from 'vitest'
import { toApiMessages, toolArgErrorMessage } from '../src/main/agent/api-messages'
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

  it('inlines the vision description as text and never sends raw image parts to the text model', () => {
    // DeepSeek is blind — the vision model (Gemini/local) described the image up front; that
    // description must reach the text model as plain text, NOT as image_url parts.
    const out = toApiMessages('S', [
      msg({ role: 'user', content: 'look', images: ['data:image/png;base64,AAA'], imageDescription: 'a red button labeled Submit' })
    ])
    const u = out.find((m) => m.role === 'user')
    expect(typeof u?.content).toBe('string')
    expect(u!.content as string).toContain('look')
    expect(u!.content as string).toContain('a red button labeled Submit')
    expect(u!.content as string).not.toContain('data:image')
  })

  it('falls back to a placeholder when an image has no description', () => {
    const out = toApiMessages('S', [msg({ role: 'user', content: 'look', images: ['data:image/png;base64,AAA'] })])
    const u = out.find((m) => m.role === 'user')
    expect(typeof u?.content).toBe('string')
    expect(u!.content as string).toMatch(/keine Analyse verfügbar/)
  })

  describe('toolArgErrorMessage (truncation vs malformed JSON)', () => {
    it('truncation: blames the token limit, instructs chunked writing, and never echoes the payload', () => {
      const msg = toolArgErrorMessage('write_file', 42634, true)
      expect(msg).toMatch(/ABGESCHNITTEN/)
      expect(msg).toMatch(/Token-Limit/)
      expect(msg).toMatch(/append/) // points at write_file(mode:"append")
      expect(msg).not.toMatch(/<!DOCTYPE|<html/) // the oversized blob is NOT echoed back
    })

    it('malformed JSON: asks for valid JSON and does NOT claim truncation', () => {
      const msg = toolArgErrorMessage('apply_patch', 120, false)
      expect(msg).toMatch(/Ungültige|GÜLTIGES/)
      expect(msg).not.toMatch(/ABGESCHNITTEN/)
    })
  })

  describe('reasoning replay (first-party DeepSeek thinking-mode)', () => {
    const toolTurn = msg({
      role: 'assistant',
      content: '',
      reasoning: 'Ich überlege, welche Datei…',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }]
    })
    const finalTurn = msg({ role: 'assistant', content: 'Fertig.', reasoning: 'kurzer Gedanke' })
    const hist = [toolTurn, msg({ role: 'tool', toolCallId: 'c1', toolName: 'read_file', content: 'ok' }), finalTurn]

    it('replays reasoning_content ONLY on tool-call turns when enabled', () => {
      const out = toApiMessages('S', hist, { replayReasoning: true })
      const assts = out.filter((m) => m.role === 'assistant')
      expect(assts[0].reasoning_content).toBe('Ich überlege, welche Datei…') // the tool-call turn → replayed
      expect(assts[1].reasoning_content).toBeUndefined() // the plain final answer → stripped (R1-safe)
    })

    it('never sets reasoning_content when replay is off (default — DeepInfra/OpenRouter/etc.)', () => {
      const out = toApiMessages('S', hist) // no opts
      for (const m of out) expect(m.reasoning_content).toBeUndefined()
    })

    it('is a no-op for a tool-call turn that carries no reasoning', () => {
      const out = toApiMessages('S', [msg({ role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'x', arguments: '{}' }] })], {
        replayReasoning: true
      })
      expect(out.find((m) => m.role === 'assistant')?.reasoning_content).toBeUndefined()
    })
  })
})
