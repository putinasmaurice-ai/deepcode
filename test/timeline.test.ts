import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'

// Redirect ~/.deepcode to an isolated temp HOME BEFORE paths.ts loads (it reads homedir() at
// module-eval time). vi.hoisted runs before the static imports below. (Same pattern as backup.test.ts.)
const HOME = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp'
  const home = `${base}/dc-timeline-test-${process.pid}`
  process.env.USERPROFILE = home
  process.env.HOME = home
  return home
})

import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../src/main/paths'
import { saveTrace } from '../src/main/trace-store'
import { buildTimeline, buildTickDetail } from '../src/main/timemachine/timeline'
import type { Trace } from '../src/shared/types'

const CFG = join(HOME, '.deepcode')
const SID = `tl${process.pid}`
const CWD = join(CFG, 'proj')

function seedSession(messages: unknown[]): void {
  const s = { id: SID, title: 'T', cwd: CWD, createdAt: 1, updatedAt: 1, messages }
  writeFileSync(join(PATHS.sessions, `${SID}.json`), JSON.stringify(s), 'utf8')
}
function seedCheckpoint(tag: string, snaps: unknown[]): void {
  const d = join(PATHS.root, 'checkpoints', SID)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${tag}.json`), JSON.stringify(snaps), 'utf8')
}
function trace(over: Partial<Trace>): Trace {
  return {
    id: over.id || 'x',
    sessionId: SID,
    title: 't',
    cwd: CWD,
    model: 'm',
    status: 'ok',
    startedAt: 0,
    costUsd: 0,
    tokens: 0,
    spans: [],
    ...over
  } as Trace
}

beforeAll(() => {
  if (PATHS.root !== CFG) throw new Error(`paths not redirected (root=${PATHS.root}) — aborting`)
  mkdirSync(PATHS.sessions, { recursive: true })
  mkdirSync(PATHS.traces, { recursive: true })
  mkdirSync(CWD, { recursive: true })

  // two turns: turn 1 ok @ tick 1000, turn 2 errored @ tick 5000
  saveTrace(
    trace({
      id: 't1',
      turnTag: '1000',
      startedAt: 1000,
      status: 'ok',
      model: 'deepseek-chat',
      costUsd: 0.01,
      tokens: 1234,
      spans: [{ id: 's1', kind: 'tool', name: 'write_file', status: 'ok', startedAt: 1001 }]
    })
  )
  saveTrace(
    trace({
      id: 't2',
      turnTag: '5000',
      startedAt: 5000,
      status: 'error',
      spans: [{ id: 's2', kind: 'tool', name: 'run_command', status: 'error', startedAt: 5001, error: 'boom failed' }]
    })
  )
  // checkpoints: turn 1 has a restorable file; turn 2 only a skipped (>5MB) marker
  seedCheckpoint('1000', [{ path: join(CWD, 'a.txt'), existed: true, content: 'A' }])
  seedCheckpoint('5000', [{ path: join(CWD, 'big.bin'), existed: true, content: '', skipped: true }])
  // messages: the INITIATING prompt of each turn is stamped just BEFORE its tick — nearest-index
  // must still file it onto the turn it began, not the previous tick.
  seedSession([
    { id: 'm1', role: 'user', content: 'frage 1', createdAt: 995 },
    { id: 'm2', role: 'assistant', content: 'antwort 1', createdAt: 1002 },
    { id: 'm3', role: 'user', content: 'frage 2', createdAt: 4998 },
    { id: 'm4', role: 'assistant', content: 'antwort 2', createdAt: 5003 }
  ])
})
afterAll(() => {
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('buildTimeline — fuse traces + checkpoints + messages into one chronological tick list', () => {
  it('collapses the trace-start and the checkpoint-tag-start of one turn into a single tick', () => {
    const tl = buildTimeline(SID)
    // trace.turnTag 1000 and checkpoint tag 1000 are the SAME turn → one tick, not two
    expect(tl.map((t) => t.tick)).toEqual([1000, 5000])
  })

  it('files each message onto its NEAREST tick — including the prompt created just before its turn', () => {
    const tl = buildTimeline(SID)
    // 'frage 2' @4998 is BEFORE tick 5000 but nearer to it than to 1000 → belongs to turn 2
    expect(tl[0].userExcerpt).toBe('frage 1')
    expect(tl[0].assistantExcerpt).toBe('antwort 1')
    expect(tl[0].messageCount).toBe(2)
    expect(tl[1].userExcerpt).toBe('frage 2')
    expect(tl[1].messageCount).toBe(2)
  })

  it('reports per-tick trace stats, restorability and skipped pre-images honestly', () => {
    const tl = buildTimeline(SID)
    expect(tl[0].status).toBe('ok')
    expect(tl[0].toolCount).toBe(1)
    expect(tl[0].costUsd).toBe(0.01)
    expect(tl[0].restorable).toBe(true) // normal pre-image present
    expect(tl[0].checkpointTag).toBe('1000')

    expect(tl[1].status).toBe('error')
    expect(tl[1].topError).toContain('boom')
    expect(tl[1].restorable).toBe(false) // only a skipped marker → not restorable
    expect(tl[1].skippedFiles).toBe(1)
  })

  it('buildTickDetail returns the selected tick with its window messages and is null for an unknown tick', () => {
    const d = buildTickDetail(SID, 1000)
    expect(d).not.toBeNull()
    expect(d!.tick.tick).toBe(1000)
    expect(d!.messages.length).toBe(2)
    expect(buildTickDetail(SID, 999999)).toBeNull()
  })
})
