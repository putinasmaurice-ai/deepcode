import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { PATHS } from '../paths'

// Persistent key/value store for the workflow `store` node — the missing piece for stateful
// automations (dedup, "already sent?", counters, poll-since cursors) that survive across runs.
// One small JSON file under ~/.deepcode/workflows/kv.json, atomic-written.

const FILE = join(PATHS.workflows, 'kv.json')
let cache: Record<string, string> | null = null

function load(): Record<string, string> {
  if (cache) return cache
  try {
    if (existsSync(FILE)) {
      const o = JSON.parse(readFileSync(FILE, 'utf8'))
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        cache = o as Record<string, string>
        return cache
      }
    }
  } catch {
    /* corrupt → start empty */
  }
  cache = {}
  return cache
}

function persist(): void {
  if (!cache) return
  const tmp = `${FILE}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(cache), 'utf8')
    renameSync(tmp, FILE)
  } catch (err) {
    // surface a failed write — clean up the tmp file, then RETHROW so the calling
    // `store` node fails loudly instead of silently losing data. The cache may now
    // hold an unpersisted change; the next load() reconciles from disk.
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore cleanup failure */
    }
    throw err
  }
}

export const kvStore = {
  get: (key: string): string => load()[key] ?? '',
  has: (key: string): boolean => key in load(),
  set: (key: string, value: string): string => {
    // cap the stored value so a `store set {{last}}` of a multi-MB body can't bloat kv.json
    // (the whole file is rewritten on every set/incr/del).
    const v = String(value).slice(0, 64_000)
    const m = load()
    m[key] = v
    persist()
    return v
  },
  del: (key: string): void => {
    const m = load()
    if (key in m) {
      delete m[key]
      persist()
    }
  },
  incr: (key: string, by = 1): number => {
    const m = load()
    const n = (Number(m[key]) || 0) + (Number.isFinite(by) ? by : 1)
    m[key] = String(n)
    persist()
    return n
  }
}
