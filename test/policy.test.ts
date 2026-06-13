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

  it('flags destructive disk FORMAT (drive letter / flag) but not build tooling', () => {
    // genuinely destructive — must stay blocked
    expect(isDangerousCommand('format C:')).toBe(true)
    expect(isDangerousCommand('format /q D:')).toBe(true)
    expect(isDangerousCommand('format /fs:ntfs X:')).toBe(true)
    expect(isDangerousCommand('format.exe C:')).toBe(true)
    expect(isDangerousCommand('format "C:"')).toBe(true)
    // destructive PowerShell disk cmdlets (regression: narrowed pattern once missed these)
    expect(isDangerousCommand('Format-Volume -DriveLetter D -Force')).toBe(true)
    expect(isDangerousCommand('Clear-Disk -Number 1 -RemoveData')).toBe(true)
    expect(isDangerousCommand('Initialize-Disk -Number 2')).toBe(true)
    // build/format tooling — must NOT be blocked (was a false positive that hard-broke
    // unattended workflow/automation steps once dangerous commands stopped auto-running)
    expect(isDangerousCommand('dotnet format')).toBe(false)
    expect(isDangerousCommand('clang-format -i main.c')).toBe(false)
    expect(isDangerousCommand('npm run format')).toBe(false)
    expect(isDangerousCommand('git format-patch -1 HEAD')).toBe(false)
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
