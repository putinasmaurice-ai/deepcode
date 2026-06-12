import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync
} from 'fs'
import { join, resolve, relative, dirname, isAbsolute, sep } from 'path'
import { Tool, ok, fail } from './types'

const NUL = String.fromCharCode(0)

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p)
}

// Throws if `confine` is on and the resolved path escapes the working directory.
function ensureInside(resolved: string, cwd: string, confine?: boolean): void {
  if (!confine) return
  const rel = relative(cwd, resolved)
  if (rel === '' ) return
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Path is outside the working directory and access is confined to it. Disable "Confine to working directory" in Settings to allow this.`
    )
  }
}

// Compact unified-ish line diff for the UI. Not a real LCS — good enough to show
// what changed for a write/edit. Exported for the pre-approval diff preview.
export function lineDiff(before: string, after: string): { diff: string; added: number; removed: number } {
  const a = before.length ? before.split('\n') : []
  const b = after.split('\n')
  // find common prefix/suffix to keep the diff focused
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const removedLines = a.slice(start, endA)
  const addedLines = b.slice(start, endB)
  const out: string[] = []
  const ctxStart = Math.max(0, start - 2)
  for (let i = ctxStart; i < start; i++) out.push('  ' + a[i])
  for (const l of removedLines) out.push('- ' + l)
  for (const l of addedLines) out.push('+ ' + l)
  for (let i = endA; i < Math.min(a.length, endA + 2); i++) out.push('  ' + a[i])
  return {
    diff: out.join('\n').slice(0, 8000),
    added: addedLines.length,
    removed: removedLines.length
  }
}

const IGNORE_DIRS = new Set([
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

function globToRegex(glob: string): RegExp {
  // supports **, *, ? and {a,b}
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i += 2
        if (glob[i] === '/') i++
        continue
      }
      re += '[^/\\\\]*'
    } else if (c === '?') {
      re += '[^/\\\\]'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) {
        // unclosed brace: treat as a literal '{' (avoids an infinite loop)
        re += '\\{'
        i++
        continue
      }
      const opts = glob.slice(i + 1, end).split(',')
      re += '(' + opts.map((o) => o.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')'
      i = end + 1
      continue
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c
    } else if (c === '/') {
      re += '[/\\\\]'
    } else {
      re += c
    }
    i++
  }
  return new RegExp('^' + re + '$', 'i')
}

function walk(dir: string, out: string[], maxFiles = 5000): void {
  if (out.length >= maxFiles) return
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= maxFiles) return
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      walk(join(dir, e.name), out, maxFiles)
    } else if (e.isFile()) {
      out.push(join(dir, e.name))
    }
  }
}

export const readTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a file. Returns the text with 1-based line numbers. Use this before editing a file.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to the working dir).' },
      offset: { type: 'number', description: 'Optional 1-based line to start from.' },
      limit: { type: 'number', description: 'Optional max number of lines to read (default 2000).' }
    },
    required: ['path']
  },
  summarize: (a) => `Read ${a.path}`,
  async execute(args, ctx) {
    const p = resolvePath(ctx.cwd, args.path)
    ensureInside(p, ctx.cwd, ctx.confineToCwd)
    if (!existsSync(p)) return fail(`File not found: ${args.path}`)
    const st = statSync(p)
    if (st.isDirectory()) return fail(`${args.path} is a directory. Use list_dir.`)
    if (st.size > 2_000_000) return fail(`File too large (${st.size} bytes).`)
    const text = readFileSync(p, 'utf8')
    const lines = text.split('\n')
    const offset = Math.max(1, args.offset ?? 1)
    const limit = args.limit ?? 2000
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
    return ok(numbered || '(empty file)', { path: p, totalLines: lines.length })
  }
}

export const writeTool: Tool = {
  name: 'write_file',
  description:
    'Create a new file or overwrite an existing one with the given content. Parent directories are created automatically.',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write.' },
      content: { type: 'string', description: 'Full file content.' }
    },
    required: ['path', 'content']
  },
  summarize: (a) => `Write ${a.path}`,
  async execute(args, ctx) {
    const p = resolvePath(ctx.cwd, args.path)
    ensureInside(p, ctx.cwd, ctx.confineToCwd)
    const content = String(args.content ?? '')
    if (content.length > 10_000_000)
      return fail('Content too large (>10MB). Split it into multiple files.')
    const existed = existsSync(p)
    const before = existed ? readFileSync(p, 'utf8') : ''
    ctx.snapshot?.(p)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content, 'utf8')
    const lines = content.split('\n').length
    const d = lineDiff(before, content)
    return ok(`${existed ? 'Overwrote' : 'Created'} ${args.path} (${lines} lines).`, {
      path: p,
      created: !existed,
      content,
      diff: d.diff,
      linesAdded: d.added,
      linesRemoved: d.removed
    })
  }
}

export const editTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file with new text. old_string must match exactly and be unique unless replace_all is true. Read the file first.',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  summarize: (a) => `Edit ${a.path}`,
  async execute(args, ctx) {
    const p = resolvePath(ctx.cwd, args.path)
    ensureInside(p, ctx.cwd, ctx.confineToCwd)
    if (!existsSync(p)) return fail(`File not found: ${args.path}`)
    const text = readFileSync(p, 'utf8')
    if (args.old_string === args.new_string) return fail('old_string and new_string are identical.')
    const count = text.split(args.old_string).length - 1
    if (count === 0) return fail('old_string not found in file. Read the file to get the exact text.')
    if (count > 1 && !args.replace_all)
      return fail(`old_string appears ${count} times. Make it unique or set replace_all=true.`)
    const next = args.replace_all
      ? text.split(args.old_string).join(args.new_string)
      : text.replace(args.old_string, args.new_string)
    ctx.snapshot?.(p)
    writeFileSync(p, next, 'utf8')
    const d = lineDiff(text, next)
    return ok(`Edited ${args.path} (${count} replacement${count > 1 ? 's' : ''}).`, {
      path: p,
      oldString: args.old_string,
      newString: args.new_string,
      content: next,
      diff: d.diff,
      linesAdded: d.added,
      linesRemoved: d.removed
    })
  }
}

export const listTool: Tool = {
  name: 'list_dir',
  description: 'List files and folders in a directory (non-recursive).',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (default: working dir).' }
    }
  },
  summarize: (a) => `List ${a.path ?? '.'}`,
  async execute(args, ctx) {
    const p = resolvePath(ctx.cwd, args.path ?? '.')
    ensureInside(p, ctx.cwd, ctx.confineToCwd)
    if (!existsSync(p)) return fail(`Not found: ${args.path ?? '.'}`)
    const entries = readdirSync(p, { withFileTypes: true })
    const lines = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return ok(lines.join('\n') || '(empty)', { path: p, count: entries.length })
  }
}

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts", "**/*.{js,tsx}"). Returns matching paths. Ignores node_modules/.git/etc.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern.' },
      path: { type: 'string', description: 'Base directory to search (default: working dir).' }
    },
    required: ['pattern']
  },
  summarize: (a) => `Glob ${a.pattern}`,
  async execute(args, ctx) {
    const base = resolvePath(ctx.cwd, args.path ?? '.')
    ensureInside(base, ctx.cwd, ctx.confineToCwd)
    const files: string[] = []
    walk(base, files)
    const re = globToRegex(args.pattern)
    const matches = files
      .map((f) => relative(base, f).split(sep).join('/'))
      .filter((rel) => re.test(rel) || re.test('/' + rel))
      .slice(0, 500)
    return ok(matches.join('\n') || '(no matches)', { count: matches.length })
  }
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns matching lines as path:line:text. Ignores node_modules/.git/etc.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Base directory (default: working dir).' },
      glob: { type: 'string', description: 'Optional file glob filter (e.g. "*.ts").' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive (default false).' }
    },
    required: ['pattern']
  },
  summarize: (a) => `Grep ${a.pattern}`,
  async execute(args, ctx) {
    const base = resolvePath(ctx.cwd, args.path ?? '.')
    ensureInside(base, ctx.cwd, ctx.confineToCwd)
    let re: RegExp
    try {
      re = new RegExp(args.pattern, args.ignore_case ? 'i' : '')
    } catch (e) {
      return fail(`Invalid regex: ${(e as Error).message}`)
    }
    const fileRe = args.glob ? globToRegex(args.glob) : null
    const files: string[] = []
    walk(base, files)
    const out: string[] = []
    let scanned = 0
    for (const f of files) {
      if (out.length >= 300) break
      const rel = relative(base, f).split(sep).join('/')
      if (fileRe && !fileRe.test(rel) && !fileRe.test(rel.split('/').pop() || '')) continue
      let text: string
      try {
        const st = statSync(f)
        if (st.size > 1_000_000) continue
        text = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      if (text.includes(NUL)) continue // skip binary files
      scanned++
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`)
          if (out.length >= 300) break
        }
      }
    }
    return ok(out.join('\n') || '(no matches)', { count: out.length, scanned })
  }
}

