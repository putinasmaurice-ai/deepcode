import { describe, it, expect } from 'vitest'
import { parseWorkflowJson, coerceWorkflow, autoLayout } from '../src/shared/workflow-gen'
import { validateWorkflow, hasBlockingErrors } from '../src/shared/workflows'

describe('parseWorkflowJson', () => {
  it('parses plain JSON', () => {
    expect(parseWorkflowJson('{"name":"x","nodes":[]}')?.name).toBe('x')
  })
  it('parses a ```json fenced block', () => {
    expect(parseWorkflowJson('blah\n```json\n{"name":"y"}\n```\nthanks')?.name).toBe('y')
  })
  it('parses JSON wrapped in prose', () => {
    expect(parseWorkflowJson('Here you go: {"name":"z","nodes":[]} — enjoy')?.name).toBe('z')
  })
  it('returns null on garbage / arrays', () => {
    expect(parseWorkflowJson('not json at all')).toBeNull()
    expect(parseWorkflowJson('[1,2,3]')).toBeNull()
  })
})

describe('coerceWorkflow', () => {
  it('builds a valid linear workflow that passes validation', () => {
    const raw = {
      name: 'Demo',
      description: 'd',
      nodes: [
        { id: 't', type: 'trigger', config: { mode: 'manual' } },
        { id: 'a', type: 'agent', config: { prompt: 'do it' } },
        { id: 'o', type: 'output', config: { template: '{{last}}' } }
      ],
      edges: [
        { source: 't', target: 'a' },
        { source: 'a', target: 'o' }
      ]
    }
    const def = coerceWorkflow(raw, 'wf_1', 100)
    expect(def.id).toBe('wf_1')
    expect(def.nodes).toHaveLength(3)
    expect(def.nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number')).toBe(true)
    expect(hasBlockingErrors(validateWorkflow(def))).toBe(false)
  })

  it('synthesizes a trigger when the model omits one, and stays valid', () => {
    const raw = {
      nodes: [
        { id: 'a', type: 'agent', config: { prompt: 'hi' } },
        { id: 'o', type: 'output', config: {} }
      ],
      edges: [{ source: 'a', target: 'o' }]
    }
    const def = coerceWorkflow(raw, 'wf_2', 1)
    expect(def.nodes.some((n) => n.type === 'trigger')).toBe(true)
    // the synthesized trigger reaches the original first node → no "unreachable" blocking error
    expect(hasBlockingErrors(validateWorkflow(def))).toBe(false)
  })

  it('drops unknown node types and edges pointing at missing nodes', () => {
    const raw = {
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'bad', type: 'frobnicate', config: {} },
        { id: 'o', type: 'output', config: {} }
      ],
      edges: [
        { source: 't', target: 'o' },
        { source: 't', target: 'bad' }, // bad was dropped → this edge must be dropped too
        { source: 't', target: 'ghost' } // ghost never existed
      ]
    }
    const def = coerceWorkflow(raw, 'wf_3', 1)
    expect(def.nodes.find((n) => n.id === 'bad')).toBeUndefined()
    expect(def.edges).toHaveLength(1)
    expect(def.edges[0]).toMatchObject({ source: 't', target: 'o' })
  })

  it('forces unique node ids', () => {
    const raw = {
      nodes: [
        { id: 'dup', type: 'trigger', config: {} },
        { id: 'dup', type: 'output', config: {} }
      ],
      edges: []
    }
    const def = coerceWorkflow(raw, 'wf_4', 1)
    const ids = def.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns an empty-node def for non-node garbage (caller rejects it)', () => {
    expect(coerceWorkflow({}, 'wf_5', 1).nodes).toHaveLength(0)
  })
})

describe('autoLayout', () => {
  it('places nodes in increasing columns by graph depth', () => {
    const nodes = [
      { id: 't', type: 'trigger' as const, config: {} },
      { id: 'a', type: 'agent' as const, config: {} },
      { id: 'o', type: 'output' as const, config: {} }
    ]
    const edges = [
      { id: 'e1', source: 't', target: 'a' },
      { id: 'e2', source: 'a', target: 'o' }
    ]
    autoLayout(nodes, edges)
    expect(nodes[0].x!).toBeLessThan(nodes[1].x!)
    expect(nodes[1].x!).toBeLessThan(nodes[2].x!)
  })

  it('leaves nodes that already have finite x/y untouched (preserves a hand-arranged canvas)', () => {
    const nodes = [
      { id: 't', type: 'trigger' as const, config: {}, x: 999, y: 888 },
      { id: 'a', type: 'agent' as const, config: {}, x: 777, y: 666 }
    ]
    autoLayout(nodes, [{ id: 'e1', source: 't', target: 'a' }])
    expect(nodes[0]).toMatchObject({ x: 999, y: 888 })
    expect(nodes[1]).toMatchObject({ x: 777, y: 666 })
  })

  it('positions only the nodes missing coordinates, keeping the placed ones', () => {
    const nodes = [
      { id: 't', type: 'trigger' as const, config: {}, x: 50, y: 50 },
      { id: 'a', type: 'agent' as const, config: {} } // no position → must be placed
    ]
    autoLayout(nodes, [{ id: 'e1', source: 't', target: 'a' }])
    expect(nodes[0]).toMatchObject({ x: 50, y: 50 }) // unchanged
    expect(Number.isFinite(nodes[1].x)).toBe(true)
    expect(Number.isFinite(nodes[1].y)).toBe(true)
  })
})

describe('coerceWorkflow position preservation', () => {
  it('carries through model-supplied x/y instead of re-laying them out', () => {
    const raw = {
      name: 'Positioned',
      nodes: [
        { id: 't', type: 'trigger', config: { mode: 'manual' }, x: 10, y: 20 },
        { id: 'o', type: 'output', config: {}, x: 300, y: 400 }
      ],
      edges: [{ source: 't', target: 'o' }]
    }
    const def = coerceWorkflow(raw, 'wf_pos', 1)
    expect(def.nodes.find((n) => n.id === 't')).toMatchObject({ x: 10, y: 20 })
    expect(def.nodes.find((n) => n.id === 'o')).toMatchObject({ x: 300, y: 400 })
  })
})
