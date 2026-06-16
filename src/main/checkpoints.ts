import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { PATHS, safeId } from './paths'

// keep at most this many turn-snapshots per session; older ones are pruned so the
// checkpoints dir can't grow without bound on heavy use.
const MAX_TURN_TAGS = 100

// File checkpoints: before the agent modifies a file, the prior state is
// snapshotted under ~/.deepcode/checkpoints/<sessionId>/<turnTag>.json.
// /rewind restores the most recent turn's snapshots (undo the last turn).

export interface Snapshot {
  path: string
  existed: boolean
  content: string
  // a file the snapshotter could NOT capture (unreadable/locked or >5MB) — recorded as a marker
  // (never as real content) so consumers know the pre-image is missing. rewind NEVER writes these
  // (would zero a large/binary file); proveRedFirst abstains when a source is skipped.
  skipped?: boolean
}

function dir(sessionId: string): string {
  // safeId rejects a traversal sessionId before it can reach the recursive force rmSync
  // in deleteSessionCheckpoints (arbitrary directory-tree deletion otherwise).
  return join(PATHS.root, 'checkpoints', safeId(sessionId))
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
    let skipped = false
    if (existed) {
      try {
        content = readFileSync(absPath, 'utf8')
      } catch {
        skipped = true // unreadable (locked) — record a marker, never corrupt with empty content
      }
      if (!skipped && content.length > 5_000_000) {
        skipped = true
        content = ''
      }
    }
    snaps.push(skipped ? { path: absPath, existed, content: '', skipped: true } : { path: absPath, existed, content })
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

// Full pre-change snapshots (path + existed + pre-image content) for a turn — used by the
// red-first prover to temporarily revert the turn's changes and confirm a synthesized test
// actually FAILS against the old code (so it discriminates the new behaviour).
export function getTurnSnapshots(sessionId: string, turnTag: string): Snapshot[] {
  return load(sessionId, turnTag)
}

export function listTurnTags(sessionId: string): string[] {
  const d = dir(sessionId)
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
}

// Cheap per-file metadata for a turn's checkpoint — path + existed + skipped, WITHOUT the
// (potentially large) pre-image content. The Time Machine timeline needs only this to render a
// turn's touched-file list; loading full content for every tick would be wasteful.
export interface SnapshotMeta {
  path: string
  existed: boolean
  skipped: boolean
}

// Read the turn's snapshot json and drop the content field — used to build the timeline cheaply.
export function getTurnSnapshotMeta(sessionId: string, turnTag: string): SnapshotMeta[] {
  return load(sessionId, turnTag).map((s) => ({ path: s.path, existed: s.existed, skipped: !!s.skipped }))
}

// Restore the latest checkpoint turn; returns the restored file paths.
export function rewindLastTurn(sessionId: string): string[] {
  const tags = listTurnTags(sessionId)
  if (!tags.length) return []
  const tag = tags[tags.length - 1]
  const snaps = load(sessionId, tag)
  const restored: string[] = []
  for (const s of snaps) {
    if (s.skipped) continue // no pre-image captured — must NOT overwrite the (large/binary) file
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
