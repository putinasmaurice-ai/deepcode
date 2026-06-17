// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MessageView } from '../src/renderer/src/components/MessageView'

beforeAll(() => {
  // MessageView reads window.deepcode.previewDiff inside a (here-unused) pending-file effect
  ;(window as any).deepcode = { previewDiff: async () => null }
})
afterEach(cleanup)

// an assistant message whose tool call never got a result (an interrupted/reloaded turn)
const msg = () =>
  ({ id: 'a1', role: 'assistant', content: '', createdAt: 1, toolCalls: [{ id: 't1', name: 'mcp__x__think', arguments: '{}' }] }) as any

describe('MessageView tool-call status — interrupted turn must not show "running" forever', () => {
  it('shows "abgebrochen" for a resultless tool call when NOT live (the ghost bug)', () => {
    render(<MessageView message={msg()} toolState={{}} onApprove={() => {}} live={false} />)
    expect(screen.getByText(/abgebrochen/)).toBeInTheDocument()
    expect(screen.queryByText(/● running/)).toBeNull()
  })

  it('shows "running" for a resultless tool call WHILE live (turn actually in flight)', () => {
    render(<MessageView message={msg()} toolState={{}} onApprove={() => {}} live={true} />)
    expect(screen.getByText(/● running/)).toBeInTheDocument()
  })

  it('shows "done" once a successful result arrives (regardless of live)', () => {
    render(
      <MessageView message={msg()} toolState={{ t1: { result: { ok: true, content: 'ok' } } }} onApprove={() => {}} live={false} />
    )
    expect(screen.getByText(/done/)).toBeInTheDocument()
  })
})
