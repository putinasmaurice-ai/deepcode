import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { execFile } from 'child_process'
import { ProjectHealth } from '@shared/types'

// Project health check: quick static metrics (LOC, oversized files vs. the
// user's 250-line rule, TODO count, test presence, git state). Read-only, fast.

const IGNORE = new Set([
  'node_modules', '.git', 'out', 'dist', 'release', '.next', '.cache', '.venv', '__pycache__', 'build'
])
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|cs|cpp|c|h|go|rs|rb|php|kt|swift|vue|svelte|css|scss|html)$/i
const NUL = String.fromCharCode(0)

function walk(dir: string, out: string[], max = 4000): void {
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
      if (!IGNORE.has(e.name)) walk(join(dir, e.name), out, max)
    } else if (e.isFile()) out.push(join(dir, e.name))
  }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2500)
    execFile('git', args, { cwd, timeout: 2000 }, (err, stdout) => {
      clearTimeout(t)
      resolve(err ? null : stdout.trim())
    })
  })
}

export async function computeProjectHealth(cwd: string): Promise<ProjectHealth> {
  const files: string[] = []
  walk(cwd, files)

  let lines = 0
  let todos = 0
  let hasTests = false
  const oversized: { path: string; lines: number }[] = []

  for (const f of files) {
    const rel = relative(cwd, f).split(sep).join('/')
    if (/(^|\/)(test|tests|__tests__|spec)(\/|\.|_)/i.test(rel) || /\.(test|spec)\./i.test(rel)) {
      hasTests = true
    }
    if (!CODE_EXT.test(f)) continue
    try {
      if (statSync(f).size > 1_500_000) continue
      const text = readFileSync(f, 'utf8')
      if (text.includes(NUL)) continue
      const n = text.split('\n').length
      lines += n
      if (n > 250) oversized.push({ path: rel, lines: n })
      todos += (text.match(/\b(TODO|FIXME|HACK)\b/g) ?? []).length
    } catch {
      /* skip */
    }
  }
  oversized.sort((a, b) => b.lines - a.lines)

  let gitBranch: string | null = null
  let gitDirty = 0
  let lastCommitAge: string | null = null
  if (existsSync(join(cwd, '.git'))) {
    gitBranch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const status = await git(cwd, ['status', '--porcelain'])
    gitDirty = status ? status.split('\n').filter(Boolean).length : 0
    lastCommitAge = await git(cwd, ['log', '-1', '--format=%cr'])
  }

  return {
    cwd,
    files: files.length,
    lines,
    oversized: oversized.slice(0, 8),
    todos,
    hasTests,
    gitBranch,
    gitDirty,
    lastCommitAge
  }
}
