import { Tool, ok, fail } from './types'

// Lets the agent maintain a visible task list (like Claude Code's TodoWrite).
// The full list replaces the previous one; the UI renders it live above the chat.
export const todoTool: Tool = {
  name: 'todo_write',
  description:
    'Maintain a visible task list for the user. Call this when starting multi-step work (list the steps), ' +
    'and again whenever a step starts (status "doing") or finishes (status "done"). Always send the FULL list.',
  permission: 'none',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            status: { type: 'string', enum: ['open', 'doing', 'done'] }
          },
          required: ['text', 'status']
        }
      }
    },
    required: ['todos']
  },
  summarize: (a) => {
    const t = a.todos ?? []
    const done = t.filter((x: any) => x.status === 'done').length
    return `Todos ${done}/${t.length}`
  },
  async execute(args, ctx) {
    const todos = Array.isArray(args.todos) ? args.todos : []
    if (!todos.length) return fail('Provide at least one todo.')
    ctx.emitTodos?.(todos)
    const done = todos.filter((t: any) => t.status === 'done').length
    return ok(`Todo list updated (${done}/${todos.length} done).`)
  }
}
