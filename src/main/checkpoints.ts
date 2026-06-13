import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { PATHS } from './paths'

// keep at most this many turn-snapshots per session; older ones are pruned so the
// checkpoints dir can't grow without bound on heavy use.
const MAX_TURN_TAGS = 100

// File checkpoints: before the agent modifies a file, the prior state is
// snapshotted under ~/.deepcode/checkpoints/<sessionId>/<turnTag>.json.
// /rewind restores the most recent turn's snapshots (undo the last turn).

interface Snapshot {
  path: string
  existed: boolean
  content: string
}

function dir(sessionId: string): string {
  return join(PATHS.root, 'checkpoints', sessionId)
}

function file(sessionId: string, turnTag: string): string {
  return join(dir(sessionId), `${turnTag}.json`)
}

function load(sessionId: string, turnTag: string): Snapshot[] {
  const f = file(sessionId, turnTag)
  if (!existsSync(f)) return []
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Snapshot[]
  } catch {
    return []
  }
}

// Record the pre-modification state of a file (first write per turn wins).
export function recordSnapshot(sessionId: string, turnTag: string, absPath: string): void {
  try {
    const snaps = load(sessionId, turnTag)
    if (snaps.some((s) => s.path === absPath)) return // keep the earliest state
    const existed = existsSync(absPath)
    let content = ''
    if (existed) {
      try {
        content = readFileSync(absPath, 'utf8')
      } catch {
        return // unreadable (binary/locked) — skip rather than corrupt
      }
      if (content.length > 5_000_000) return
    }
    snaps.push({ path: absPath, existed, content })
    mkdirSync(dir(sessionId), { recursive: true })
    // atomic write (tmp + rename) so a crash mid-write can't corrupt an undo point
    const target = file(sessionId, turnTag)
    const tmp = target + '.tmp'
    writeFileSync(tmp, JSON.stringify(snaps), 'utf8')
    renameSync(tmp, target)
    pruneOldTags(sessionId)
  } catch {
    /* checkpointing must never break the agent */
  }
}

// Drop the oldest turn snapshots beyond the retention cap.
function pruneOldTags(sessionId: string): void {
  const tags = listTurnTags(sessionId)
  if (tags.length <= MAX_TURN_TAGS) return
  for (const tag of tags.slice(0, tags.length - MAX_TURN_TAGS)) {
    try {
      rmSync(file(sessionId, tag))
    } catch {
      /* ignore */
    }
  }
}

// Remove all checkpoints for a session (called when the session/project is deleted)
// so deleted chats don't leave snapshot directories behind forever.
export function deleteSessionCheckpoints(sessionId: string): void {
  try {
    rmSync(dir(sessionId), { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

// Which files were touched in a given turn (for changelog generation).
export function getTurnFiles(sessionId: string, turnTag: string): string[] {
  return load(sessionId, turnTag).map((s) => s.path)
}

export function listTurnTags(sessionId: string): string[] {
  const d = dir(sessionId)
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
}

// Restore the latest checkpoint turn; returns the restored file paths.
export function rewindLastTurn(sessionId: string): string[] {
  const tags = listTurnTags(sessionId)
  if (!tags.length) return []
  const tag = tags[tags.length - 1]
  const snaps = load(sessionId, tag)
  const restored: string[] = []
  for (const s of snaps) {
    try {
      if (s.existed) {
        mkdirSync(dirname(s.path), { recursive: true })
        writeFileSync(s.path, s.content, 'utf8')
      } else if (existsSync(s.path)) {
        rmSync(s.path)
      }
      restored.push(s.path)
    } catch {
      /* best effort per file */
    }
  }
  try {
    rmSync(file(sessionId, tag))
  } catch {
    /* ignore */
  }
  return restored
}
