import { Tool, ok, fail } from './types'
import { MemoryEntry } from '@shared/types'

// The use_memory tool loads the full body of a stored memory entry by name.
// Memory entries are advertised (name + one-line description) in the system
// prompt's "# Memory" section; only the index is injected to save tokens, so the
// model calls this to pull the actual fact / error→solution pairs / preferences
// on demand — the read-side counterpart to how the app writes memory.
export function makeMemoryTool(entries: MemoryEntry[]): Tool {
  const names = entries.map((e) => e.name)
  return {
    name: 'use_memory',
    description:
      'Load the full content of a stored memory entry by name. The "# Memory" section of your system ' +
      'prompt lists available entries (name — description); call this to read the full body of one when ' +
      'it is relevant (e.g. a past error→solution, a user preference, project context).' +
      (names.length ? ` Available: ${names.slice(0, 30).join(', ')}` : ' (No memory entries yet.)'),
    permission: 'none',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The memory entry name to load.' }
      },
      required: ['name']
    },
    summarize: (a) => `Memory: ${a.name}`,
    async execute(args) {
      const entry = entries.find((e) => e.name === args.name)
      if (!entry) return fail(`No memory entry named "${args.name}". Available: ${names.join(', ') || 'none'}`)
      return ok(`# Memory: ${entry.name}\n\n${entry.body || '(empty entry)'}`)
    }
  }
}
