import { spawn, spawnSync, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { platform } from 'os'
import { auditLog, safeEnv } from './audit'

// Background shell jobs: long-running commands (dev servers, watch builds,
// downloads) that keep running while the agent continues working. The agent
// starts them via run_background_command and polls via job_status.

const isWin = platform() === 'win32'
const MAX_OUTPUT = 200_000
const MAX_JOBS = 50

export interface JobInfo {
  id: string
  command: string
  cwd: string
  status: 'running' | 'done' | 'failed' | 'killed'
  exitCode: number | null
  startedAt: number
  endedAt?: number
  outputTail: string
}

interface Job extends JobInfo {
  child: ChildProcess
  output: string
}

const jobs = new Map<string, Job>()

export function startJob(command: string, cwd: string): JobInfo {
  // cap the registry so a runaway agent can't accumulate processes forever
  if ([...jobs.values()].filter((j) => j.status === 'running').length >= 10) {
    throw new Error('Too many running background jobs (max 10). Kill one first (kill_job).')
  }
  auditLog('background_job', `${cwd} :: ${command}`)

  const shell = isWin ? 'powershell.exe' : '/bin/bash'
  const shellArgs = isWin
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-lc', command]
  const child = spawn(shell, shellArgs, { cwd, windowsHide: true, env: safeEnv() })

  const job: Job = {
    id: randomUUID().slice(0, 8),
    command,
    cwd,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    output: '',
    outputTail: '',
    child
  }

  const append = (chunk: Buffer): void => {
    job.output += chunk.toString('utf8')
    if (job.output.length > MAX_OUTPUT) job.output = job.output.slice(-MAX_OUTPUT)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('error', () => {
    job.status = 'failed'
    job.endedAt = Date.now()
  })
  child.on('close', (code) => {
    if (job.status === 'running') job.status = code === 0 ? 'done' : 'failed'
    job.exitCode = code
    job.endedAt = Date.now()
    // finished jobs only need their tail — release the big buffer
    if (job.output.length > 20_000) job.output = job.output.slice(-20_000)
  })

  jobs.set(job.id, job)
  // evict oldest finished jobs beyond the cap
  if (jobs.size > MAX_JOBS) {
    for (const [id, j] of jobs) {
      if (j.status !== 'running') {
        jobs.delete(id)
        if (jobs.size <= MAX_JOBS) break
      }
    }
  }
  return toInfo(job)
}

function toInfo(j: Job, tailChars = 4000): JobInfo {
  return {
    id: j.id,
    command: j.command,
    cwd: j.cwd,
    status: j.status,
    exitCode: j.exitCode,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    outputTail: j.output.slice(-tailChars)
  }
}

export function getJob(id: string, tailChars = 8000): JobInfo | null {
  const j = jobs.get(id)
  return j ? toInfo(j, tailChars) : null
}

export function listJobs(): JobInfo[] {
  return [...jobs.values()].map((j) => toInfo(j, 200)).sort((a, b) => b.startedAt - a.startedAt)
}

export function killJob(id: string, sync = false): boolean {
  const j = jobs.get(id)
  if (!j || j.status !== 'running') return false
  j.status = 'killed'
  j.endedAt = Date.now()
  try {
    if (isWin && j.child.pid) {
      // kill the whole process tree on Windows (PowerShell spawns children).
      // Async at runtime (taskkill can take seconds — must not block the main
      // process); sync only during app shutdown where blocking is required.
      const args = ['/PID', String(j.child.pid), '/T', '/F']
      if (sync) spawnSync('taskkill', args, { windowsHide: true, timeout: 3000 })
      else {
        // attach an error listener: a failed async spawn emits 'error' on a later
        // tick (outside this try) which, unhandled, would throw process-wide.
        const tk = spawn('taskkill', args, { windowsHide: true })
        tk.on('error', () => {})
      }
    } else {
      j.child.kill('SIGKILL')
    }
  } catch {
    /* best effort */
  }
  return true
}

// Synchronous on purpose: called from Electron's before-quit, which does not
// wait for async work.
export function shutdownJobs(): void {
  for (const j of jobs.values()) {
    if (j.status === 'running') killJob(j.id, true)
  }
}
