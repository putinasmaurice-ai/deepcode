import { existsSync, readFileSync } from 'fs'
import { relative, sep } from 'path'
import { listTurnTags, getTurnSnapshots, Snapshot } from '../checkpoints'
import { getSession } from '../store'
import { lineDiff } from '../agent/tools/fs'

// Time Machine reconstruction: derive the repository state JUST BEFORE a past turn ran, and a
// human-readable diff of what that turn CHANGED — purely from the persisted per-turn FS
// checkpoints (pre-image snapshots). Best-effort, never throws into a turn.

export interface ReconstructedFile {
  path: string // absolute path
  rel: string // path relative to the session cwd (for display)
  existed: boolean // did the file exist at the tick (per its pre-image)?
  content: string // the pre-image content (empty when skipped or non-existent)
  skipped: boolean // pre-image NOT captured (locked / >5MB) → NOT reconstructable
}

const MAX_DIFF = 60_000 // cap total diff output so one huge turn can't blow up the renderer

function relOf(cwd: string, abs: string): string {
  if (!cwd) return abs
  try {
    return relative(cwd, abs).split(sep).join('/')
  } catch {
    return abs
  }
}

// The repo state immediately BEFORE the turn at `tick` ran. A checkpoint stores the pre-image of
// each file the FIRST time a turn touches it, so the OLDEST qualifying pre-image (smallest tag
// >= tick) is the file's state at the tick. We walk tags NEWEST→OLDEST and let the oldest win.
export function reconstructStateBefore(sessionId: string, tick: number): ReconstructedFile[] {
  const session = getSession(sessionId)
  const cwd = session?.cwd ?? ''
  let tags: string[] = []
  try {
    tags = listTurnTags(sessionId).filter((t) => Number.isFinite(Number(t)) && Number(t) >= tick)
  } catch {
    return []
  }
  // listTurnTags is ascending; iterate descending so the oldest (>= tick) pre-image overwrites
  // any newer one for the same path — that oldest pre-image is the file's state at the tick.
  const byPath = new Map<string, Snapshot>()
  for (let i = tags.length - 1; i >= 0; i--) {
    let snaps: Snapshot[] = []
    try {
      snaps = getTurnSnapshots(sessionId, tags[i])
    } catch {
      snaps = []
    }
    for (const s of snaps) byPath.set(s.path, s)
  }
  const out: ReconstructedFile[] = []
  for (const [path, s] of byPath) {
    out.push({
      path,
      rel: relOf(cwd, path),
      existed: s.existed,
      content: s.skipped ? '' : s.content,
      skipped: !!s.skipped
    })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

// The AFTER text of a file the turn at `tick` touched: its pre-image in the FIRST later turn that
// touched the same path (that later turn's pre-image == this turn's result), else the current
// on-disk content (best-effort), else '' (deleted / unknown).
function afterText(sessionId: string, path: string, laterTags: string[]): string {
  for (const t of laterTags) {
    let snaps: Snapshot[] = []
    try {
      snaps = getTurnSnapshots(sessionId, t)
    } catch {
      snaps = []
    }
    const hit = snaps.find((s) => s.path === path)
    if (hit) return hit.skipped ? '' : hit.content
  }
  try {
    if (existsSync(path)) return readFileSync(path, 'utf8')
  } catch {
    /* unreadable on disk — fall through */
  }
  return ''
}

// A unified, line-based diff of what the turn at `tick` CHANGED. BEFORE = each touched file's
// pre-image; AFTER = the next later pre-image of that path, else current on-disk content. Pure
// best-effort; skipped pre-images are noted, not faked.
export function buildTickDiff(sessionId: string, tick: number): string {
  const session = getSession(sessionId)
  const cwd = session?.cwd ?? ''
  let tags: string[] = []
  try {
    tags = listTurnTags(sessionId)
  } catch {
    return ''
  }
  const tag = tags.find((t) => Number(t) === tick)
  if (!tag) return ''
  const laterTags = tags.filter((t) => Number(t) > tick).sort((a, b) => Number(a) - Number(b))
  let snaps: Snapshot[] = []
  try {
    snaps = getTurnSnapshots(sessionId, tag)
  } catch {
    return ''
  }
  const blocks: string[] = []
  let total = 0
  for (const s of snaps) {
    const rel = relOf(cwd, s.path)
    let body: string
    if (s.skipped) {
      body = '(>5MB / nicht erfassbar — kein Pre-Image)'
    } else {
      const before = s.existed ? s.content : ''
      const after = afterText(sessionId, s.path, laterTags)
      body = lineDiff(before, after).diff || '(keine Textänderung)'
    }
    const block = `--- a/${rel}\n+++ b/${rel}\n${body}`
    if (total + block.length > MAX_DIFF) {
      blocks.push(`… (Diff bei ${MAX_DIFF} Zeichen gekürzt)`)
      break
    }
    blocks.push(block)
    total += block.length + 1
  }
  return blocks.join('\n\n')
}
