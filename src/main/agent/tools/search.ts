import { Tool, ok, fail } from './types'
import { semanticSearch } from '../../embeddings'

export interface SemanticSearchConfig {
  localBaseUrl?: string
  embeddingModel?: string
}

// semantic_search: find the most relevant code by MEANING (local embeddings), returning
// only the top-k chunks instead of whole files — the biggest input-token saver on large
// repos. Complements grep (exact text) with conceptual search. Read-only, free/offline.
export function makeSemanticSearchTool(cfg: SemanticSearchConfig): Tool {
  return {
    name: 'semantic_search',
    description:
      'Search the project by MEANING using local embeddings (free/offline). Returns the top-k most ' +
      'relevant code chunks (path:line + snippet) for a natural-language query — use this to locate ' +
      'where something is implemented without reading whole files; complements grep (exact-text search). ' +
      'The index is built on first use and refreshed when the embedding model changes.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find, in natural language (e.g. "where is the approval gate").' },
        k: { type: 'number', description: 'How many chunks to return (default 6, max 20).' }
      },
      required: ['query']
    },
    summarize: (a) => `Semantic search: ${String(a.query ?? '').slice(0, 60)}`,
    async execute(args, ctx) {
      const query = String(args.query ?? '').trim()
      if (!query) return fail('semantic_search: query is required.')
      try {
        const hits = await semanticSearch(ctx.cwd, query, Number(args.k) || 6, cfg, ctx.signal)
        if (!hits.length) return ok('(no semantically relevant code found — the index may be empty)')
        const body = hits
          .map((h) => `## ${h.file}:${h.startLine}  (score ${h.score.toFixed(2)})\n${h.text}`)
          .join('\n\n')
        return ok(body, { count: hits.length })
      } catch (e) {
        return fail(
          `semantic_search failed: ${(e as Error).message}\n` +
            `Tip: a local embedding model must be available (e.g. \`ollama pull nomic-embed-text\`); set it in Settings.`
        )
      }
    }
  }
}
