import { describe, it, expect } from 'vitest'
import { isDangerousCommand, isOutwardScmCommand, screenUnattendedCall } from '../src/main/agent/policy'

// #6 — force-push must be caught in the SHORT flag form too, not only --force.
describe('isDangerousCommand: force-push flag forms', () => {
  it('flags --force and --force-with-lease', () => {
    expect(isDangerousCommand('git push --force')).toBe(true)
    expect(isDangerousCommand('git push --force-with-lease origin main')).toBe(true)
  })
  it('flags the short -f flag (and bundled forms)', () => {
    expect(isDangerousCommand('git push -f')).toBe(true)
    expect(isDangerousCommand('git push origin main -f')).toBe(true)
    expect(isDangerousCommand('git push -uf origin main')).toBe(true)
  })
  it('does NOT flag a plain push or unrelated short flags', () => {
    expect(isDangerousCommand('git push')).toBe(false)
    expect(isDangerousCommand('git push origin main')).toBe(false)
    expect(isDangerousCommand('git push --set-upstream origin main')).toBe(false)
    expect(isDangerousCommand('git push -u origin main')).toBe(false)
  })
})

// #5 — outward SCM via the generic shell.
describe('isOutwardScmCommand', () => {
  it('flags git push and gh pr create', () => {
    expect(isOutwardScmCommand('git push origin main')).toBe(true)
    expect(isOutwardScmCommand('gh pr create --fill')).toBe(true)
  })
  it('ignores read-only git', () => {
    expect(isOutwardScmCommand('git status')).toBe(false)
    expect(isOutwardScmCommand('git pull')).toBe(false)
  })
})

// #1 + #5 — the single screen used by both the engine gate and the subagent loop.
describe('screenUnattendedCall', () => {
  it('blocks MCP / claude_code / task / preview_probe', () => {
    expect(screenUnattendedCall('mcp__supabase__execute_sql', {})).toMatch(/Blocked/)
    expect(screenUnattendedCall('claude_code', {})).toMatch(/Blocked/)
    expect(screenUnattendedCall('task', {})).toMatch(/Blocked/)
    expect(screenUnattendedCall('preview_probe', { action: 'screenshot' })).toMatch(/Blocked/)
  })
  it('blocks run_workflow (recursion bypass — fresh top-level run skips every guard)', () => {
    expect(screenUnattendedCall('run_workflow', { id_or_name: 'x' })).toMatch(/run_workflow/)
    expect(screenUnattendedCall('run_workflow', { id_or_name: 'x' })).toMatch(/Blocked/)
  })
  it('blocks structured git push/pr', () => {
    expect(screenUnattendedCall('git', { action: 'push' })).toMatch(/push\/pr/)
    expect(screenUnattendedCall('git', { action: 'pr' })).toMatch(/push\/pr/)
    expect(screenUnattendedCall('git', { action: 'status' })).toBeNull()
  })
  it('blocks dangerous + outward-scm shell commands', () => {
    expect(screenUnattendedCall('run_command', { command: 'rm -rf /' })).toMatch(/gefährlich/)
    expect(screenUnattendedCall('run_background_command', { command: 'git push -f' })).toMatch(/gefährlich/)
    expect(screenUnattendedCall('run_command', { command: 'git push origin main' })).toMatch(/git push/)
  })
  it('allows safe tools / commands', () => {
    expect(screenUnattendedCall('read_file', { path: 'a.ts' })).toBeNull()
    expect(screenUnattendedCall('run_command', { command: 'npm test' })).toBeNull()
    expect(screenUnattendedCall('git', { action: 'diff' })).toBeNull()
  })
})
