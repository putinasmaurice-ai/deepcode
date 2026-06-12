import { Tool, ok, fail } from './types'
import { startJob, getJob, listJobs, killJob } from '../../jobs'

// Background job tools: start long-running commands (dev servers, watch builds)
// without blocking the agent loop, then poll their output.

export const runBackgroundTool: Tool = {
  name: 'run_background_command',
  description:
    'Start a long-running shell command in the BACKGROUND (dev server, watcher, download) and return a job id immediately. ' +
    'Use job_status to check output later and kill_job to stop it. For normal commands use run_command instead.',
  permission: 'bash',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run in the background.' },
      cwd: { type: 'string', description: 'Optional working directory override.' }
    },
    required: ['command']
  },
  summarize: (a) => `⏳ ${String(a.command).split('\n')[0].slice(0, 70)}`,
  async execute(args, ctx) {
    try {
      const job = startJob(args.command, args.cwd || ctx.cwd)
      return ok(
        `Background job started.\nid: ${job.id}\ncommand: ${job.command}\n\nCheck progress with job_status (id "${job.id}").`,
        { jobId: job.id }
      )
    } catch (e) {
      return fail((e as Error).message)
    }
  }
}

export const jobStatusTool: Tool = {
  name: 'job_status',
  description:
    'Get the status and recent output of a background job (or all jobs when no id is given).',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Job id from run_background_command. Omit to list all jobs.' }
    }
  },
  summarize: (a) => (a.id ? `Job ${a.id}` : 'Jobs'),
  async execute(args) {
    if (!args.id) {
      const all = listJobs()
      if (!all.length) return ok('No background jobs.')
      return ok(
        all
          .map((j) => `[${j.id}] ${j.status}${j.exitCode !== null ? ` (exit ${j.exitCode})` : ''} — ${j.command.slice(0, 80)}`)
          .join('\n')
      )
    }
    const job = getJob(args.id)
    if (!job) return fail(`No job with id "${args.id}".`)
    return ok(
      `id: ${job.id}\nstatus: ${job.status}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ''}\ncommand: ${job.command}\nrunning since: ${new Date(job.startedAt).toLocaleTimeString()}\n\n--- output (tail) ---\n${job.outputTail || '(no output yet)'}`
    )
  }
}

export const killJobTool: Tool = {
  name: 'kill_job',
  description: 'Stop a running background job by id.',
  permission: 'bash',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The job id to kill.' }
    },
    required: ['id']
  },
  summarize: (a) => `Kill job ${a.id}`,
  async execute(args) {
    return killJob(args.id)
      ? ok(`Job ${args.id} killed.`)
      : fail(`Job "${args.id}" not found or not running.`)
  }
}

export const jobTools: Tool[] = [runBackgroundTool, jobStatusTool, killJobTool]
