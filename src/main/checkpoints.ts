import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { PATHS } from './paths'

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
    writeFileSync(file(sessionId, turnTag), JSON.stringify(snaps), 'utf8')
  } catch {
    /* checkpointing must never break the agent */
  }
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
