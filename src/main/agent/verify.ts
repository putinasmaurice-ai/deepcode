import { spawn } from 'child_process'

// Quality gate: run the project's verify command (npm test, typecheck, …).
// 3-minute cap, output tail kept for the auto-fix feedback prompt.

export function runVerify(
  command: string,
  cwd: string,
  signal: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  const isWin = process.platform === 'win32'
  const shell = isWin ? 'powershell.exe' : '/bin/bash'
  const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command]
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(shell, args, { cwd, windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const append = (c: Buffer): void => {
      out += c.toString('utf8')
      if (out.length > 60_000) out = out.slice(-60_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (e) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ ok: false, output: `Verify konnte nicht starten: ${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ ok: code === 0, output: out.trim() || `(exit ${code})` })
    })
  })
}
