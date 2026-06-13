import { spawn } from 'child_process'
import { platform } from 'os'
import { isAbsolute, resolve } from 'path'
import { Tool, ok, fail } from './types'
import { assertCwdInside } from './fs'
import { auditLog } from '../../audit'

const isWin = platform() === 'win32'

export const bashTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command in the working directory and return its combined stdout/stderr and exit code. ' +
    (isWin
      ? 'The shell is PowerShell (Windows). Use PowerShell syntax.'
      : 'The shell is bash/sh.') +
    ' Use this to run builds, tests, git, package managers, etc. Long-running/interactive commands are not supported.',
  permission: 'bash',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute.' },
      timeout_ms: { type: 'number', description: 'Max runtime in ms (default 120000).' },
      cwd: { type: 'string', description: 'Optional working directory override.' }
    },
    required: ['command']
  },
  summarize: (a) => `$ ${String(a.command).split('\n')[0].slice(0, 80)}`,
  async execute(args, ctx) {
    const timeout = Math.min(args.timeout_ms ?? 120_000, 600_000)
    // a cwd override must not escape the working directory when confinement is on —
    // otherwise a (workflow/agent) shell node could run anywhere on the machine.
    let cwd = ctx.cwd
    if (args.cwd) {
      cwd = isAbsolute(args.cwd) ? args.cwd : resolve(ctx.cwd, args.cwd)
      try {
        assertCwdInside(cwd, ctx.cwd, ctx.confineToCwd)
      } catch (e) {
        return fail((e as Error).message)
      }
    }
    auditLog('run_command', `${cwd} :: ${args.command}`)
    const shell = isWin ? 'powershell.exe' : '/bin/bash'
    const shellArgs = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', args.command]
      : ['-lc', args.command]

    return new Promise((resolve) => {
      let out = ''
      let killed = false
      const child = spawn(shell, shellArgs, {
        cwd,
        env: process.env,
        windowsHide: true
      })

      const timer = setTimeout(() => {
        killed = true
        child.kill('SIGKILL')
      }, timeout)

      const onAbort = (): void => {
        killed = true
        child.kill('SIGKILL')
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      const append = (chunk: Buffer): void => {
        out += chunk.toString('utf8')
        if (out.length > 200_000) {
          out = out.slice(0, 200_000) + '\n... (output truncated)'
          child.kill('SIGKILL')
        }
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)

      child.on('error', (err) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(fail(`Failed to start command: ${err.message}`))
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        const trimmed = out.trim() || '(no output)'
        if (killed) {
          resolve(fail(`Command timed out or was cancelled.\n${trimmed}`, { exitCode: code }))
        } else {
          const header = `exit code: ${code}`
          const body = `${trimmed}\n\n[${header}]`
          resolve(code === 0 ? ok(body, { exitCode: code }) : fail(body, { exitCode: code }))
        }
      })
    })
  }
}
