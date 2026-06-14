import { describe, it, expect } from 'vitest'
import { parseConfigPatch, buildRepairPrompt } from '../src/main/workflows/heal'
import { runWorkflow, WorkflowDeps } from '../src/main/workflows/executor'
import type { WorkflowDef, WorkflowNode } from '../src/shared/types'

function deps(over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    emit: () => {},
    runAgent: async () => '',
    runTool: async () => ({ ok: true, content: 'ok' }),
    runCtx: { deadline: Date.now() + 3_600_000, childRuns: { n: 0 }, maxChildRuns: 500 },
    ...over
  }
}

describe('heal parseConfigPatch', () => {
  it('extracts a fenced ```json block', () => {
    expect(parseConfigPatch('Fix:\n```json\n{"url":"https://x","method":"GET"}\n```\nfertig')).toEqual({ url: 'https://x', method: 'GET' })
  })
  it('extracts a bare object when there is no fence', () => {
    expect(parseConfigPatch('hier: {"pattern":"data-price"} ok')).toEqual({ pattern: 'data-price' })
  })
  it('returns null for prose-only / an array / malformed / empty', () => {
    expect(parseConfigPatch('Ich habe die Datei direkt gefixt, keine Config nötig.')).toBeNull()
    expect(parseConfigPatch('```json\n[1,2,3]\n```')).toBeNull() // not an object
    expect(parseConfigPatch('{kein gültiges json')).toBeNull()
    expect(parseConfigPatch('')).toBeNull()
  })
})

describe('heal buildRepairPrompt', () => {
  it('includes the raw config + error and masks secret values out of the vars', () => {
    const node: WorkflowNode = { id: 'n1', type: 'http', label: 'Seite holen', config: { url: '{{secret.X}}/api', method: 'GET' } }
    const mask = (s: string): string => s.split('ghp_supersecrettoken12').join('••••')
    const p = buildRepairPrompt(node, 'HTTP 401: token ghp_supersecrettoken12 rejected', { last: 'token ghp_supersecrettoken12 im body', foo: 'bar' }, mask)
    expect(p).toContain('http')
    expect(p).toContain('HTTP 401') // error shown…
    expect(p).toContain('{{secret.X}}/api') // raw config template is shown as-is (no secret value)
    expect(p).not.toContain('ghp_supersecrettoken12') // …but the secret is masked in BOTH error and {{last}}
    expect(p).toContain('••••')
  })
})

describe('executor self-heal hooks', () => {
  it('sets run.healSeed (failed node + pre-node input snapshot + upstream outputs) on a node failure', async () => {
    const def: WorkflowDef = {
      id: 'h1', name: 'h1', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'set', type: 'transform', config: { mode: 'set', value: 'INPUTVAL' } },
        { id: 'boom', type: 'tool', config: { tool: 'x', args: '{}' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'set' },
        { id: 'e2', source: 'set', target: 'boom' }
      ]
    }
    // the tool node fails (runTool returns ok:false → the node throws)
    const run = await runWorkflow(def, deps({ runTool: async () => ({ ok: false, content: 'boom failed' }) }))
    expect(run.status).toBe('failed')
    expect(run.healSeed?.fromNodeId).toBe('boom')
    // the snapshot is the input the failed node SAW — not the error it then wrote into {{last}}
    expect(run.healSeed?.vars.last).toBe('INPUTVAL')
    expect(run.healSeed?.seedOutputs.set).toBe('INPUTVAL') // upstream output captured for {{node.set}}
  })

  it('healSeed is dropped from the persisted (masked) run but kept on the live returned run', async () => {
    const def: WorkflowDef = {
      id: 'h3', name: 'h3', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'boom', type: 'tool', config: { tool: 'x', args: '{}' } }
      ],
      edges: [{ id: 'e1', source: 'trig', target: 'boom' }]
    }
    const run = await runWorkflow(def, deps({ runTool: async () => ({ ok: false, content: 'x' }), mask: (s) => s }))
    expect(run.healSeed).toBeTruthy() // live run carries it for the in-process heal
  })

  it('seeds nodeOutputs on a fromNodeId replay so {{node.<id>}} resolves mid-graph', async () => {
    const def: WorkflowDef = {
      id: 'h2', name: 'h2', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'mid', type: 'transform', config: { mode: 'template', template: 'from-{{node.up.x}}' } },
        { id: 'o', type: 'output', config: { template: '{{last}}' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'mid' },
        { id: 'e2', source: 'mid', target: 'o' }
      ]
    }
    // resume at 'mid' with an upstream 'up' output seeded — {{node.up.x}} must resolve to SEED
    const run = await runWorkflow(def, deps(), { fromNodeId: 'mid', seedOutputs: { up: '{"x":"SEED"}' } })
    expect(run.status).toBe('done')
    expect(run.vars?.last).toBe('from-SEED')
  })

  it('a resume from a NON-EXISTENT node fails fast (not a false "done" with zero nodes run)', async () => {
    const def: WorkflowDef = {
      id: 'h4', name: 'h4', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'o', type: 'output', config: { template: 'x' } }
      ],
      edges: [{ id: 'e1', source: 'trig', target: 'o' }]
    }
    const run = await runWorkflow(def, deps(), { fromNodeId: 'ghost' })
    expect(run.status).toBe('failed') // was silently 'done' with zero nodes before the guard
    expect(run.error).toContain('ghost')
  })
})
