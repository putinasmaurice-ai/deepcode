import { describe, it, expect } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { TraceRecorder } from '../src/main/agent/trace'
import { saveTrace, getTrace, listTraces } from '../src/main/trace-store'
import { PATHS } from '../src/main/paths'
import type { Trace } from '../src/shared/types'

// The TraceRecorder builds the span tree for one turn. persist + now are injected so we
// test the tree/accumulation/clipping/close logic without touching disk or the wall clock.
function rec(): { r: TraceRecorder; saved: Trace[]; tick: () => void } {
  const saved: Trace[] = []
  let t = 1000
  const r = new TraceRecorder(
    { sessionId: 's1', title: 'Tu etwas Sinnvolles', cwd: '/p', model: 'deepseek-chat' },
    { persist: (tr) => saved.push(structuredClone(tr)), now: () => t }
  )
  return { r, saved, tick: () => (t += 1000) }
}

describe('TraceRecorder', () => {
  it('builds a parentId tree and accumulates cost + tokens onto the trace', () => {
    const { r, tick } = rec()
    const round = r.begin('round', 'Runde 1')
    tick()
    const llm = r.begin('llm', 'deepseek-chat', round)
    tick()
    r.end(llm, { status: 'ok', costUsd: 0.002, tokens: 1500 })
    const tool = r.begin('tool', 'read_file', round, 'Read foo.ts')
    tick()
    r.end(tool, { status: 'ok' })
    r.end(round, { status: 'ok' })

    const t = r.trace
    expect(t.spans.map((s) => s.kind)).toEqual(['round', 'llm', 'tool'])
    expect(t.spans.find((s) => s.kind === 'llm')!.parentId).toBe(round)
    expect(t.spans.find((s) => s.kind === 'tool')!.parentId).toBe(round)
    expect(t.costUsd).toBeCloseTo(0.002, 6)
    expect(t.tokens).toBe(1500)
    expect(t.spans.find((s) => s.kind === 'tool')!.detail).toBe('Read foo.ts')
  })

  it('nests a subagent under the current tool span via currentToolSpanId', () => {
    const { r } = rec()
    const round = r.begin('round', 'Runde 1')
    const tool = r.begin('tool', 'task', round)
    r.currentToolSpanId = tool // executeToolCall sets this around tool.execute
    const sub = r.begin('subagent', 'code-reviewer', r.currentToolSpanId)
    r.end(sub, { status: 'ok', costUsd: 0.01, tokens: 800 })
    r.currentToolSpanId = undefined
    r.end(tool, { status: 'ok' })
    r.end(round, { status: 'ok' })

    expect(r.trace.spans.find((s) => s.kind === 'subagent')!.parentId).toBe(tool)
    expect(r.trace.costUsd).toBeCloseTo(0.01, 6)
    expect(r.trace.tokens).toBe(800)
  })

  it('finish() closes any still-open span and sets terminal status/endedAt', () => {
    const { r } = rec()
    const round = r.begin('round', 'Runde 1')
    r.begin('llm', 'deepseek-chat', round) // deliberately left open (simulates a crash mid-call)
    r.finish('cancelled')

    expect(r.trace.status).toBe('cancelled')
    expect(r.trace.endedAt).toBeGreaterThan(0)
    for (const s of r.trace.spans) {
      expect(s.endedAt).toBeGreaterThan(0)
      expect(s.status).toBe('cancelled')
    }
  })

  it('a leftover open span on an OK turn is marked cancelled, not falsely ok', () => {
    const { r } = rec()
    r.begin('round', 'Runde 1') // never ended
    r.finish('ok')
    expect(r.trace.status).toBe('ok')
    expect(r.trace.spans[0].status).toBe('cancelled') // an un-ended span didn't truly succeed
  })

  it('clips + collapses long detail/error and ignores non-finite cost/tokens', () => {
    const { r } = rec()
    const sp = r.begin('tool', 'run_command', undefined, 'a'.repeat(500))
    r.end(sp, { status: 'error', error: 'line1\n\n   line2 ' + 'x'.repeat(500), costUsd: NaN, tokens: Infinity })
    const span = r.trace.spans[0]
    expect(span.detail!.length).toBeLessThanOrEqual(200)
    expect(span.error!).not.toContain('\n') // whitespace collapsed
    expect(span.error!.length).toBeLessThanOrEqual(300)
    expect(r.trace.costUsd).toBe(0) // NaN ignored
    expect(r.trace.tokens).toBe(0) // Infinity ignored
  })

  it('redacts common secret shapes out of span detail + error before persisting', () => {
    const { r } = rec()
    const s1 = r.begin('tool', 'run_command', undefined, '$ TOKEN=ghp_abcdefGHIJKL0123456789 npm publish')
    r.end(s1, { status: 'error', error: 'curl -H "Authorization: Bearer sk-live-abcDEF123456" failed' })
    const s2 = r.begin('tool', 'web_request', undefined, 'GET https://user:hunter2@api.example.com/x')
    r.end(s2, { status: 'ok' })
    const s3 = r.begin('tool', 'web_request', undefined, 'POST https://api.telegram.org/bot123456789:AAH-SecretToken_ABCDEFGHIJ/sendMessage')
    r.end(s3, { status: 'ok' })

    const detail1 = r.trace.spans[0].detail!
    expect(detail1).not.toContain('ghp_abcdefGHIJKL0123456789')
    expect(detail1).toContain('***')
    expect(r.trace.spans[0].error!).not.toContain('sk-live-abcDEF123456')
    expect(r.trace.spans[1].detail!).toContain('***:***@') // user:pass@host masked (pass gone)
    expect(r.trace.spans[1].detail!).not.toContain('hunter2')
    expect(r.trace.spans[2].detail!).toContain('bot***')
    expect(r.trace.spans[2].detail!).not.toContain('AAH-SecretToken_ABCDEFGHIJ')
  })

  it('persists on create and forces a persist on finish', () => {
    const { r, saved } = rec()
    expect(saved.length).toBe(1) // created → appears as running immediately
    expect(saved[0].status).toBe('running')
    r.finish('ok')
    expect(saved[saved.length - 1].status).toBe('ok') // terminal flush
  })

  it('end() is idempotent and ignores an unknown id', () => {
    const { r } = rec()
    const sp = r.begin('llm', 'm')
    r.end(sp, { status: 'ok', costUsd: 0.001 })
    r.end(sp, { status: 'error', costUsd: 0.001 }) // second end is a no-op
    r.end(undefined, { status: 'ok' })
    r.end('nope', { status: 'ok' })
    expect(r.trace.costUsd).toBeCloseTo(0.001, 6) // not double-counted
    expect(r.trace.spans[0].status).toBe('ok')
  })
})

describe('trace-store round-trip', () => {
  it('saves, gets and lists a trace, then is filterable by session (self-cleaning)', () => {
    const id = `test-trace-${Math.floor(performance.now())}-${process.pid}`
    const sessionId = `test-sess-${process.pid}`
    const trace: Trace = {
      id, sessionId, title: 'roundtrip', cwd: '/p', model: 'm',
      status: 'ok', startedAt: 1, endedAt: 2, costUsd: 0.01, tokens: 10,
      spans: [{ id: 'a', kind: 'llm', name: 'm', status: 'ok', startedAt: 1, endedAt: 2, costUsd: 0.01, tokens: 10 }]
    }
    const file = join(PATHS.traces, `${id}.json`)
    try {
      saveTrace(trace)
      const got = getTrace(id)
      expect(got?.id).toBe(id)
      expect(got?.spans[0].costUsd).toBe(0.01)
      expect(listTraces(sessionId).some((t) => t.id === id)).toBe(true)
      expect(listTraces('no-such-session').some((t) => t.id === id)).toBe(false)
    } finally {
      if (existsSync(file)) unlinkSync(file)
    }
  })
})
