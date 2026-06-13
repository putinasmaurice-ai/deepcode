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

const DENIED = '(Zugriff verweigert: außerhalb des Projekts)'

// `isAllowed(absPath)` is the SAME confinement the readFileHead IPC uses (project roots only,
// config dir off-limits). Without it, this preview readFileSync'd ANY path the renderer named
// (an absolute path bypasses cwd), leaking e.g. settings.json (API keys) as a one-sided diff.
export function previewToolDiff(
  name: string,
  argsJson: string,
  cwd: string,
  isAllowed: (absPath: string) => boolean = () => true
): string {
  let args: any
  try {
    args = JSON.parse(argsJson)
  } catch {
    return ''
  }
  const readGuarded = (absPath: string): string | null => (isAllowed(absPath) ? readSafe(absPath) : null)

  try {
    if (name === 'write_file') {
      const before = readGuarded(abs(cwd, args.path))
      if (before === null) return DENIED
      return lineDiff(before, String(args.content ?? '')).diff
    }
    if (name === 'edit_file') {
      const before = readGuarded(abs(cwd, args.path))
      if (before === null) return DENIED
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
          const before = readGuarded(p)
          if (before === null) {
            parts.push(`### ${op.path}\n${DENIED}`)
            continue
          }
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
