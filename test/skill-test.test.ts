import { describe, it, expect } from 'vitest'
import { evaluateScenario, parseScenarios } from '../src/shared/skill-test'

describe('evaluateScenario', () => {
  it('passes when all expected substrings present and no forbidden ones', () => {
    const r = evaluateScenario('Critical: SQL injection. Fix: use a parameterized query.', {
      prompt: 'x',
      expect: ['injection', 'fix'],
      forbid: ['looks good']
    })
    expect(r.pass).toBe(true)
    expect(r.missingExpect).toEqual([])
    expect(r.hitForbid).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(evaluateScenario('INJECTION found', { prompt: 'x', expect: ['injection'] }).pass).toBe(true)
  })

  it('fails + reports missing expected substrings', () => {
    const r = evaluateScenario('looks fine to me', { prompt: 'x', expect: ['injection', 'fix'] })
    expect(r.pass).toBe(false)
    expect(r.missingExpect.sort()).toEqual(['fix', 'injection'])
  })

  it('fails + reports a forbidden hit', () => {
    const r = evaluateScenario('This looks good, no issues.', { prompt: 'x', forbid: ['looks good'] })
    expect(r.pass).toBe(false)
    expect(r.hitForbid).toEqual(['looks good'])
  })

  it('passes a scenario with no assertions', () => {
    expect(evaluateScenario('anything', { prompt: 'x' }).pass).toBe(true)
  })
})

describe('parseScenarios', () => {
  it('reads a {scenarios:[...]} object and drops malformed entries', () => {
    const s = parseScenarios({
      scenarios: [
        { name: 'a', prompt: 'p1', expect: ['x'], mock: 'm' },
        { prompt: '' }, // empty prompt → dropped
        { name: 'b' }, // no prompt → dropped
        'nonsense',
        { prompt: 'p2', expect: ['ok', 5], forbid: 'bad' } // expect filtered to strings, forbid non-array → undefined
      ]
    })
    expect(s).toHaveLength(2)
    expect(s[0]).toMatchObject({ name: 'a', prompt: 'p1', expect: ['x'], mock: 'm' })
    expect(s[1].prompt).toBe('p2')
    expect(s[1].expect).toEqual(['ok'])
    expect(s[1].forbid).toBeUndefined()
  })

  it('accepts a bare array too, and returns [] for junk', () => {
    expect(parseScenarios([{ prompt: 'p' }])).toHaveLength(1)
    expect(parseScenarios(null)).toEqual([])
    expect(parseScenarios({})).toEqual([])
  })
})
