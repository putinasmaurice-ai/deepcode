import { describe, it, expect } from 'vitest'
import { WORKFLOW_TEMPLATES, instantiateTemplate } from '../src/shared/workflow-templates'
import { validateWorkflow, hasBlockingErrors, KNOWN_NODE_TYPES } from '../src/shared/workflows'

describe('workflow templates', () => {
  it('has a non-empty, unique-keyed catalogue', () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThan(0)
    const keys = WORKFLOW_TEMPLATES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  for (const t of WORKFLOW_TEMPLATES) {
    describe(`template: ${t.key}`, () => {
      const def = instantiateTemplate(t.key, 'wf_test_template', 1_000_000)!

      it('instantiates with the requested id + timestamps', () => {
        expect(def).toBeTruthy()
        expect(def.id).toBe('wf_test_template')
        expect(def.createdAt).toBe(1_000_000)
        expect(def.name).toBe(t.name)
      })

      it('uses only known node types and has exactly one trigger', () => {
        for (const n of def.nodes) expect(KNOWN_NODE_TYPES.has(n.type)).toBe(true)
        expect(def.nodes.filter((n) => n.type === 'trigger')).toHaveLength(1)
      })

      it('passes validation with NO blocking errors (every node reachable + configured)', () => {
        const issues = validateWorkflow(def)
        const errors = issues.filter((i) => i.severity === 'error')
        expect(errors, JSON.stringify(errors)).toHaveLength(0)
        expect(hasBlockingErrors(issues)).toBe(false)
      })

      it('every edge points at a real node', () => {
        const ids = new Set(def.nodes.map((n) => n.id))
        for (const e of def.edges) {
          expect(ids.has(e.source)).toBe(true)
          expect(ids.has(e.target)).toBe(true)
        }
      })

      it('never puts a {{secret.*}} in an agent prompt', () => {
        for (const n of def.nodes) {
          if (n.type === 'agent') expect(/\{\{\s*secret\./.test(String(n.config.prompt ?? ''))).toBe(false)
        }
      })
    })
  }

  it('returns null for an unknown template key', () => {
    expect(instantiateTemplate('nope', 'wf_x', 1)).toBeNull()
  })

  it('deep-copies nodes/edges/config so editing an instance never mutates the shared constant', () => {
    const t = WORKFLOW_TEMPLATES.find((x) => x.key === 'code-review')!
    const inst = instantiateTemplate('code-review', 'wf_a', 1)!
    // distinct object references at node, config and edge level → a true deep copy, so even a
    // future template with NESTED config (objects/arrays) is isolated.
    expect(inst.nodes[0]).not.toBe(t.nodes[0])
    expect(inst.nodes[0].config).not.toBe(t.nodes[0].config)
    if (t.edges.length) expect(inst.edges[0]).not.toBe(t.edges[0])
    // mutating the instance bleeds into neither the shared constant nor a fresh instance
    inst.nodes[1].config.prompt = 'MUTATED'
    expect(WORKFLOW_TEMPLATES.find((x) => x.key === 'code-review')!.nodes[1].config.prompt).not.toBe('MUTATED')
    expect(instantiateTemplate('code-review', 'wf_b', 2)!.nodes[1].config.prompt).not.toBe('MUTATED')
  })
})
