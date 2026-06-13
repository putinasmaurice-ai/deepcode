import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../paths'
import { loadMemory } from './memory'
import { embed, cosine } from '../embeddings'
import { MemoryEntry } from '@shared/types'

// Builds the memory section injected into the system prompt. Two modes:
//  - small store (<= INLINE_ALL): inject every (scoped) entry's index line — cheap, no embed.
//  - large store: embed the query + candidate entries (local embeddings) and inject only the
//    TOP-K most relevant, plus always the standing user/feedback rules. Falls back to "inject
//    all (capped)" if embeddings are unavailable — i.e. never worse than the old behaviour.
// Project scoping: a memory with a projectId only applies to that project; others are global.

const INLINE_ALL = 12 // at/below this many scoped memories, skip embeddings entirely
const TOP_K = 8
const MIN_SIM = 0.15
const CAP = 4000

interface EmbedSettings {
  localBaseUrl?: string
  embeddingModel?: string
}

interface CacheEntry {
  hash: number
  vec: number[]
}
interface CacheFile {
  model: string
  entries: Record<string, CacheEntry>
}
const CACHE_FILE = join(PATHS.memory, '.mem-embeddings.json')
const EMBED_TIMEOUT_MS = 2000 // fail-soft fast: a hung endpoint must not stall the turn

function resolveModel(s: EmbedSettings): string {
  return (s.embeddingModel || 'nomic-embed-text').replace(/^local:/, '')
}
function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h
}
function memText(e: MemoryEntry): string {
  return `${e.name}\n${e.description}\n${e.body}`.slice(0, 2000)
}
function indexLine(e: MemoryEntry): string {
  return `- [${e.name}](${e.name}.md) — ${e.description}`
}
// Cache is keyed by the embedding model — vectors from a different model live in a different
// space, so on a model switch we drop the cache (mirrors the code-search index rebuild).
function loadCache(model: string): Record<string, CacheEntry> {
  try {
    if (existsSync(CACHE_FILE)) {
      const f = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CacheFile
      if (f && f.model === model && f.entries) return f.entries
    }
  } catch {
    /* ignore corrupt cache */
  }
  return {}
}
// short, turn-signal-composed deadline so a reachable-but-hung endpoint aborts fast
function embedSignal(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(EMBED_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, t]) : t
}

// Memories visible in this context = global (no projectId) + the current project's.
export function scopedMemories(projectId?: string): MemoryEntry[] {
  return loadMemory().filter((e) => !e.projectId || e.projectId === projectId)
}

// Returns the memory text to inject (index lines), semantically narrowed when the store is
// large. NEVER throws — on any embedding error it returns the full (capped) scoped index.
export async function buildMemoryContext(query: string, projectId: string | undefined, settings: EmbedSettings, signal?: AbortSignal): Promise<string> {
  // the scoped load (readdirSync) is itself inside the try — a memory-dir read error must return
  // '' (inject nothing), NEVER throw and let the prompt fall back to the UNSCOPED global index.
  let scoped: MemoryEntry[]
  try {
    scoped = scopedMemories(projectId)
  } catch {
    return ''
  }
  if (!scoped.length) return ''
  const all = (): string => scoped.map(indexLine).join('\n').slice(0, CAP)
  if (scoped.length <= INLINE_ALL || !query.trim()) return all()

  try {
    // standing rules are always relevant — pin them, embed-rank only the rest
    const pinned = scoped.filter((e) => e.type === 'user' || e.type === 'feedback')
    const candidates = scoped.filter((e) => e.type !== 'user' && e.type !== 'feedback')
    if (!candidates.length) return all()

    const model = resolveModel(settings)
    const cache = loadCache(model)
    const misses = candidates.filter((e) => cache[e.name]?.hash !== djb2(memText(e)))
    if (misses.length) {
      const vecs = await embed(misses.map(memText), settings, embedSignal(signal))
      misses.forEach((e, i) => {
        const v = vecs[i]
        if (Array.isArray(v) && v.length) cache[e.name] = { hash: djb2(memText(e)), vec: v } // skip holes
      })
    }
    const [qVec] = await embed([query.slice(0, 2000)], settings, embedSignal(signal))
    if (!qVec) return all()
    // rebuild the persisted cache from ONLY the current candidates → prunes deleted/renamed
    // entries (and drops any poisoned holes), keyed by the current model.
    const next: Record<string, CacheEntry> = {}
    for (const e of candidates) if (cache[e.name]?.vec?.length) next[e.name] = cache[e.name]!
    // atomic write (pid-suffixed tmp + rename): a plain writeFileSync of this shared global file
    // can be torn by a second window/session writing concurrently, corrupting the cache.
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ model, entries: next } satisfies CacheFile), 'utf8')
      renameSync(tmp, CACHE_FILE)
    } catch {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
    const ranked = candidates
      .map((e) => ({ e, score: cache[e.name]?.vec?.length ? cosine(qVec, cache[e.name]!.vec) : 0 }))
      .filter((r) => r.score >= MIN_SIM)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .map((r) => r.e)
    const selected = [...pinned, ...ranked]
    if (!selected.length) return all()
    return selected.map(indexLine).join('\n').slice(0, CAP)
  } catch {
    return all() // embeddings unavailable → behave exactly like before (inject all, capped)
  }
}
