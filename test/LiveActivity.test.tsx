// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { LiveActivity } from '../src/renderer/src/components/LiveActivity'
import type { AgentEvent, Trace } from '../src/shared/types'

// capture the handler LiveActivity registers via window.deepcode.onAgentEvent, so the test can
// push events at it; the unsubscribe is a no-op spy.
let emit: (e: AgentEvent) => void = () => {}
beforeEach(() => {
  emit = () => {}
  ;(window as unknown as { deepcode: unknown }).deepcode = {
    onAgentEvent: (cb: (e: AgentEvent) => void) => {
      emit = cb
      return () => {}
    }
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const trace = (spans: Partial<Trace['spans'][number]>[]): Trace =>
  ({
    id: 't1',
    sessionId: 's1',
    title: 'x',
    cwd: '/p',
    model: 'm',
    status: 'running',
    startedAt: 0,
    costUsd: 0,
    tokens: 0,
    spans: spans.map((s, i) => ({ id: 'sp' + i, kind: 'tool', name: 'n', status: 'ok', startedAt: 0, ...s }))
  }) as Trace

describe('LiveActivity — live step feed + stall heartbeat', () => {
  it('renders the running span as the current activity and lists recent steps', () => {
    render(<LiveActivity sessionId="s1" status="" />)
    act(() => {
      emit({
        type: 'trace',
        sessionId: 's1',
        trace: trace([
          { kind: 'llm', name: 'deepseek-chat', status: 'ok', startedAt: 0, endedAt: 1000 },
          { kind: 'tool', name: 'read_file', detail: 'src/x.ts', status: 'running', startedAt: 0 }
        ])
      })
    })
    // current activity (running span) shown in the head AND in the feed
    expect(screen.getAllByText(/read_file · src\/x\.ts/).length).toBeGreaterThanOrEqual(1)
    // the completed llm step appears in the feed
    expect(screen.getByText(/deepseek-chat/)).toBeInTheDocument()
  })

  it('ignores trace events from other sessions', () => {
    render(<LiveActivity sessionId="s1" status="arbeitet" />)
    act(() => {
      emit({ type: 'trace', sessionId: 's2', trace: { ...trace([{ kind: 'tool', name: 'other' }]), sessionId: 's2' } })
    })
    expect(screen.queryByText(/other/)).toBeNull()
  })

  it('flips to a stall warning when a model goes silent past the threshold', () => {
    vi.useFakeTimers()
    try {
      render(<LiveActivity sessionId="s1" status="" />)
      act(() => {
        emit({ type: 'trace', sessionId: 's1', trace: trace([{ kind: 'llm', name: 'm', status: 'running', startedAt: 0 }]) })
      })
      // advance well past STALL_AFTER (25s) with NO further events → heartbeat grows, stall shows
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      expect(screen.getByText(/keine Aktivität/i)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT flag a long-running TOOL as stalled (tools are quiet by design)', () => {
    vi.useFakeTimers()
    try {
      render(<LiveActivity sessionId="s1" status="" />)
      act(() => {
        emit({ type: 'trace', sessionId: 's1', trace: trace([{ kind: 'tool', name: 'run_command', detail: 'npm test', status: 'running', startedAt: 0 }]) })
      })
      act(() => {
        vi.advanceTimersByTime(40_000)
      })
      expect(screen.queryByText(/keine Aktivität/i)).toBeNull()
      expect(screen.getAllByText(/run_command · npm test/).length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
