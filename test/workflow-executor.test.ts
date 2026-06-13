import { describe, it, expect } from 'vitest'
import { runWorkflow, WorkflowDeps } from '../src/main/workflows/executor'
import type { AgentEvent, WorkflowDef } from '../src/shared/types'

// Verifies the executor's orchestration: linear walk, variable passing, condition
// branching, output templating, status events. Node primitives (agent/tool) are
// mocked here — the real engine.runTurn / tool.execute paths are verified live.
function makeDef(): WorkflowDef {
  return {
    id: 't1',
    name: 'test',
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      { id: 'trig', type: 'trigger', config: {} },
      { id: 'set', type: 'transform', config: { mode: 'set', value: 'hello world', outputVar: 'msg' } },
      { id: 'cond', type: 'condition', config: { expression: '{{msg}} contains hello' } },
      { id: 'okOut', type: 'output', config: { template: 'YES: {{msg}}' } },
      { id: 'noOut', type: 'output', config: { template: 'NO' } }
    ],
    edges: [
      { id: 'e1', source: 'trig', target: 'set' },
      { id: 'e2', source: 'set', target: 'cond' },
      { id: 'e3', source: 'cond', target: 'okOut', sourceHandle: 'true' },
      { id: 'e4', source: 'cond', target: 'noOut', sourceHandle: 'false' }
    ]
  }
}

function mockDeps(events: AgentEvent[]): WorkflowDeps {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    runAgent: async () => 'agent-out',
    runTool: async () => ({ ok: true, content: 'tool-out' })
  }
}

describe('workflow executor', () => {
  it('walks the graph, passes variables, and takes the matching condition branch', async () => {
    const events: AgentEvent[] = []
    const run = await runWorkflow(makeDef(), mockDeps(events))

    expect(run.status).toBe('done')
    expect(run.vars?.msg).toBe('hello world')
    // condition true → okOut ran and templated; noOut was never visited
    expect(run.vars?.last).toBe('YES: hello world')
    expect(run.nodes.find((n) => n.nodeId === 'okOut')?.status).toBe('done')
    expect(run.nodes.find((n) => n.nodeId === 'noOut')?.status).toBe('pending')

    // streamed status: a run start + a done for the condition node
    expect(events.some((e) => e.type === 'workflow_run' && e.status === 'start')).toBe(true)
    expect(events.some((e) => e.type === 'workflow_node' && e.nodeId === 'cond' && e.status === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'workflow_run' && e.status === 'done')).toBe(true)
  })

  it('takes the false branch when the condition fails', async () => {
    const def = makeDef()
    def.nodes.find((n) => n.id === 'cond')!.config = { expression: '{{msg}} contains zzz' }
    const run = await runWorkflow(def, mockDeps([]))
    expect(run.vars?.last).toBe('NO')
    expect(run.nodes.find((n) => n.nodeId === 'noOut')?.status).toBe('done')
    expect(run.nodes.find((n) => n.nodeId === 'okOut')?.status).toBe('pending')
  })

  it('parses the condition operator from the raw expression, not after substitution', async () => {
    // both operands expand to "1 < 2"; the comparison is ==, so they are equal → true.
    // If we templated first ("1 < 2 == 1 < 2") the parser would latch onto the inner "<"
    // and wrongly take the false branch. This locks in the raw-parse fix.
    const def = makeDef()
    def.nodes = [
      { id: 'trig', type: 'trigger', config: {} },
      { id: 'a', type: 'transform', config: { mode: 'set', value: '1 < 2', outputVar: 'x' } },
      { id: 'cond', type: 'condition', config: { expression: '{{x}} == 1 < 2' } },
      { id: 'okOut', type: 'output', config: { template: 'EQUAL' } },
      { id: 'noOut', type: 'output', config: { template: 'NOPE' } }
    ]
    def.edges = [
      { id: 'e1', source: 'trig', target: 'a' },
      { id: 'e2', source: 'a', target: 'cond' },
      { id: 'e3', source: 'cond', target: 'okOut', sourceHandle: 'true' },
      { id: 'e4', source: 'cond', target: 'noOut', sourceHandle: 'false' }
    ]
    const run = await runWorkflow(def, mockDeps([]))
    expect(run.vars?.last).toBe('EQUAL')
  })

  it('bounds an infinite loop instead of hanging', async () => {
    // a node whose only outgoing edge loops back to itself must terminate via MAX_VISITS.
    const def: WorkflowDef = {
      id: 'loop',
      name: 'loop',
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'spin', type: 'transform', config: { mode: 'set', value: 'x' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'spin' },
        { id: 'e2', source: 'spin', target: 'spin' }
      ]
    }
    const run = await runWorkflow(def, mockDeps([]))
    // it stops on its own (no hang) AND a runaway must be reported as failed — never as a
    // clean 'done' that callers/sub-workflows would read as a valid result.
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/Schleifenlimit|Schritt-Limit/)
  })

  it('runs delay and notify nodes', async () => {
    const def: WorkflowDef = {
      id: 'dn',
      name: 'dn',
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'set', type: 'transform', config: { mode: 'set', value: 'built', outputVar: 'msg' } },
        { id: 'wait', type: 'delay', config: { seconds: 0 } },
        { id: 'note', type: 'notify', config: { title: 'Done', message: '{{msg}}' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'set' },
        { id: 'e2', source: 'set', target: 'wait' },
        { id: 'e3', source: 'wait', target: 'note' }
      ]
    }
    const notified: string[] = []
    const deps = mockDeps([])
    deps.notify = (t, b) => notified.push(`${t}:${b}`)
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('done')
    expect(notified).toEqual(['Done:built'])
  })

  it('marks a node/run cancelled (not failed) when aborted mid-node', async () => {
    const def = makeDef()
    def.nodes = [
      { id: 'trig', type: 'trigger', config: {} },
      { id: 'a', type: 'agent', config: { prompt: 'x' } }
    ]
    def.edges = [{ id: 'e', source: 'trig', target: 'a' }]
    const ac = new AbortController()
    const deps = mockDeps([])
    deps.signal = ac.signal
    deps.runAgent = async () => {
      ac.abort() // user cancels while the node is in flight
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('cancelled')
    expect(run.nodes.find((n) => n.nodeId === 'a')?.status).toBe('cancelled')
    expect(run.nodes.find((n) => n.nodeId === 'a')?.error).toBeUndefined()
  })

  it('marks the run failed when a node throws', async () => {
    const def = makeDef()
    def.nodes = [
      { id: 'trig', type: 'trigger', config: {} },
      { id: 'a', type: 'agent', config: { prompt: 'x' } }
    ]
    def.edges = [{ id: 'e', source: 'trig', target: 'a' }]
    const deps = mockDeps([])
    deps.runAgent = async () => {
      throw new Error('boom')
    }
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('failed')
    expect(run.nodes.find((n) => n.nodeId === 'a')?.error).toContain('boom')
  })
})
