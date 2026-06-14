import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, relative, sep, extname } from 'path'
import { createHash } from 'crypto'
import { PATHS } from './paths'

// Local, free semantic code search: chunk the project, embed each chunk via the local
// (Ollama/LM Studio) embeddings endpoint, and return the top-k most relevant chunks for
// a query — so the agent sends a targeted question and gets the few relevant snippets
// instead of reading whole files (the biggest input-token lever on large repos).
// The index is incremental (only changed files are re-embedded) and cached in memory.

const NUL = String.fromCharCode(0)
const INDEX_DIR = join(PATHS.root, 'index')
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.scss', '.html',
  '.py', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.sh', '.yml', '.yaml', '.toml', '.sql', '.txt', '.vue', '.svelte'
])
const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', 'release', 'build', '.deepcode', 'tools', '.next', 'coverage'])
const MAX_FILES = 1500
const MAX_CHUNKS = 4000
const MAX_FILE_BYTES = 200_000
const CHUNK_LINES = 40
const CHUNK_OVERLAP = 8
const BATCH = 64

export interface Chunk {
  file: string // repo-relative, forward slashes
  startLine: number // 1-based
  text: string
}

// ---- pure helpers (unit-tested) ----

export function chunkLines(text: string, file: string, size = CHUNK_LINES, overlap = CHUNK_OVERLAP): Chunk[] {
  const lines = text.split('\n')
  const step = Math.max(1, size - overlap)
  const out: Chunk[] = []
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + size)
    if (slice.join('\n').trim()) out.push({ file, startLine: i + 1, text: slice.join('\n').slice(0, 4000) })
    if (i + size >= lines.length) break
  }
  return out
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0 // mismatched dims would silently corrupt ranking — skip
  let dot = 0
  let na = 0
  let nb = 0
  const n = a.length
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---- embedding (local endpoint) ----

interface Settingsish {
  localBaseUrl?: string
  embeddingModel?: string
}

function embedModel(s: Settingsish): string {
  return (s.embeddingModel || 'nomic-embed-text').replace(/^local:/, '')
}

export async function embed(texts: string[], s: Settingsish, signal?: AbortSignal): Promise<number[][]> {
  if (!texts.length) return []
  const base = (s.localBaseUrl || 'http://localhost:11434/v1').replace(/\/$/, '')
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embedModel(s), input: texts }),
    signal
  })
  if (!res.ok) throw new Error(`embeddings endpoint ${res.status} (model "${embedModel(s)}" pulled? local server running?)`)
  const json = (await res.json()) as { data?: { embedding: number[]; index?: number }[] }
  if (!json.data?.length) throw new Error('embeddings endpoint returned no vectors')
  // pairing safety: a vector count != input count would silently misalign chunks↔vectors
  if (json.data.length !== texts.length) {
    throw new Error(`embeddings count mismatch: sent ${texts.length}, got ${json.data.length}`)
  }
  // honor the OpenAI-style `index` field when present, else trust order
  const out = new Array<number[]>(texts.length)
  json.data.forEach((d, i) => {
    out[typeof d.index === 'number' && d.index >= 0 && d.index < texts.length ? d.index : i] = d.embedding
  })
  return out
}

// ---- index build + cache ----

interface IndexedChunk {
  file: string
  startLine: number
  text: string
  vec: number[]
}
interface IndexFile {
  model: string
  files: Record<string, number> // repo-relative path -> mtimeMs at index time
  chunks: IndexedChunk[]
}

const INDEX_PATH = (cwd: string): string => join(INDEX_DIR, createHash('sha1').update(cwd).digest('hex') + '.json')
const memCache = new Map<string, IndexFile>() // cwd -> index (avoids re-parsing the big JSON each search)

// Bound the in-memory index map: evict the oldest cwd before inserting once size exceeds 8
// (scanCache is capped at 16; without this a long-lived process opening many cwds grows it forever).
function setMemCache(cwd: string, idx: IndexFile): void {
  if (!memCache.has(cwd) && memCache.size >= 8) memCache.delete(memCache.keys().next().value as string)
  memCache.set(cwd, idx)
}

function loadIndex(cwd: string): IndexFile | null {
  const cached = memCache.get(cwd)
  if (cached) return cached
  const p = INDEX_PATH(cwd)
  if (!existsSync(p)) return null
  try {
    const idx = JSON.parse(readFileSync(p, 'utf8')) as IndexFile
    if (idx && idx.files && Array.isArray(idx.chunks)) {
      setMemCache(cwd, idx)
      return idx
    }
  } catch {
    /* corrupt → rebuild */
  }
  return null
}

interface ScannedFile {
  abs: string
  rel: string
  mtimeMs: number
}
function scan(dir: string, cwd: string, out: ScannedFile[]): void {
  if (out.length >= MAX_FILES) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return
    if (IGNORE.has(name) || name.startsWith('.')) continue
    const abs = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) scan(abs, cwd, out)
    else if (CODE_EXT.has(extname(name).toLowerCase()) && st.size <= MAX_FILE_BYTES) {
      out.push({ abs, rel: relative(cwd, abs).split(sep).join('/'), mtimeMs: st.mtimeMs })
    }
  }
}