// Apply several file operations atomically: validate all, snapshot prior state,
// apply, and roll back everything if any step fails. Use for multi-file refactors.
export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description:
    'Apply multiple file operations atomically (all-or-nothing). Each op is create (full content), ' +
    'edit (old_string -> new_string), or delete. If any op fails, all changes are rolled back. ' +
    'Use this for coordinated multi-file changes instead of many separate edits.',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      ops: {
        type: 'array',
        description: 'List of file operations to apply in order.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            type: { type: 'string', enum: ['create', 'edit', 'delete'] },
            content: { type: 'string', description: 'for create: full file content' },
            old_string: { type: 'string', description: 'for edit: exact text to replace' },
            new_string: { type: 'string', description: 'for edit: replacement text' },
            replace_all: { type: 'boolean' }
          },
          required: ['path', 'type']
        }
      }
    },
    required: ['ops']
  },
  summarize: (a) => `Apply patch (${(a.ops ?? []).length} ops)`,
  async execute(args, ctx) {
    const ops = Array.isArray(args.ops) ? args.ops : []
    if (!ops.length) return fail('No operations provided.')

    // 1) validate + snapshot
    const snapshots: { path: string; existed: boolean; prev: string }[] = []
    for (const op of ops) {
      const p = resolvePath(ctx.cwd, op.path)
      try {
        ensureInside(p, ctx.cwd, ctx.confineToCwd)
      } catch (e) {
        return fail((e as Error).message)
      }
      const existed = existsSync(p)
      if (op.type === 'edit' && !existed) return fail(`edit failed: ${op.path} does not exist.`)
      if (op.type === 'edit') {
        const text = readFileSync(p, 'utf8')
        const count = text.split(op.old_string ?? '').length - 1
        if (!op.old_string || count === 0)
          return fail(`edit failed: old_string not found in ${op.path}.`)
        if (count > 1 && !op.replace_all)
          return fail(`edit failed: old_string appears ${count}x in ${op.path}; set replace_all.`)
      }
      if (op.type === 'create' && typeof op.content !== 'string')
        return fail(`create failed: missing content for ${op.path}.`)
      snapshots.push({ path: p, existed, prev: existed ? readFileSync(p, 'utf8') : '' })
    }

    // 2) apply, rolling back on any error
    const done: string[] = []
    try {
      for (const op of ops) {
        const p = resolvePath(ctx.cwd, op.path)
        ctx.snapshot?.(p)
        if (op.type === 'create') {
          mkdirSync(dirname(p), { recursive: true })
          writeFileSync(p, op.content, 'utf8')
        } else if (op.type === 'edit') {
          const text = readFileSync(p, 'utf8')
          const next = op.replace_all
            ? text.split(op.old_string).join(op.new_string ?? '')
            : text.replace(op.old_string, op.new_string ?? '')
          writeFileSync(p, next, 'utf8')
        } else if (op.type === 'delete') {
          if (existsSync(p)) rmSync(p)
        }
        done.push(`${op.type} ${op.path}`)
      }
    } catch (e) {
      // rollback
      for (const s of snapshots) {
        try {
          if (s.existed) writeFileSync(s.path, s.prev, 'utf8')
          else if (existsSync(s.path)) rmSync(s.path)
        } catch {
          /* best effort */
        }
      }
      return fail(`apply_patch failed and was rolled back: ${(e as Error).message}`)
    }

    return ok(`Applied ${done.length} operations atomically:\n${done.join('\n')}`, {
      ops: done.length
    })
  }
}

export const fsTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  applyPatchTool,
  listTool,
  globTool,
  grepTool
]
