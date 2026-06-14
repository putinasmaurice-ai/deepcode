import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../src/main/paths'
import { saveSessionSoon, flushSession, deleteSession } from '../src/main/store'
import type { Session } from '../src/shared/types'

// MED-34: the engine calls saveSession ~100x/turn. saveSessionSoon coalesces those into one
// disk write per ~600ms window (metadata cache stays current immediately); flushSession forces
// a pending write out NOW (runTurn's finally → completed turns always persist); deleting a
// session cancels a queued write so it can't resurrect the file.

let counter = 0
let id = ''

function makeSession(sid: string): Session {
  return { id: sid, title: 'debounce-test', cwd: process.cwd(), messages: [], createdAt: 1, updatedAt: 1 } as Session
}
function sessionFile(sid: string): string {
  return join(PATHS.sessions, `${sid}.json`)
}

describe('session write debounce (MED-34)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    id = `dc-debounce-${process.pid}-${counter++}` // unique per test (deleteSession tombstones an id)
  })
  afterEach(() => {
    vi.useRealTimers()
    try {
      if (existsSync(sessionFile(id))) unlinkSync(sessionFile(id))
    } catch {
      /* best effort */
    }
  })

  it('does not write immediately, but writes after the debounce window', () => {
    saveSessionSoon(makeSession(id))
    expect(existsSync(sessionFile(id))).toBe(false) // deferred
    vi.advanceTimersByTime(700)
    expect(existsSync(sessionFile(id))).toBe(true) // flushed after >600ms
  })

  it('flushSession writes immediately', () => {
    const s = makeSession(id)
    saveSessionSoon(s)
    flushSession(s)
    expect(existsSync(sessionFile(id))).toBe(true)
  })

  it('a re-armed saveSessionSoon coalesces into a single delayed write', () => {
    const s = makeSession(id)
    saveSessionSoon(s)
    vi.advanceTimersByTime(300)
    saveSessionSoon(s) // re-arms the window
    vi.advanceTimersByTime(400) // 700ms since first call, but only 400ms since the re-arm
    expect(existsSync(sessionFile(id))).toBe(false) // window restarted → not yet written
    vi.advanceTimersByTime(300)
    expect(existsSync(sessionFile(id))).toBe(true)
  })

  it('deleteSession cancels a pending debounced write', () => {
    saveSessionSoon(makeSession(id))
    deleteSession(id)
    vi.advanceTimersByTime(2000)
    expect(existsSync(sessionFile(id))).toBe(false) // queued write was cancelled, file never resurrected
  })
})
