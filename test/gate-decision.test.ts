import { describe, it, expect } from 'vitest'
import { gateDecision, GateInput } from '../src/main/agent/gate-decision'

// Base: a benign non-mutating read tool under interactive mode → prompt by default.
const base = (over: Partial<GateInput> = {}): GateInput => ({
  policy: 'interactive',
  toolName: 'read_file',
  mutating: false,
  dangerous: false,
  isMcp: false,
  isCmd: false,
  unattendedBlock: null,
  autoApproved: false,
  commandApproved: false,
  ...over
})

describe('gateDecision — the tool-approval decision tree', () => {
  it('blocks an unattended-screened call before anything else', () => {
    const d = gateDecision(base({ policy: 'full', unattendedBlock: 'nope: mcp blocked', isMcp: true }))
    expect(d).toEqual({ kind: 'deny', reason: 'nope: mcp blocked' })
  })

  it('refuses a mutating tool in plan mode', () => {
    const d = gateDecision(base({ policy: 'plan', mutating: true, toolName: 'write_file' }))
    expect(d.kind).toBe('deny')
    if (d.kind === 'deny') expect(d.reason).toContain('Plan mode')
  })

  it('NEVER auto-runs a dangerous command outside interactive — even under full', () => {
    // full + safe deny it with the dangerous-command message
    for (const policy of ['full', 'safe'] as const) {
      const d = gateDecision(base({ policy, isCmd: true, dangerous: true, mutating: true }))
      expect(d.kind).toBe('deny')
      if (d.kind === 'deny') expect(d.reason).toContain('gefährlicher Befehl')
    }
    // plan also denies, but the plan-mode rule fires first (mutating) — still a denial, just earlier
    expect(gateDecision(base({ policy: 'plan', isCmd: true, dangerous: true, mutating: true })).kind).toBe('deny')
  })

  it('a dangerous command in interactive mode falls through to a prompt (not auto, not deny)', () => {
    const d = gateDecision(base({ policy: 'interactive', isCmd: true, dangerous: true, autoApproved: true, commandApproved: true }))
    expect(d.kind).toBe('prompt') // dangerous defeats autoApprove AND the allowlist
  })

  it('full mode auto-allows a normal tool but NEVER an MCP tool', () => {
    expect(gateDecision(base({ policy: 'full', mutating: true, toolName: 'write_file' }))).toEqual({ kind: 'allow' })
    expect(gateDecision(base({ policy: 'full', isMcp: true, toolName: 'mcp__db__query' })).kind).toBe('prompt')
  })

  it('the auto-approve bucket allows a normal tool but not a dangerous cmd or an MCP tool', () => {
    expect(gateDecision(base({ autoApproved: true })).kind).toBe('allow')
    expect(gateDecision(base({ autoApproved: true, isMcp: true, toolName: 'mcp__x__y' })).kind).toBe('prompt')
    // a dangerous cmd defeats the bucket; under interactive it falls through to a prompt (not auto)
    expect(gateDecision(base({ autoApproved: true, isCmd: true, dangerous: true })).kind).toBe('prompt')
  })

  it('safe mode denies anything not already auto-approved, and the allowlist cannot punch through', () => {
    expect(gateDecision(base({ policy: 'safe' })).kind).toBe('deny')
    // even a blessed command is denied in safe mode (allowlist is interactive-only)
    expect(gateDecision(base({ policy: 'safe', isCmd: true, commandApproved: true })).kind).toBe('deny')
  })

  it('interactive: a previously-blessed command auto-runs via the allowlist; an unknown one prompts', () => {
    expect(gateDecision(base({ isCmd: true, commandApproved: true })).kind).toBe('allowlist')
    expect(gateDecision(base({ isCmd: true, commandApproved: false })).kind).toBe('prompt')
  })
})
