import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, statSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'
import { Session } from '@shared/types'

// Read-side helpers for the Audit panel and full-text history search.

export interface AuditEntry {
  time: string
  kind: string
  detail: string
}

// Cap how much of the (unbounded) audit.log we pull into memory per open.
const AUDIT_TAIL_BYTES = 256 * 1024

// Read only the trailing slice of a file so we never load the whole log.
function tailRead(file: string, maxBytes: number): string {
  const { size } = statSync(file)
  if (size <= maxBytes) return readFileSync(file, 'utf8')
  const start = size - maxBytes
  const buf = Buffer.alloc(maxBytes)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buf, 0, maxBytes, start)
  } finally {
    closeSync(fd)
  }
  // Drop the leading partial line left by the byte-aligned read.
  const text = buf.toString('utf8')
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(nl + 1)
}

export function listAudit(limit = 300): AuditEntry[] {
  const file = join(PATHS.root, 'audit.log')
  if (!existsSync(file)) return []
  try {
    const lines = tailRead(file, AUDIT_TAIL_BYTES).trim().split('\n')
    return lines
      .slice(-limit)
      .map((l) => {
        const [time, kind, ...rest] = l.split('\t')
        return { time, kind: kind ?? '?', detail: rest.join('\t') }
      })
      .reverse()
  } catch {
    return []
  }
}

export interface SearchHit {
  sessionId: string
  title: string
  snippet: string
  updatedAt: number
}

// Case-insensitive full-text search across all stored session transcripts.
export function searchSessions(query: string, maxHits = 20): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (q.length < 3) return []
  const hits: SearchHit[] = []
  let files: string[] = []
  try {
    files = readdirSync(PATHS.sessions).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  for (const f of files) {
    if (hits.length >= maxHits) break
    try {
      const s = JSON.parse(readFileSync(join(PATHS.sessions, f), 'utf8')) as Session
      for (const m of s.messages ?? []) {
        if (m.role !== 'user' && m.role !== 'assistant') continue
        const idx = m.content.toLowerCase().indexOf(q)
        if (idx === -1) continue
        const start = Math.max(0, idx - 40)
        const snippet =
          (start > 0 ? '…' : '') +
          m.content.slice(start, idx + q.length + 60).replace(/\s+/g, ' ') +
          '…'
        hits.push({ sessionId: s.id, title: s.title || 'Untitled', snippet, updatedAt: s.updatedAt })
        break // one hit per session is enough for the list
      }
    } catch {
      /* skip corrupt */
    }
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt)
}
