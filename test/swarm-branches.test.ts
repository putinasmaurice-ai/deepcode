import { describe, it, expect } from 'vitest'
import { isSwarmBranch } from '../src/main/swarm-branches'

describe('isSwarmBranch (merge-gate safety guard)', () => {
  it('accepts well-formed swarm/* branch names', () => {
    expect(isSwarmBranch('swarm/ab12cd34ef56/0-mod-a')).toBe(true)
    expect(isSwarmBranch('swarm/abc/1-fix_thing.v2')).toBe(true)
  })
  it('rejects anything that is not a swarm/* branch (so merge/delete can never touch a real branch)', () => {
    expect(isSwarmBranch('main')).toBe(false)
    expect(isSwarmBranch('develop')).toBe(false)
    expect(isSwarmBranch('feature/x')).toBe(false)
    expect(isSwarmBranch('swarmx/y')).toBe(false) // must be the swarm/ prefix exactly
  })
  it('rejects injection / traversal / flag-like names', () => {
    expect(isSwarmBranch('swarm/../main')).toBe(false) // no ..
    expect(isSwarmBranch('-D')).toBe(false)
    expect(isSwarmBranch('swarm/a;rm -rf')).toBe(false) // no shell metachars (argv-spawn anyway, but defense-in-depth)
    expect(isSwarmBranch('swarm/a b')).toBe(false) // no spaces
    expect(isSwarmBranch('')).toBe(false)
    // @ts-expect-error non-string input must be rejected, not throw
    expect(isSwarmBranch(undefined)).toBe(false)
  })
})
