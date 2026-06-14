import { existsSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'

// Crash-safe file write: write to a unique tmp sibling, then atomically rename over the
// target. A torn write can therefore never truncate the real file — a crash mid-write
// leaves the old file intact plus an orphan tmp (cleaned up on the failure path). The tmp
// name uses randomUUID (not the pid) so two writes to the same target within one process
// can't collide. Mirrors the long-standing pattern in workflows/store.ts. Rethrows on
// failure so callers surface a real write error instead of silently losing data.
export function atomicWriteText(path: string, content: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
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

export function atomicWriteJson(path: string, data: unknown): void {
  atomicWriteText(path, JSON.stringify(data, null, 2))
}
