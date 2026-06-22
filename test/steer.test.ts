import { describe, it, expect } from 'vitest'
import { AgentEngine } from '../src/main/agent/engine'
import { DEFAULT_SETTINGS } from '../src/shared/types'

// Mid-turn steering: a message sent WHILE a turn is running is queued and injected at the next
// runSteps step boundary, instead of waiting for the turn to end. steer() is the public entry —
// it must only accept input when a turn is actually live for that session.
const makeEngine = (): AgentEngine => new AgentEngine(structuredClone(DEFAULT_SETTINGS))

// the live-session + queue maps are private; a test reaches them to assert the queue mechanics
// deterministically without spinning up a real LLM turn.
const live = (e: AgentEngine, id: string): void => {
  ;(e as unknown as { liveSessions: Map<string, unknown> }).liveSessions.set(id, { id, messages: [] })
}
const queued = (e: AgentEngine, id: string): string[] | undefined =>
  (e as unknown as { steerQueue: Map<string, string[]> }).steerQueue.get(id)

describe('Engine.steer (mid-turn steering)', () => {
  it('returns false when no turn is running for the session', () => {
    expect(makeEngine().steer('missing', 'go left')).toBe(false)
  })

  it('returns false for empty/whitespace text even if a turn is live', () => {
    const e = makeEngine()
    live(e, 's1')
    expect(e.steer('s1', '   ')).toBe(false)
    expect(queued(e, 's1')).toBeUndefined()
  })

  it('queues trimmed text (FIFO) and returns true when a turn is live', () => {
    const e = makeEngine()
    live(e, 's1')
    expect(e.steer('s1', '  use TypeScript  ')).toBe(true)
    expect(e.steer('s1', 'and add tests')).toBe(true)
    expect(queued(e, 's1')).toEqual(['use TypeScript', 'and add tests'])
  })

  it('keeps per-session queues separate', () => {
    const e = makeEngine()
    live(e, 'a')
    live(e, 'b')
    e.steer('a', 'for A')
    expect(e.steer('b', 'for B')).toBe(true)
    expect(queued(e, 'a')).toEqual(['for A'])
    expect(queued(e, 'b')).toEqual(['for B'])
  })
})
