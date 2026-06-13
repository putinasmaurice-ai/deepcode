import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS, ensureConfigDirs, safeId } from './paths'
import { Trace } from '@shared/types'

// Persistence for agent run-traces — one JSON per turn under ~/.deepcode/traces/.
// Mirrors workflows/store.ts (atomic tmp+rename, slug-guarded id, count-capped prune
// at terminal state). The recorder writes here incrementally; the Trace panel reads it.

const MAX_TRACES = 300 // keep the newest N trace files; older ones are pruned

// ids of traces still 'running' in THIS process — so prune can skip a live file by NAME
// without reading+parsing every file's body just to check its status (the prune ran once per
// turn-end and was O(files) heavy sync I/O on the main thread).
const runningIds = new Set<string>()

function atomicWrite(path: string, data: unknown): void {
  ensureConfigDirs()
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data), 'utf8')
    renameSync(tmp, path)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best-effort cleanup */
    }
    throw e
  }
}

const tracePath = (id: string): string => join(PATHS.traces, `${safeId(id)}.json`)

// Drop the oldest trace files once the dir exceeds MAX_TRACES. Never prunes a trace that is
// still 'running' in this process (its file is the live record). Prunes purely by statSync
// mtime — NO readFileSync/JSON.parse — so it's O(files) cheap stats, not O(files) parses.
function pruneTraces(): void {
  try {
    const files = readdirSync(PATHS.traces).filter((f) => f.endsWith('.json'))
    if (files.length <= MAX_TRACES) return
    const withTime = files
      .filter((f) => !runningIds.has(f.replace(/\.json$/, ''))) // skip live files by name
      .map((f) => {
        const full = join(PATHS.traces, f)
        let mtime = 0
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          /* unreadable → mtime 0 → pruned first */
        }
        return { full, mtime }
      })
      .sort((a, b) => a.mtime - b.mtime) // oldest first
    const excess = files.length - MAX_TRACES
    for (const { full } of withTime.slice(0, excess)) {
      try {
        unlinkSync(full)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export function saveTrace(trace: Trace): void {
  if (trace.status === 'running') runningIds.add(trace.id)
  else runningIds.delete(trace.id)
  try {
    atomicWrite(tracePath(trace.id), trace)
  } catch {
    /* a trace write must never break a turn */
    return
  }
  if (trace.status !== 'running') pruneTraces()
}

export function getTrace(id: string): Trace | null {
  const p = tracePath(id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Trace
  } catch {
    return null
  }
}

// Most recent traces (optionally for one session), capped for the trace UI.
export function listTraces(sessionId?: string, limit = 80): Trace[] {
  if (!existsSync(PATHS.traces)) return []
  const out: Trace[] = []
  for (const f of readdirSync(PATHS.traces)) {
    if (!f.endsWith('.json')) continue
    try {
      const t = JSON.parse(readFileSync(join(PATHS.traces, f), 'utf8')) as Trace
      if (!sessionId || t.sessionId === sessionId) out.push(t)
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}
