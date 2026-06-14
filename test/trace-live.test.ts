import { describe, it, expect } from 'vitest'
import { TraceRecorder } from '../src/main/agent/trace'
import type { Trace } from '../src/shared/types'

// Live streaming: the recorder fires onUpdate(fullTrace) on every span change so the renderer
// can show the tree updating in real time. persist is a no-op sink and now is a fake counter, so
// this exercises the live path with no disk and no wall clock — onUpdate snapshots are cloned so
// later mutations can't retroactively change what an earlier assertion saw.
function rec(): { r: TraceRecorder; live: Trace[]; tick: () => void } {
  const live: Trace[] = []
  let t = 1000
  const r = new TraceRecorder(
    { sessionId: 's1', title: 'Stream mir den Trace', cwd: '/p', model: 'deepseek-chat' },
    { persist: () => {}, now: () => t, onUpdate: (tr) => live.push(structuredClone(tr)) }
  )
  return { r, live, tick: () => (t += 1000) }
}

describe('TraceRecorder live onUpdate', () => {
  it('fires on construct with the running trace', () => {
    const { live } = rec()
    expect(live.length).toBe(1) // construct streamed the initial running trace
    expect(live[0].status).toBe('running')
    expect(live[0].spans.length).toBe(0)
  })

  it('fires on begin, end and finish, reflecting the latest span/status each time', () => {
    const { r, live } = rec()
    expect(live.length).toBe(1) // construct

    const sp = r.begin('llm', 'deepseek-chat')
    expect(live.length).toBe(2) // begin streamed
    const afterBegin = live[live.length - 1]
    expect(afterBegin.spans.length).toBe(1)
    expect(afterBegin.spans[0].name).toBe('deepseek-chat')
    expect(afterBegin.spans[0].status).toBe('running')

    r.end(sp, { status: 'ok', costUsd: 0.003, tokens: 1200 })
    expect(live.length).toBe(3) // end streamed
    const afterEnd = live[live.length - 1]
    expect(afterEnd.spans[0].status).toBe('ok')
    expect(afterEnd.costUsd).toBeCloseTo(0.003, 6) // accumulated cost is in the snapshot
    expect(afterEnd.tokens).toBe(1200)
    expect(afterEnd.status).toBe('running') // turn not finished yet

    r.finish('ok')
    expect(live.length).toBe(4) // finish streamed
    const afterFinish = live[live.length - 1]
    expect(afterFinish.status).toBe('ok')
    expect(afterFinish.endedAt).toBeGreaterThan(0)
  })

  it('snapshots are independent — an early snapshot keeps its old running status', () => {
    const { r, live } = rec()
    r.finish('ok')
    expect(live[0].status).toBe('running') // construct-time snapshot untouched by the later finish
    expect(live[live.length - 1].status).toBe('ok')
  })

  it('a throwing onUpdate listener never breaks the turn', () => {
    let calls = 0
    const r = new TraceRecorder(
      { sessionId: 's1', title: 'boom', cwd: '/p', model: 'm' },
      {
        persist: () => {},
        now: () => 1,
        onUpdate: () => {
          calls++
          throw new Error('listener blew up')
        }
      }
    )
    // construct already invoked the throwing listener and swallowed it; further calls keep working
    expect(calls).toBe(1)
    expect(() => {
      const sp = r.begin('tool', 'read_file')
      r.end(sp, { status: 'ok' })
      r.finish('ok')
    }).not.toThrow()
    expect(r.trace.status).toBe('ok') // the turn still completed normally
    expect(calls).toBe(4) // construct + begin + end + finish all fired
  })
})
