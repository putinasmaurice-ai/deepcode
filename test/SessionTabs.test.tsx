// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SessionTabs } from '../src/renderer/src/components/SessionTabs'
import type { Session } from '../src/shared/types'

afterEach(cleanup)

function tab(id: string, title: string): Session {
  return { id, title, cwd: '/x', createdAt: 1, updatedAt: 1, messages: [] } as Session
}
const TABS = [tab('a', 'Alpha'), tab('b', 'Beta'), tab('c', 'Gamma')]

function renderTabs(over: Partial<Parameters<typeof SessionTabs>[0]> = {}) {
  const props = {
    tabs: TABS,
    activeId: 'a',
    running: new Set<string>(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onReorder: vi.fn(),
    ...over
  }
  render(<SessionTabs {...props} />)
  return props
}

describe('SessionTabs (renderer — validates the jsdom test foundation too)', () => {
  it('renders a tab per session and marks the active one', () => {
    renderTabs()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
    expect(screen.getByText('Alpha').closest('.session-tab')).toHaveClass('active')
  })

  it('clicking a tab selects it; clicking ✕ closes WITHOUT selecting (stopPropagation)', () => {
    const p = renderTabs()
    fireEvent.click(screen.getByText('Beta'))
    expect(p.onSelect).toHaveBeenCalledWith('b')

    const closeOnGamma = screen.getByText('Gamma').closest('.session-tab')!.querySelector('.tab-close')!
    fireEvent.click(closeOnGamma)
    expect(p.onClose).toHaveBeenCalledWith('c')
    expect(p.onSelect).toHaveBeenCalledTimes(1) // close did NOT also fire select
  })

  it('shows a pulse only on a running tab and fires onNew from the + button', () => {
    const p = renderTabs({ running: new Set(['b']) })
    const beta = screen.getByText('Beta').closest('.session-tab')!
    const alpha = screen.getByText('Alpha').closest('.session-tab')!
    expect(beta.querySelector('.tab-pulse')).toBeTruthy()
    expect(alpha.querySelector('.tab-pulse')).toBeNull()

    fireEvent.click(screen.getByLabelText('Neuer Chat'))
    expect(p.onNew).toHaveBeenCalledTimes(1)
  })

  it('drag-and-drop reorders via onReorder(from,to)', () => {
    const p = renderTabs()
    const alpha = screen.getByText('Alpha').closest('.session-tab')!
    const gamma = screen.getByText('Gamma').closest('.session-tab')!
    fireEvent.dragStart(alpha)
    fireEvent.dragOver(gamma)
    fireEvent.drop(gamma)
    expect(p.onReorder).toHaveBeenCalledWith(0, 2)
  })
})
