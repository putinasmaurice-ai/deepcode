import { describe, it, expect } from 'vitest'
import { workflowTools } from '../src/main/agent/tools/workflow'
import type { Tool, ToolContext } from '../src/main/agent/tools/types'
import type { WorkflowRunResult } from '../src/shared/types'
import { getWorkflow } from '../src/main/workflows/store'

// These tools hit the real store (~/.deepcode/workflows). Every test uses a unique name and
// deletes its workflow in a finally so no residue is left behind.

function tool(name: string): Tool {
  const t = workflowTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, ...over }
}

const create = tool('create_workflow')
const get = tool('get_workflow')
const run = tool('run_workflow')
const del = tool('delete_workflow')
const update = tool('update_workflow')

const linearNodes = [
  { id: 't', type: 'trigger', config: { mode: 'manual' } },
  { id: 'a', type: 'agent', config: { prompt: 'do the thing' } },
  { id: 'o', type: 'output', config: { template: '{{last}}' } }
]
const linearEdges = [
  { source: 't', target: 'a' },
  { source: 'a', target: 'o' }
]

describe('workflow tools', () => {
  it('create_workflow saves a valid linear graph and returns an id', async () => {
    const name = `vitest-wf-ok-${Date.now()}`
    let id: string | undefined
    try {
      const r = await create.execute({ name, nodes: linearNodes, edges: linearEdges }, ctx())
      id = r.meta?.id as string | undefined
      expect(r.ok).toBe(true)
      expect(id).toMatch(/^wf_/)
      expect(getWorkflow(id!)).not.toBeNull()
    } finally {
      if (id) await del.execute({ id_or_name: id }, ctx())
    }
  })

  it('create_workflow with a REACHABLE node missing its required config returns blocking errors and does NOT save', async () => {
    const name = `vitest-wf-bad-${Date.now()}`
    // 'a' is reachable from the trigger but its required Prompt is missing → a blocking error,
    // so nothing should be persisted. (coerce silently drops dangling edges / unknown node types,
    // so those alone wouldn't block — a reachable node with a missing required field reliably does.)
    const nodes = [
      { id: 't', type: 'trigger', config: { mode: 'manual' } },
      { id: 'a', type: 'agent', config: {} }, // reachable + missing prompt → blocking error
      { id: 'o', type: 'output', config: { template: '{{last}}' } }
    ]
    const edges = [
      { source: 't', target: 'a' },
      { source: 'a', target: 'o' }
    ]
    let id: string | undefined
    try {
      const r = await create.execute({ name, nodes, edges }, ctx())
      id = r.meta?.id as string | undefined
      expect(r.ok).toBe(false)
      expect(r.content).toMatch(/blockierende Fehler/i)
      expect(id).toBeUndefined() // nothing saved
    } finally {
      if (id) await del.execute({ id_or_name: id }, ctx())
    }
  })

  it('get_workflow returns the saved def', async () => {
    const name = `vitest-wf-get-${Date.now()}`
    let id: string | undefined
    try {
      const c = await create.execute({ name, nodes: linearNodes, edges: linearEdges }, ctx())
      id = c.meta?.id as string
      const g = await get.execute({ id_or_name: id }, ctx())
      expect(g.ok).toBe(true)
      const def = JSON.parse(g.content)
      expect(def.id).toBe(id)
      expect(def.name).toBe(name)
      expect(def.nodes.length).toBe(3)
    } finally {
      if (id) await del.execute({ id_or_name: id }, ctx())
    }
  })

  it('run_workflow returns a readable summary from a stub ctx.runWorkflow', async () => {
    const stub: WorkflowRunResult = {
      ok: true,
      status: 'done',
      output: 'final result',
      nodes: [
        { id: 't', label: 'Start', status: 'done', output: 'started' },
        { id: 'a', status: 'failed', error: 'boom' }
      ]
    }
    const r = await run.execute(
      { id_or_name: 'whatever', input: 'hi' },
      ctx({ runWorkflow: async () => stub })
    )
    expect(r.ok).toBe(true)
    expect(r.content).toContain('Status: done')
    expect(r.content).toContain('t Start [done]')
    expect(r.content).toContain('a [failed]: Fehler: boom')
    expect(r.content).toContain('final result')
  })

  it('run_workflow reports when the capability is missing', async () => {
    const r = await run.execute({ id_or_name: 'x' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/nicht verfügbar/i)
  })

  it('create_workflow surfaces an unknown node type as a blocking error instead of silently dropping it', async () => {
    const name = `vitest-wf-unknown-${Date.now()}`
    const nodes = [
      { id: 't', type: 'trigger', config: { mode: 'manual' } },
      { id: 'mail', type: 'sendmail', config: { to: 'x@y.z' } }, // typo'd / non-catalog type
      { id: 'o', type: 'output', config: { template: '{{last}}' } }
    ]
    const edges = [
      { source: 't', target: 'mail' },
      { source: 'mail', target: 'o' }
    ]
    let id: string | undefined
    try {
      const r = await create.execute({ name, nodes, edges }, ctx())
      id = r.meta?.id as string | undefined
      expect(r.ok).toBe(false)
      expect(r.content).toMatch(/Unbekannter Knotentyp/i)
      expect(r.content).toMatch(/sendmail/)
      expect(id).toBeUndefined() // nothing saved
    } finally {
      if (id) await del.execute({ id_or_name: id }, ctx())
    }
  })

  it('update_workflow on a non-existent multi-word name does NOT clobber a prefix neighbour', async () => {
    const base = `vitest-deploy-${Date.now()}` // single name; "<base> prod" is a non-existent neighbour
    const c = await create.execute({ name: base, nodes: linearNodes, edges: linearEdges }, ctx())
    const id = c.meta?.id as string
    try {
      // ask to update "<base> prod" — which does not exist. Must fail, NOT resolve to `base`.
      const r = await update.execute(
        { id_or_name: `${base} prod`, nodes: linearNodes, edges: linearEdges },
        ctx()
      )
      expect(r.ok).toBe(false)
      expect(r.content).toMatch(/Kein Workflow gefunden/i)
      // original is intact and unchanged
      const still = getWorkflow(id)
      expect(still).not.toBeNull()
      expect(still!.name).toBe(base)
    } finally {
      await del.execute({ id_or_name: id }, ctx())
    }
  })

  it('delete_workflow removes the saved workflow', async () => {
    const name = `vitest-wf-del-${Date.now()}`
    const c = await create.execute({ name, nodes: linearNodes, edges: linearEdges }, ctx())
    const id = c.meta?.id as string
    expect(getWorkflow(id)).not.toBeNull()
    const d = await del.execute({ id_or_name: id }, ctx())
    expect(d.ok).toBe(true)
    expect(getWorkflow(id)).toBeNull()
  })
})
