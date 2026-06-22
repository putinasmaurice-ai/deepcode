// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SessionRow } from '../src/renderer/src/components/SessionRow'
import type { Session } from '../src/shared/types'

afterEach(cleanup)

const sess = (over: Partial<Session> = {}): Session =>
  ({ id: 's1', title: 'My chat', cwd: '/home/u/proj', createdAt: 1, updatedAt: 1, messages: [], ...over }) as Session

const handlers = () => ({
  onRenameText: vi.fn(),
  onOpen: vi.fn(),
  onDelete: vi.fn(),
  onStartRename: vi.fn(),
  onCommitRename: vi.fn(),
  onCancelRename: vi.fn()
})

describe('SessionRow — visible rename affordance + inline edit', () => {
  it('shows a rename (✎) and delete (✕) button; the rename button is discoverable', () => {
    const h = handlers()
    render(<SessionRow session={sess()} active={false} renaming={false} renameText="" {...h} />)
    expect(screen.getByLabelText(/umbenennen/)).toBeInTheDocument()
    expect(screen.getByLabelText(/löschen/)).toBeInTheDocument()
  })

  it('clicking ✎ starts rename with (id, title) and does NOT open the chat', () => {
    const h = handlers()
    render(<SessionRow session={sess()} active={false} renaming={false} renameText="" {...h} />)
    fireEvent.click(screen.getByLabelText(/umbenennen/))
    expect(h.onStartRename).toHaveBeenCalledWith('s1', 'My chat')
    expect(h.onOpen).not.toHaveBeenCalled() // stopPropagation keeps the row from opening
  })

  it('clicking ✕ deletes and does NOT open the chat', () => {
    const h = handlers()
    render(<SessionRow session={sess()} active={false} renaming={false} renameText="" {...h} />)
    fireEvent.click(screen.getByLabelText(/löschen/))
    expect(h.onDelete).toHaveBeenCalledWith('s1')
    expect(h.onOpen).not.toHaveBeenCalled()
  })

  it('clicking the row body opens the chat', () => {
    const h = handlers()
    render(<SessionRow session={sess()} active={false} renaming={false} renameText="" {...h} />)
    fireEvent.click(screen.getByText('My chat'))
    expect(h.onOpen).toHaveBeenCalledWith('s1')
  })

  it('F2 on the row starts rename', () => {
    const h = handlers()
    render(<SessionRow session={sess()} active={false} renaming={false} renameText="" {...h} />)
    fireEvent.keyDown(screen.getByText('My chat').closest('.session-item')!, { key: 'F2' })
    expect(h.onStartRename).toHaveBeenCalledWith('s1', 'My chat')
  })

  it('while renaming: shows the inline input, hides ✎, commits on Enter and cancels on Escape', () => {
    const h = handlers()
    render(<SessionRow session={sess()} active={false} renaming renameText="My chat" {...h} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('My chat')
    expect(screen.queryByLabelText(/umbenennen/)).toBeNull() // pencil hidden during edit
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h.onCommitRename).toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(h.onCancelRename).toHaveBeenCalled()
  })

  it('renaming input commits on blur and does not open the chat on its own click', () => {
    const h = handlers()
    render(<SessionRow session={sess()} active renaming renameText="x" {...h} />)
    const input = screen.getByRole('textbox')
    fireEvent.click(input)
    fireEvent.blur(input)
    expect(h.onCommitRename).toHaveBeenCalled()
    expect(h.onOpen).not.toHaveBeenCalled()
  })
})
