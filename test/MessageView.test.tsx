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

const userMsg = (over: Record<string, unknown> = {}) =>
  ({ id: 'u1', role: 'user', content: 'hallo', createdAt: Date.UTC(2026, 0, 1, 13, 5), ...over }) as any

describe('MessageView — automatic self-review is not shown as a human "You" message', () => {
  it('labels an auto self-review and suppresses the edit/automate affordances', () => {
    render(<MessageView message={userMsg({ auto: 'self-review' })} toolState={{}} onApprove={() => {}} onEdit={() => {}} onAutomate={() => {}} />)
    expect(screen.getByText(/Automatischer Selbst-Review/)).toBeInTheDocument()
    expect(screen.queryByText('You')).toBeNull()
    expect(screen.queryByTitle(/Bearbeiten & neu senden/)).toBeNull() // no ✏️ on an engine message
    expect(screen.queryByTitle(/als Automation/)).toBeNull() // no ⏰
  })

  it('a normal user message still shows "You" + the edit affordance', () => {
    render(<MessageView message={userMsg()} toolState={{}} onApprove={() => {}} onEdit={() => {}} />)
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByTitle(/Bearbeiten & neu senden/)).toBeInTheDocument()
  })

  it('labels the other auto kinds (verify-fix / prove / compaction)', () => {
    const { rerender } = render(<MessageView message={userMsg({ auto: 'verify-fix' })} toolState={{}} onApprove={() => {}} />)
    expect(screen.getByText(/Auto-Fix nach Verify/)).toBeInTheDocument()
    rerender(<MessageView message={userMsg({ auto: 'compaction' })} toolState={{}} onApprove={() => {}} />)
    expect(screen.getByText(/Kontext verdichtet/)).toBeInTheDocument()
  })
})

describe('MessageView — per-message timestamp', () => {
  it('renders an HH:MM timestamp under a user message', () => {
    render(<MessageView message={userMsg()} toolState={{}} onApprove={() => {}} />)
    // timezone-independent: assert SOME HH:MM time node renders (exact value is locale/TZ-dependent)
    expect(screen.getByText(/^\d{1,2}:\d{2}$/)).toBeInTheDocument()
  })
})
