import { describe, it, expect, vi } from 'vitest'
import { callMcpTool, MCP_CALL_TIMEOUT_MS } from '../src/main/systems/mcp'

// Guards the fix for the hang: an MCP call must carry the abort signal + a hard timeout, and an
// abort/error must resolve to a clean failed ToolResult (never an unresolved promise).
const sig = (aborted = false): AbortSignal => {
  const ac = new AbortController()
  if (aborted) ac.abort()
  return ac.signal
}
const client = (impl: (...a: any[]) => Promise<any>) => ({ callTool: vi.fn(impl) })

describe('callMcpTool', () => {
  it('maps a normal result to ok() and joins text/non-text content', async () => {
    const c = client(async () => ({ content: [{ type: 'text', text: 'hi' }, { type: 'image' }] }))
    const r = await callMcpTool(c, 'tool', { a: 1 }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toBe('hi\n[image]')
  })

  it('maps an isError result to fail()', async () => {
    const c = client(async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }))
    const r = await callMcpTool(c, 'tool', {}, sig())
    expect(r.ok).toBe(false)
    expect(r.content).toBe('boom')
  })

  it('passes the abort signal AND a hard timeout to callTool (so Stop works + a hang is bounded)', async () => {
    const s = sig()
    const c = client(async () => ({ content: [] }))
    await callMcpTool(c, 'tool', { x: 1 }, s)
    const [params, schema, opts] = c.callTool.mock.calls[0]
    expect(params).toEqual({ name: 'tool', arguments: { x: 1 } })
    expect(schema).toBeUndefined()
    expect(opts).toMatchObject({ signal: s, timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS })
  })

  it('returns a clean cancellation when the signal is aborted', async () => {
    const c = client(async () => {
      throw new Error('request aborted')
    })
    const r = await callMcpTool(c, 'seqthink', {}, sig(true))
    expect(r.ok).toBe(false)
    expect(r.content).toContain('abgebrochen')
  })

  it('surfaces a generic failure without hanging', async () => {
    const c = client(async () => {
      throw new Error('server exploded')
    })
    const r = await callMcpTool(c, 'tool', {}, sig())
    expect(r.ok).toBe(false)
    expect(r.content).toBe('MCP call failed: server exploded')
  })

  it('defaults empty output to a placeholder', async () => {
    const c = client(async () => ({}))
    expect((await callMcpTool(c, 'tool', undefined, sig())).content).toBe('(no output)')
  })
})
