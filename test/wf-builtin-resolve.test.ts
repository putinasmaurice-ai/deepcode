import { describe, it, expect } from 'vitest'
import { resolveWorkflow } from '../src/main/workflows/wf-name-match'
import type { WorkflowDef } from '../src/shared/types'

// Minimal workflow defs — resolveWorkflow only reads id/name.
const wf = (id: string, name: string): WorkflowDef =>
  ({ id, name, nodes: [], edges: [], createdAt: 0, updatedAt: 0 }) as WorkflowDef

const all = [
  wf('wf_1', 'Deploy'),
  wf('wf_2', 'Build And Test'),
  wf('wf_3', 'Build'),
  wf('wf_4', 'Release Notes')
]

describe('resolveWorkflow (/wf argument parsing)', () => {
  it('matches an exact name with no input', () => {
    const r = resolveWorkflow(all, 'Deploy')
    expect(r.def?.id).toBe('wf_1')
    expect(r.input).toBe('')
  })

  it('is case-insensitive', () => {
    expect(resolveWorkflow(all, 'deploy').def?.id).toBe('wf_1')
    expect(resolveWorkflow(all, 'BUILD').def?.id).toBe('wf_3')
  })

  it('matches the LONGEST name prefix when names overlap, rest is input', () => {
    // "Build And Test" must win over "Build" even though both are prefixes
    const r = resolveWorkflow(all, 'Build And Test src/index.ts')
    expect(r.def?.id).toBe('wf_2')
    expect(r.input).toBe('src/index.ts')
  })

  it('treats trailing text after a single-word name as input', () => {
    const r = resolveWorkflow(all, 'Build everything now')
    expect(r.def?.id).toBe('wf_3')
    expect(r.input).toBe('everything now')
  })

  it('resolves by id with the rest as input', () => {
    const r = resolveWorkflow(all, 'wf_4 v1.2.0')
    expect(r.def?.id).toBe('wf_4')
    expect(r.input).toBe('v1.2.0')
  })

  it('returns fuzzy candidates when nothing matches', () => {
    const r = resolveWorkflow(all, 'buil')
    expect(r.def).toBeUndefined()
    expect(r.matches.map((m) => m.id).sort()).toEqual(['wf_2', 'wf_3'])
  })

  it('returns no candidates for a totally unknown name', () => {
    const r = resolveWorkflow(all, 'nonexistent-xyz')
    expect(r.def).toBeUndefined()
    expect(r.matches).toHaveLength(0)
  })
})
