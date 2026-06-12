import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'
import { Session } from '@shared/types'

// Read-side helpers for the Audit panel and full-text history search.

export interface AuditEntry {
  time: string
  kind: string
  detail: string
}

export function listAudit(limit = 300): AuditEntry[] {
  const file = join(PATHS.root, 'audit.log')
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n')
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
