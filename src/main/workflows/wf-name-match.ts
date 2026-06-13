import type { WorkflowDef } from '@shared/types'

// Resolve a `/wf <…>` argument string to a workflow + the remaining text used as input.
// Names may contain spaces, so we match the LONGEST workflow name the args start with first;
// then fall back to first-token id / exact name; else return fuzzy candidates for a hint.
// Pure (list passed in, no disk/electron deps) so it can be unit-tested in isolation.
export function resolveWorkflow(
  all: WorkflowDef[],
  args: string
): { def?: WorkflowDef; input: string; matches: WorkflowDef[] } {
  const lower = args.toLowerCase()
  // longest-name-prefix wins (so "Build And Test foo" → workflow "Build And Test", input "foo")
  const byLen = [...all].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0))
  for (const w of byLen) {
    const n = (w.name || '').toLowerCase()
    if (!n) continue
    if (lower === n) return { def: w, input: '', matches: [] }
    if (lower.startsWith(n + ' ')) return { def: w, input: args.slice((w.name || '').length).trim(), matches: [] }
  }
  // first whitespace-delimited token as id or exact (single-word) name
  const sp = args.search(/\s/)
  const token = sp === -1 ? args : args.slice(0, sp)
  const rest = sp === -1 ? '' : args.slice(sp + 1).trim()
  const byId = all.find((w) => w.id === token)
  if (byId) return { def: byId, input: rest, matches: [] }
  const byName = all.find((w) => (w.name || '').toLowerCase() === token.toLowerCase())
  if (byName) return { def: byName, input: rest, matches: [] }
  // no exact hit — offer fuzzy candidates (names containing the typed text)
  const matches = all.filter((w) => (w.name || '').toLowerCase().includes(lower)).slice(0, 8)
  return { input: args, matches }
}
