// Tiny YAML-ish frontmatter parser. Supports the subset we need:
// top-level key: value, and key: [a, b, c] arrays. Good enough for
// SKILL.md / command / agent definition files.

export interface Parsed {
  data: Record<string, string | string[]>
  body: string
}

export function parseFrontmatter(text: string): Parsed {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized }
  }
  // Require a full-line closing fence ('---' alone on its own line); a loose
  // indexOf('\n---') would also match '----', '---foo', a horizontal rule, or a
  // value containing '---'.
  const close = /\n---[ \t]*(\n|$)/.exec(normalized.slice(4))
  if (!close) return { data: {}, body: normalized }
  const end = 4 + close.index
  const raw = normalized.slice(4, end)
  const body = normalized.slice(end + close[0].length).replace(/^\n/, '')
  const data: Record<string, string | string[]> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    let val: string | string[] = m[2].trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      // JSON.stringify'd scalar (e.g. description) — JSON.parse to correctly unescape
      // embedded quotes/newlines; fall back to a simple strip if it isn't valid JSON.
      try {
        val = JSON.parse(val) as string
      } catch {
        val = val.replace(/^["']|["']$/g, '')
      }
    } else {
      val = val.replace(/^["']|["']$/g, '')
    }
    data[key] = val
  }
  return { data, body }
}

export function str(v: string | string[] | undefined, fallback = ''): string {
  if (Array.isArray(v)) return v.join(', ')
  return v ?? fallback
}

export function arr(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim())
  return []
}
