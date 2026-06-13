import { describe, it, expect } from 'vitest'
import { runWorkflow, WorkflowDeps } from '../src/main/workflows/executor'
import { runUserCode } from '../src/main/workflows/code-node'
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
    runTool: async () => ({ ok: true, content: 'tool-out' }),
    // loop/parallel sub-runs: echo the item var so collection is observable
    runSubBag: async (_id, vars) => ({ ...vars, last: vars.item ?? vars.last ?? 'sub' }),
    runCtx: { deadline: Date.now() + 3_600_000, childRuns: { n: 0 }, maxChildRuns: 500 }
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

  it('retries a failing node and succeeds within the retry budget', async () => {
    const def: WorkflowDef = {
      id: 'r', name: 'r', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'a', type: 'agent', config: { prompt: 'x', retries: 3 } }
      ],
      edges: [{ id: 'e', source: 'trig', target: 'a' }]
    }
    let calls = 0
    const deps = mockDeps([])
    deps.runAgent = async () => {
      calls++
      if (calls < 3) throw new Error('transient')
      return 'ok-on-third'
    }
    const run = await runWorkflow(def, deps)
    expect(calls).toBe(3)
    expect(run.status).toBe('done')
    expect(run.vars?.last).toBe('ok-on-third')
  })

  it('continues past a failing node when continueOnError is set', async () => {
    const def: WorkflowDef = {
      id: 'c', name: 'c', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'a', type: 'agent', config: { prompt: 'x', continueOnError: true } },
        { id: 'o', type: 'output', config: { template: 'reached' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'a' },
        { id: 'e2', source: 'a', target: 'o' }
      ]
    }
    const deps = mockDeps([])
    deps.runAgent = async () => {
      throw new Error('always fails')
    }
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('done') // run not aborted by the failed node
    expect(run.nodes.find((n) => n.nodeId === 'a')?.status).toBe('failed')
    expect(run.vars?.last).toBe('reached') // downstream node still ran
  })

  it('a failed shell node still publishes its output to {{last}} under continueOnError', async () => {
    // the summary step exists for the FAILING case (e.g. a red `npm test`); it must see the real
    // command output, not the stale {{last}} seeded at run start.
    const def: WorkflowDef = {
      id: 'soe', name: 'soe', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'sh', type: 'shell', config: { command: 'npm test', continueOnError: true } },
        { id: 'o', type: 'output', config: { template: 'SUMMARY: {{last}}' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'sh' },
        { id: 'e2', source: 'sh', target: 'o' }
      ]
    }
    const deps = mockDeps([])
    deps.runTool = async () => ({ ok: false, content: '2 failing tests' })
    const run = await runWorkflow(def, deps, { vars: { last: 'STALE-INPUT' } })
    expect(run.status).toBe('done')
    expect(run.nodes.find((n) => n.nodeId === 'sh')?.status).toBe('failed')
    // built from the FAILED command output, not the stale seed
    expect(run.vars?.last).toBe('SUMMARY: 2 failing tests')
  })

  it('treats a cancel during a retry backoff as cancelled, not failed', async () => {
    const def: WorkflowDef = {
      id: 'rc', name: 'rc', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'a', type: 'agent', config: { prompt: 'x', retries: 2, retryDelaySec: 1 } }
      ],
      edges: [{ id: 'e', source: 'trig', target: 'a' }]
    }
    const ac = new AbortController()
    const deps = mockDeps([])
    deps.signal = ac.signal
    deps.runAgent = async () => {
      throw new Error('boom') // always fails → goes into the retry backoff sleep
    }
    setTimeout(() => ac.abort(), 10) // cancel DURING the 1s retry sleep
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('cancelled')
    expect(run.nodes.find((n) => n.nodeId === 'a')?.status).toBe('cancelled')
  }, 5000)

  it('routes a switch node to the matching case', async () => {
    const def: WorkflowDef = {
      id: 's', name: 's', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'set', type: 'transform', config: { mode: 'set', value: 'error', outputVar: 'st' } },
        { id: 'sw', type: 'switch', config: { input: '{{st}}', cases: 'ok,error,retry' } },
        { id: 'okO', type: 'output', config: { template: 'OK' } },
        { id: 'errO', type: 'output', config: { template: 'ERR' } },
        { id: 'defO', type: 'output', config: { template: 'DEF' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'set' },
        { id: 'e2', source: 'set', target: 'sw' },
        { id: 'e3', source: 'sw', target: 'okO', sourceHandle: 'ok' },
        { id: 'e4', source: 'sw', target: 'errO', sourceHandle: 'error' },
        { id: 'e5', source: 'sw', target: 'defO', sourceHandle: 'default' }
      ]
    }
    const run = await runWorkflow(def, mockDeps([]))
    expect(run.vars?.last).toBe('ERR')
    expect(run.nodes.find((n) => n.nodeId === 'errO')?.status).toBe('done')
    expect(run.nodes.find((n) => n.nodeId === 'okO')?.status).toBe('pending')
  })

  it('loop (forEach) runs the body per item and collects results as JSON', async () => {
    const def: WorkflowDef = {
      id: 'lp', name: 'lp', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'loop', type: 'loop', config: { listExpr: '["a","b","c"]', bodyWorkflowId: 'body', itemVar: 'item', collectAs: 'json' } }
      ],
      edges: [{ id: 'e', source: 'trig', target: 'loop' }]
    }
    const calls: string[] = []
    const deps = mockDeps([])
    deps.runSubBag = async (_id, vars) => {
      calls.push(vars.item!)
      return { last: vars.item!.toUpperCase() }
    }
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('done')
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(run.vars?.last).toBe('["A","B","C"]')
  })

  it('loop in parallel mode runs every item (bounded)', async () => {
    const def: WorkflowDef = {
      id: 'lpp', name: 'lpp', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'loop', type: 'loop', config: { listExpr: '["1","2","3","4","5"]', bodyWorkflowId: 'b', mode: 'parallel', concurrency: 2, collectAs: 'join', joinSep: ',' } }
      ],
      edges: [{ id: 'e', source: 'trig', target: 'loop' }]
    }
    const deps = mockDeps([])
    deps.runSubBag = async (_id, vars) => ({ last: 'x' + vars.item })
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('done')
    expect(run.vars?.last).toBe('x1,x2,x3,x4,x5')
  })

  it('parallel node runs branches and merges (array), then merge node combines vars', async () => {
    const def: WorkflowDef = {
      id: 'par', name: 'par', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'p', type: 'parallel', config: { branches: [{ workflowId: 'wa', resultVar: 'a' }, { workflowId: 'wb', resultVar: 'b' }], mergeMode: 'array' } },
        { id: 'm', type: 'merge', config: { inputs: 'a,b', mode: 'concat', separator: '+' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'p' },
        { id: 'e2', source: 'p', target: 'm' }
      ]
    }
    const deps = mockDeps([])
    deps.runSubBag = async (id) => ({ last: id === 'wa' ? 'AA' : 'BB' })
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('done')
    expect(run.vars?.a).toBe('AA')
    expect(run.vars?.b).toBe('BB')
    expect(run.vars?.last).toBe('AA+BB') // merge concat of the two branch result vars
  })

  it('store node: set then get via the injected kv', async () => {
    const mem = new Map<string, string>()
    const kv = {
      get: (k: string) => mem.get(k) ?? '',
      has: (k: string) => mem.has(k),
      set: (k: string, v: string) => (mem.set(k, v), v),
      del: (k: string) => void mem.delete(k),
      incr: (k: string, by = 1) => {
        const n = (Number(mem.get(k)) || 0) + by
        mem.set(k, String(n))
        return n
      }
    }
    const def: WorkflowDef = {
      id: 's', name: 's', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'set', type: 'store', config: { op: 'set', storeKey: 'seen', value: 'yes' } },
        { id: 'get', type: 'store', config: { op: 'get', storeKey: 'seen' } },
        { id: 'o', type: 'output', config: { template: 'val={{last}}' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'set' },
        { id: 'e2', source: 'set', target: 'get' },
        { id: 'e3', source: 'get', target: 'o' }
      ]
    }
    const deps = mockDeps([])
    deps.kv = kv
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('done')
    expect(mem.get('seen')).toBe('yes')
    expect(run.vars?.last).toBe('val=yes')
  })

  it('code node: runs a JS snippet over {{last}} (parsed) via the real sandbox', async () => {
    const def: WorkflowDef = {
      id: 'c', name: 'c', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'set', type: 'transform', config: { mode: 'set', value: '[1,2,3,4]' } },
        { id: 'code', type: 'code', config: { code: 'return last.reduce((a,b)=>a+b,0)' } },
        { id: 'o', type: 'output', config: { template: 'sum={{last}}' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'set' },
        { id: 'e2', source: 'set', target: 'code' },
        { id: 'e3', source: 'code', target: 'o' }
      ]
    }
    const deps = mockDeps([])
    deps.runCode = runUserCode // real vm sandbox
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('done')
    expect(run.vars?.last).toBe('sum=10')
  })

  it('code node sandbox rejects async/Promise/timers (no un-catchable crash) + has no host escape', () => {
    expect(() => runUserCode('return Promise.resolve(1)', { vars: {}, last: '', input: '' })).toThrow(/async|Promise/i)
    expect(() => runUserCode('await 1', { vars: {}, last: '', input: '' })).toThrow()
    // no host globals in the sandbox (using probes that aren't themselves banned words)
    expect(runUserCode('return typeof process', { vars: {}, last: '', input: '' })).toBe('undefined')
    expect(runUserCode('return typeof fetch', { vars: {}, last: '', input: '' })).toBe('undefined')
    // a synchronous infinite loop is bounded by the 1s timeout (throws, not a hang)
    expect(() => runUserCode('while(true){}', { vars: {}, last: '', input: '' })).toThrow()
  })

  it('parse node: extracts a JSON path; and parses CSV to rows', async () => {
    const jsonDef: WorkflowDef = {
      id: 'pj', name: 'pj', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'set', type: 'transform', config: { mode: 'set', value: '{"user":{"name":"Ada"}}' } },
        { id: 'parse', type: 'parse', config: { mode: 'json', path: 'user.name' } },
        { id: 'o', type: 'output', config: { template: '{{last}}' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'set' },
        { id: 'e2', source: 'set', target: 'parse' },
        { id: 'e3', source: 'parse', target: 'o' }
      ]
    }
    expect((await runWorkflow(jsonDef, mockDeps([]))).vars?.last).toBe('Ada')

    const csvDef: WorkflowDef = {
      id: 'pc', name: 'pc', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'set', type: 'transform', config: { mode: 'set', value: 'a,b\n1,2\n3,4' } },
        { id: 'parse', type: 'parse', config: { mode: 'csv' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'set' },
        { id: 'e2', source: 'set', target: 'parse' }
      ]
    }
    const csvRun = await runWorkflow(csvDef, mockDeps([]))
    expect(JSON.parse(csvRun.vars!.last)).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
  })

  it('email node: sends via injected sendEmail and expands {{secret.SMTP_PASS}} (in the allowlist)', async () => {
    let captured: Record<string, unknown> | null = null
    const def: WorkflowDef = {
      id: 'em', name: 'em', createdAt: 0, updatedAt: 0,
      nodes: [
        { id: 'trig', type: 'trigger', config: {} },
        { id: 'set', type: 'transform', config: { mode: 'set', value: 'Build ist grün' } },
        {
          id: 'mail', type: 'email',
          config: { host: 'smtp.example.com', port: '465', secure: 'true', user: 'me@example.com', from: 'me@example.com', to: 'you@example.com', subject: 'Status' }
        },
        { id: 'o', type: 'output', config: { template: '{{last}}' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'set' },
        { id: 'e2', source: 'set', target: 'mail' },
        { id: 'e3', source: 'mail', target: 'o' }
      ]
    }
    const deps = mockDeps([])
    deps.resolveSecret = (n) => (n === 'SMTP_PASS' ? 's3cr3t' : undefined)
    deps.sendEmail = async (o) => {
      captured = o
      return 'gesendet an you@example.com'
    }
    const run = await runWorkflow(def, deps)
    expect(run.status).toBe('done')
    expect(captured).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true, to: 'you@example.com', subject: 'Status' })
    expect(captured!.pass).toBe('s3cr3t') // secret expanded → email node IS in the allowlist
    expect(captured!.text).toBe('Build ist grün') // body defaults to {{last}}
    expect(run.vars?.last).toContain('gesendet an')
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
