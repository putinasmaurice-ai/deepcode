import { describe, it, expect } from 'vitest'
import { isDangerousCommand } from '../src/main/agent/policy'

describe('isDangerousCommand', () => {
  it('flags recursive force deletes', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true)
    expect(isDangerousCommand('rm -rf ~/stuff')).toBe(true)
    expect(isDangerousCommand('Remove-Item -Recurse -Force C:\\')).toBe(true)
  })

  it('flags disk/format/dd and force-push and fork bombs', () => {
    expect(isDangerousCommand('mkfs.ext4 /dev/sda1')).toBe(true)
    expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true)
    expect(isDangerousCommand('git push --force origin main')).toBe(true)
    expect(isDangerousCommand(':(){ :|:& };:')).toBe(true)
  })

  it('allows ordinary commands', () => {
    expect(isDangerousCommand('npm test')).toBe(false)
    expect(isDangerousCommand('git status')).toBe(false)
    expect(isDangerousCommand('ls -la')).toBe(false)
    expect(isDangerousCommand('rm file.txt')).toBe(false)
  })

  it('handles non-strings safely', () => {
    expect(isDangerousCommand(undefined)).toBe(false)
    expect(isDangerousCommand(42)).toBe(false)
  })
})
