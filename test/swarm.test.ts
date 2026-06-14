import { describe, it, expect } from 'vitest'
import { parseShards, formatSwarmReport, buildPlanPrompt } from '../src/main/agent/swarm'

describe('swarm parseShards', () => {
  it('parses a fenced {shards:[...]} plan', () => {
    const text = '```json\n{"shards":[{"label":"mod a","prompt":"do A"},{"label":"mod b","prompt":"do B"}]}\n```'
    const s = parseShards(text, 6)
    expect(s).toEqual([{ label: 'mod a', prompt: 'do A' }, { label: 'mod b', prompt: 'do B' }])
  })
  it('parses a bare object and drops shards without a prompt', () => {
    const s = parseShards('{"shards":[{"label":"x","prompt":"P"},{"label":"y"}]}', 6)
    expect(s).toEqual([{ label: 'x', prompt: 'P' }])
  })
  it('caps to maxWorkers', () => {
    const many = { shards: Array.from({ length: 10 }, (_, i) => ({ label: `l${i}`, prompt: `p${i}` })) }
    expect(parseShards(JSON.stringify(many), 3)).toHaveLength(3)
  })
  it('returns [] for non-JSON / no shards', () => {
    expect(parseShards('keine Zerlegung möglich', 6)).toEqual([])
    expect(parseShards('{"shards":[]}', 6)).toEqual([])
    expect(parseShards('', 6)).toEqual([])
  })
})

describe('swarm buildPlanPrompt', () => {
  it('embeds the task + worker bound and asks for strict JSON', () => {
    const p = buildPlanPrompt('migriere moment.js', 5)
    expect(p).toContain('migriere moment.js')
    expect(p).toContain('2 bis 5')
    expect(p).toContain('shards')
  })
})

describe('swarm formatSwarmReport', () => {
  it('summarizes per-worker status, branches and total cost', () => {
    const r = formatSwarmReport([
      { branch: 'swarm/ab/0-a', label: 'a', ok: true, summary: '', diffStat: ' 1 file changed', costUsd: 0.01, tokens: 100 },
      { branch: 'swarm/ab/1-b', label: 'b', ok: false, summary: 'boom', diffStat: '', costUsd: 0.005, tokens: 50 }
    ])
    expect(r).toContain('1/2 Worker erfolgreich')
    expect(r).toContain('swarm/ab/0-a')
    expect(r).toContain('swarm/ab/1-b')
    expect(r).toContain('$0.01') // total cost 0.015 → toFixed(4)=0.0150 → contains 0.01
    expect(r).toContain('git merge')
  })
})
