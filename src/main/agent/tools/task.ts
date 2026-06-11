import { Tool, ok, fail } from './types'
import { SubagentDef } from '@shared/types'

// The Task tool lets the main agent delegate a scoped job to a specialized
// subagent (defined in ~/.deepcode/agents/*.md). The subagent runs its own
// nested agent loop with its own system prompt + tool subset, and returns a
// single text result.
export function makeTaskTool(agents: SubagentDef[]): Tool {
  const names = agents.map((a) => a.name)
  const list = agents.length
    ? agents.map((a) => `- ${a.name}: ${a.description}`).join('\n')
    : '- general: a general-purpose assistant (no specialized subagents are installed yet)'

  return {
    name: 'task',
    description:
      'Delegate a self-contained task to a specialized subagent that runs in its own context and returns a result. ' +
      'Use this for focused research, parallelizable work, or to keep the main context clean.\n\nAvailable subagents:\n' +
      list,
    permission: 'none',
    parameters: {
      type: 'object',
      properties: {
        subagent: {
          type: 'string',
          description: `Which subagent to use. One of: ${names.length ? names.join(', ') : 'general'}.`
        },
        prompt: {
          type: 'string',
          description: 'A complete, standalone description of the task for the subagent.'
        }
      },
      required: ['subagent', 'prompt']
    },
    summarize: (a) => `Delegate to ${a.subagent}`,
    async execute(args, ctx) {
      if (!ctx.spawnSubagent) return fail('Subagent execution is not available in this context.')
      try {
        const result = await ctx.spawnSubagent(args.subagent, args.prompt)
        return ok(result)
      } catch (e) {
        return fail(`Subagent failed: ${(e as Error).message}`)
      }
    }
  }
}
