import { describe, it, expect } from 'vitest'
import { validateWorkflow, hasBlockingErrors } from '../src/shared/workflows'
import type { WorkflowDef } from '../src/shared/types'

function def(partial: Partial<WorkflowDef>): WorkflowDef {
  return { id: 'w', name: 'w', createdAt: 0, updatedAt: 0, nodes: [], edges: [], ...partial }
}

describe('validateWorkflow', () => {
  it('flags missing required config as a blocking error', () => {
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'a', type: 'agent', config: {} } // no prompt
      ],
      edges: [{ id: 'e', source: 't', target: 'a' }]
    })
    const iss = validateWorkflow(d)
    expect(hasBlockingErrors(iss)).toBe(true)
    expect(iss.find((i) => i.nodeId === 'a')?.message).toMatch(/Prompt/)
  })

  it('flags a dangling edge to a deleted node', () => {
    const d = def({
      nodes: [{ id: 't', type: 'trigger', config: {} }],
      edges: [{ id: 'e', source: 't', target: 'ghost' }]
    })
    expect(hasBlockingErrors(validateWorkflow(d))).toBe(true)
  })

  it('warns (not blocks) on a disconnected node', () => {
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'o', type: 'output', config: {} } // not connected
      ],
      edges: []
    })
    const iss = validateWorkflow(d)
    expect(hasBlockingErrors(iss)).toBe(false)
    expect(iss.some((i) => i.nodeId === 'o' && i.severity === 'warn')).toBe(true)
  })

  it('blocks a cron trigger with a missing/invalid cron expression', () => {
    const empty = def({ nodes: [{ id: 't', type: 'trigger', config: { mode: 'cron' } }] })
    expect(hasBlockingErrors(validateWorkflow(empty))).toBe(true)
    const bad = def({ nodes: [{ id: 't', type: 'trigger', config: { mode: 'cron', cron: '0 9 *' } }] })
    expect(hasBlockingErrors(validateWorkflow(bad))).toBe(true)
    const good = def({ nodes: [{ id: 't', type: 'trigger', config: { mode: 'cron', cron: '0 9 * * *' } }] })
    expect(hasBlockingErrors(validateWorkflow(good))).toBe(false)
  })

  it('warns when a condition is missing a branch edge', () => {
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'c', type: 'condition', config: { expression: '{{last}} contains x' } },
        { id: 'o', type: 'output', config: {} }
      ],
      edges: [
        { id: 'e1', source: 't', target: 'c' },
        { id: 'e2', source: 'c', target: 'o', sourceHandle: 'true' } // no false branch
      ]
    })
    const iss = validateWorkflow(d)
    expect(iss.some((i) => i.nodeId === 'c' && /false-Zweig/.test(i.message))).toBe(true)
    expect(hasBlockingErrors(iss)).toBe(false) // warning, not blocking
  })

  it('blocks a transform/extract node with an invalid regex', () => {
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'x', type: 'transform', config: { mode: 'extract', pattern: '([' } }
      ],
      edges: [{ id: 'e', source: 't', target: 'x' }]
    })
    expect(hasBlockingErrors(validateWorkflow(d))).toBe(true)
  })

  it('does NOT block the run on a disconnected, half-configured orphan node', () => {
    // a leftover scratch node (not wired in) with missing config is a normal editing state —
    // it must warn, not fail the whole run (which would break cron workflows).
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'a', type: 'agent', config: { prompt: 'do it' } },
        { id: 'o', type: 'output', config: {} },
        { id: 'orphan', type: 'tool', config: {} } // disconnected + missing required 'tool'
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'o' }
      ]
    })
    const iss = validateWorkflow(d)
    expect(hasBlockingErrors(iss)).toBe(false) // orphan's missing config is only a warning
    expect(iss.some((i) => i.nodeId === 'orphan' && i.severity === 'warn')).toBe(true)
  })

  it('blocks an unknown node type', () => {
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'x', type: 'bogus' as never, config: {} }
      ],
      edges: [{ id: 'e', source: 't', target: 'x' }]
    })
    expect(hasBlockingErrors(validateWorkflow(d))).toBe(true)
  })

  it('warns a switch with case edges but no default branch', () => {
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 's', type: 'switch', config: { input: '{{last}}', cases: 'a,b' } },
        { id: 'oa', type: 'output', config: {} },
        { id: 'ob', type: 'output', config: {} }
      ],
      edges: [
        { id: 'e0', source: 't', target: 's' },
        { id: 'e1', source: 's', target: 'oa', sourceHandle: 'a' },
        { id: 'e2', source: 's', target: 'ob', sourceHandle: 'b' } // no 'default' edge
      ]
    })
    const iss = validateWorkflow(d)
    expect(iss.some((i) => i.nodeId === 's' && /default-Zweig/.test(i.message))).toBe(true)
    expect(hasBlockingErrors(iss)).toBe(false) // missing branch edges are warnings
  })

  it('blocks {{secret.*}} in an agent prompt (plaintext leak risk)', () => {
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'a', type: 'agent', config: { prompt: 'use {{secret.TOKEN}} please' } }
      ],
      edges: [{ id: 'e', source: 't', target: 'a' }]
    })
    const iss = validateWorkflow(d)
    expect(hasBlockingErrors(iss)).toBe(true)
    expect(iss.some((i) => i.nodeId === 'a' && /secret/.test(i.message))).toBe(true)
  })

  it('passes a well-formed workflow', () => {
    const d = def({
      nodes: [
        { id: 't', type: 'trigger', config: {} },
        { id: 'a', type: 'agent', config: { prompt: 'do it' } },
        { id: 'o', type: 'output', config: {} }
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'o' }
      ]
    })
    expect(validateWorkflow(d)).toHaveLength(0)
  })
})
