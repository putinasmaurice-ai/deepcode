import { existsSync, readFileSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { lineDiff } from './agent/tools/fs'

// Pre-approval diff preview: shows EXACTLY what a pending write_file/edit_file/
// apply_patch call would change, before the user clicks Allow.

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p)
}

function readSafe(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

export function previewToolDiff(name: string, argsJson: string, cwd: string): string {
  let args: any
  try {
    args = JSON.parse(argsJson)
  } catch {
    return ''
  }

  try {
    if (name === 'write_file') {
      const before = readSafe(abs(cwd, args.path))
      return lineDiff(before, String(args.content ?? '')).diff
    }
    if (name === 'edit_file') {
      const before = readSafe(abs(cwd, args.path))
      if (!before) return ''
      const count = before.split(args.old_string ?? '').length - 1
      if (!args.old_string || count === 0) return '(old_string nicht gefunden — der Aufruf wird fehlschlagen)'
      const after = args.replace_all
        ? before.split(args.old_string).join(args.new_string ?? '')
        : before.replace(args.old_string, args.new_string ?? '')
      return lineDiff(before, after).diff
    }
    if (name === 'apply_patch') {
      const parts: string[] = []
      for (const op of (args.ops ?? []).slice(0, 10)) {
        const p = abs(cwd, op.path)
        if (op.type === 'delete') {
          parts.push(`### ${op.path} (löschen)`)
        } else if (op.type === 'create') {
          parts.push(`### ${op.path} (neu)\n${lineDiff('', String(op.content ?? '')).diff}`)
        } else if (op.type === 'edit') {
          const before = readSafe(p)
          const after = op.replace_all
            ? before.split(op.old_string ?? '').join(op.new_string ?? '')
            : before.replace(op.old_string ?? '', op.new_string ?? '')
          parts.push(`### ${op.path}\n${lineDiff(before, after).diff}`)
        }
      }
      return parts.join('\n\n').slice(0, 16_000)
    }
  } catch {
    return ''
  }
  return ''
}