// The recursive scan is synchronous (up to MAX_FILES statSync calls) and blocks the main process.
// The agent often calls semantic_search several times in one turn — cache the scan briefly per cwd
// so a burst of searches re-walks the tree at most once every SCAN_TTL_MS instead of every call.
const SCAN_TTL_MS = 3000
const scanCache = new Map<string, { at: number; files: ScannedFile[] }>()
function scanCached(cwd: string): ScannedFile[] {
  const c = scanCache.get(cwd)
  if (c && Date.now() - c.at < SCAN_TTL_MS) return c.files
  const out: ScannedFile[] = []
  scan(cwd, cwd, out)
  scanCache.set(cwd, { at: Date.now(), files: out })
  // bound the cache so a long-lived process opening many cwds can't grow it without limit
  if (scanCache.size > 16) scanCache.delete(scanCache.keys().next().value as string)
  return out
}

function filesChanged(oldMap: Record<string, number>, scanned: ScannedFile[]): boolean {
  const keys = Object.keys(oldMap)
  if (keys.length !== scanned.length) return true
  for (const f of scanned) if (oldMap[f.rel] !== f.mtimeMs) return true
  return false
}

export interface IndexResult {
  chunks: number
  files: number
}

// Build the index INCREMENTALLY: reuse chunks/vectors for files whose mtime is unchanged
// since the previous index, and only re-embed new/changed files. `prev` + `scanned` are
// passed in to avoid a second walk.
async function rebuild(
  cwd: string,
  s: Settingsish,
  signal: AbortSignal,
  prev: IndexFile | null,
  scanned: ScannedFile[]
): Promise<IndexFile> {
  const model = embedModel(s)
  const reusable = prev && prev.model === model ? prev : null
  // group previous chunks by file for O(1) reuse
  const prevByFile = new Map<string, IndexedChunk[]>()
  if (reusable) for (const c of reusable.chunks) (prevByFile.get(c.file) ?? prevByFile.set(c.file, []).get(c.file)!).push(c)

  const kept: IndexedChunk[] = []
  const toEmbed: Chunk[] = []
  const files: Record<string, number> = {}
  for (const f of scanned) {
    if (kept.length + toEmbed.length >= MAX_CHUNKS) break
    files[f.rel] = f.mtimeMs
    const unchanged = reusable && reusable.files[f.rel] === f.mtimeMs && prevByFile.has(f.rel)
    if (unchanged) {
      kept.push(...prevByFile.get(f.rel)!)
      continue
    }
    let text: string
    try {
      text = readFileSync(f.abs, 'utf8')
    } catch {
      continue
    }
    if (text.includes(NUL)) continue // skip binary files
    for (const c of chunkLines(text, f.rel)) {
      if (kept.length + toEmbed.length >= MAX_CHUNKS) break
      toEmbed.push(c)
    }
  }

  const fresh: IndexedChunk[] = []
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    if (signal.aborted) throw new Error('aborted')
    const batch = toEmbed.slice(i, i + BATCH)
    const vecs = await embed(batch.map((c) => `${c.file}\n${c.text}`), s, signal)
    batch.forEach((c, j) => fresh.push({ ...c, vec: vecs[j] ?? [] }))
  }

  const index: IndexFile = { model, files, chunks: [...kept, ...fresh] }
  try {
    mkdirSync(INDEX_DIR, { recursive: true })
    const tmp = `${INDEX_PATH(cwd)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(index), 'utf8')
    renameSync(tmp, INDEX_PATH(cwd)) // atomic on the same volume
  } catch {
    /* persisting is best-effort; the in-memory index is still returned */
  }
  setMemCache(cwd, index)
  return index
}

export interface SearchHit {
  file: string
  startLine: number
  score: number
  text: string
}

// Search the index for a query. (Re)builds incrementally when files changed or the
// embedding model changed; honors the abort signal so a long build can be cancelled.
export async function semanticSearch(
  cwd: string,
  query: string,
  k: number,
  s: Settingsish,
  signal: AbortSignal
): Promise<SearchHit[]> {
  const model = embedModel(s)
  let index = loadIndex(cwd)
  if (index && index.model !== model) index = null // model switch → full rebuild
  const scanned = scanCached(cwd)
  if (!index || filesChanged(index.files, scanned)) {
    index = await rebuild(cwd, s, signal, index, scanned)
  }
  if (!index.chunks.length) return []
  const [q] = await embed([query], s, signal)
  if (!q) return []
  return index.chunks
    .map((c) => ({ file: c.file, startLine: c.startLine, text: c.text, score: cosine(q, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(k, 20)))
}

// Build/refresh the index up front (e.g. an explicit "index project" action).
export async function buildIndex(cwd: string, s: Settingsish, signal: AbortSignal): Promise<IndexResult> {
  const scanned = scanCached(cwd)
  const idx = await rebuild(cwd, s, signal, loadIndex(cwd), scanned)
  return { chunks: idx.chunks.length, files: scanned.length }
}
