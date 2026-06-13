import { existsSync, readFileSync, statSync, readdirSync } from 'fs'
import { resolve, relative, isAbsolute, join, sep } from 'path'

// Builds a context block from user-attached files/folders. Kept deliberately
// cheap (token-aware): files are inlined up to a cap, folders are listed as a
// tree only (the agent reads what it needs on demand via its tools).

const IGNORE = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.next',
  '.cache',
  '.venv',
  '__pycache__'
])
const NUL = String.fromCharCode(0)
const MAX_FILE = 30_000 // per-file char cap
const MAX_TOTAL = 120_000 // total inlined char budget across all attachments

function walk(dir: string, out: string[], max = 800): void {
  if (out.length >= max) return
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= max) return
    if (e.isDirectory()) {
      if (IGNORE.has(e.name)) continue
      walk(join(dir, e.name), out, max)
    } else if (e.isFile()) {
      out.push(join(dir, e.name))
    }
  }
}

// Flat file listing of the working dir (relative paths) for @-mention
// autocomplete. Cached for 30s — the renderer asks once per cwd change, but a
// full tree walk per keystroke would hurt on big repos.
const fileListCache = new Map<string, { at: number; files: string[] }>()

export function listProjectFiles(cwd: string, max = 2000): string[] {
  const hit = fileListCache.get(cwd)
  if (hit && Date.now() - hit.at < 30_000) return hit.files
  const files: string[] = []
  walk(cwd, files, max)
  const rels = files.map((f) => relative(cwd, f).split(sep).join('/')).sort()
  fileListCache.set(cwd, { at: Date.now(), files: rels })
  return rels
}

export function buildAttachmentContext(paths: string[], cwd: string): string {
  if (!paths || !paths.length) return ''
  const parts: string[] = []
  let total = 0

  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(cwd, p)
    if (!existsSync(abs)) {
      parts.push(`# (not found) ${p}`)
      continue
    }
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      parts.push(`# (could not stat) ${p}`)
      continue
    }
    if (st.isDirectory()) {
      const files: string[] = []
      walk(abs, files)
      const rels = files.map((f) => relative(abs, f).split(sep).join('/'))
      const more = files.length >= 800 ? '\n… (truncated)' : ''
      parts.push(`# Folder: ${p} (${rels.length} files)\n${rels.slice(0, 800).join('\n')}${more}`)
    } else {
      if (st.size > MAX_FILE) {
        parts.push(`# File: ${p} (${st.size} bytes — too large to inline, read on demand)`)
        continue
      }
      let text: string
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        parts.push(`# File: ${p} (could not read)`)
        continue
      }
      if (text.includes(NUL)) {
        parts.push(`# File: ${p} (binary, skipped)`)
        continue
      }
      if (total + text.length > MAX_TOTAL) {
        parts.push(`# File: ${p} (skipped — attachment size budget reached)`)
        continue
      }
      total += text.length
      parts.push(`# File: ${p}\n\`\`\`\n${text}\n\`\`\``)
    }
  }

  return `<attached-context>\nThe user attached the following files/folders as primary context for this request:\n\n${parts.join(
    '\n\n'
  )}\n</attached-context>`
}
