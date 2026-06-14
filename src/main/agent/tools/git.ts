import { spawn } from 'child_process'
import { Tool, ok, fail } from './types'
import { auditLog, safeEnv } from '../../audit'

// Structured git/SCM tools so the agent does version control through a typed, safe
// path instead of blindly shelling out via run_command. Args are passed as argv
// (no shell), and file paths go after `--` to prevent option injection.

// thin git runner reused by the swarm orchestrator (worktree add/remove, diff --stat, merge).
// argv-spawn, no shell — same safe path the git tool uses.
export function runGit(args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number | null; out: string }> {
  return runProc('git', args, cwd, signal)
}

function runProc(
  cmd: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 120_000
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // already cancelled (e.g. between tool dispatch and here, or between the multiple
    // sub-processes one git_status/push call spawns) — don't start another process
    if (signal.aborted) return resolve({ code: null, out: 'aborted' })
    let out = ''
    let settled = false
    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      resolve({ code, out })
    }
    let child: ReturnType<typeof spawn>
    try {
      // safeEnv() keeps PATH/HOME/USERPROFILE (credential helpers still work) but strips secrets
      child = spawn(cmd, args, { cwd, env: safeEnv(), windowsHide: true })
    } catch (e) {
      return resolve({ code: null, out: `failed to start ${cmd}: ${(e as Error).message}` })
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const append = (c: Buffer): void => {
      out += c.toString('utf8')
      if (out.length > 200_000) {
        out = out.slice(0, 200_000) + '\n… (truncated)'
        child.kill('SIGKILL')
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (e) => {
      cleanup()
      const hint = (e as NodeJS.ErrnoException).code === 'ENOENT' ? ` — is "${cmd}" installed and on PATH?` : ''
      out = `${cmd} could not run: ${e.message}${hint}`
      done(null)
    })
    child.on('close', (code) => {
      cleanup()
      done(code)
    })
  })
}

const git = (args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number | null; out: string }> =>
  runProc('git', args, cwd, signal)

// Read-only SCM snapshot — frictionless (no approval) so the agent can stay git-aware.
export const gitStatusTool: Tool = {
  name: 'git_status',
  description:
    'Show the current git state: branch, ahead/behind, staged/unstaged/untracked files, and recent commits. ' +
    'Read-only. Set diff=true to also include the working-tree diff (capped). Call this before committing.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      diff: { type: 'boolean', description: 'Also include the unstaged+staged diff (capped).' }
    }
  },
  summarize: () => 'git status',
  async execute(args, ctx) {
    const inside = await git(['rev-parse', '--is-inside-work-tree'], ctx.cwd, ctx.signal)
    if (inside.code !== 0) return ok('(not a git repository)')
    const status = await git(['status', '--porcelain=v1', '--branch'], ctx.cwd, ctx.signal)
    const log = await git(['log', '--oneline', '-10'], ctx.cwd, ctx.signal)
    let body = `# git status\n${status.out.trim() || '(clean)'}\n\n# recent commits\n${log.out.trim() || '(none)'}`
    if (args.diff) {
      const d = await git(['diff'], ctx.cwd, ctx.signal)
      const staged = await git(['diff', '--staged'], ctx.cwd, ctx.signal)
      const combined = `${staged.out}${d.out}`.slice(0, 20_000)
      body += `\n\n# diff\n${combined.trim() || '(no changes)'}`
    }
    return ok(body)
  }
}

type GitAction = 'diff' | 'stage' | 'unstage' | 'commit' | 'branch' | 'checkout' | 'push' | 'pr' | 'worktree' | 'merge'

// Mutating SCM actions — gated like shell commands (permission 'bash').
export const gitTool: Tool = {
  name: 'git',
  description:
    'Perform a git/SCM action. action is one of: ' +
    'diff (show changes), stage (git add — paths or all), unstage, commit (needs message; commits staged changes), ' +
    'branch (create+switch to name), checkout (switch to existing name), push (pushes the current branch, sets upstream on first push), ' +
    'pr (open a GitHub pull request via the gh CLI — needs title, optional body). ' +
    'Prefer this over run_command for git so commits are diff-grounded and atomic.',
  permission: 'bash',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['diff', 'stage', 'unstage', 'commit', 'branch', 'checkout', 'push', 'pr', 'worktree', 'merge'] },
      paths: { type: 'array', items: { type: 'string' }, description: 'Files for stage/unstage/diff (omit = all).' },
      message: { type: 'string', description: 'Commit message (for commit).' },
      name: { type: 'string', description: 'Branch name (branch/checkout/merge), or worktree dir (worktree add/remove).' },
      mode: { type: 'string', description: 'For worktree: add | remove | prune.' },
      title: { type: 'string', description: 'PR title (for pr).' },
      body: { type: 'string', description: 'PR body (for pr).' }
    },
    required: ['action']
  },
  summarize: (a) => `git ${a.action}${a.name ? ' ' + a.name : ''}`,
  async execute(args, ctx) {
    const action = args.action as GitAction
    const paths: string[] = Array.isArray(args.paths) ? args.paths.map(String) : []
    auditLog('git', `${ctx.cwd} :: ${action} ${paths.join(' ')}`)

    const run = async (cmd: string, a: string[]): Promise<ReturnType<typeof ok>> => {
      const r = await runProc(cmd, a, ctx.cwd, ctx.signal)
      const head = `${cmd} ${a.join(' ')}`.slice(0, 120)
      const out = r.out.trim() || '(no output)'
      return r.code === 0 ? ok(`$ ${head}\n${out}`, { exitCode: r.code }) : fail(`$ ${head}\n${out}`, { exitCode: r.code })
    }

    switch (action) {
      case 'diff':
        return run('git', ['diff', ...(paths.length ? ['--', ...paths] : [])])
      case 'stage':
        return run('git', ['add', '--', ...(paths.length ? paths : ['.'])])
      case 'unstage':
        return run('git', ['restore', '--staged', '--', ...(paths.length ? paths : ['.'])])
      case 'commit':
        if (!args.message) return fail('commit needs a "message".')
        return run('git', ['commit', '-m', String(args.message)])
      case 'branch':
        if (!args.name) return fail('branch needs a "name".')
        // reject option-like names so e.g. "-f"/"--detach" can't become a git flag
        if (String(args.name).startsWith('-')) return fail('Branch name must not start with "-".')
        return run('git', ['checkout', '-b', String(args.name)])
      case 'checkout':
        if (!args.name) return fail('checkout needs a "name".')
        if (String(args.name).startsWith('-')) return fail('Branch/ref name must not start with "-".')
        return run('git', ['checkout', String(args.name)])
      case 'push': {
        // set upstream automatically on the first push of a new branch
        const up = await runProc('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], ctx.cwd, ctx.signal)
        return up.code === 0 ? run('git', ['push']) : run('git', ['push', '-u', 'origin', 'HEAD'])
      }
      case 'pr': {
        if (!args.title) return fail('pr needs a "title".')
        const a = ['pr', 'create', '--title', String(args.title), '--body', String(args.body ?? '')]
        return run('gh', a)
      }
      case 'merge':
        if (!args.name) return fail('merge needs a "name" (branch to merge).')
        if (String(args.name).startsWith('-')) return fail('Branch name must not start with "-".')
        return run('git', ['merge', '--no-edit', String(args.name)])
      case 'worktree': {
        const mode = String(args.mode || '')
        if (mode === 'prune') return run('git', ['worktree', 'prune'])
        const dir = String(args.name || '')
        if (!dir || dir.startsWith('-')) return fail('worktree add/remove needs a "name" (dir) that does not start with "-".')
        if (mode === 'add') return run('git', ['worktree', 'add', '--detach', dir])
        if (mode === 'remove') return run('git', ['worktree', 'remove', '--force', dir])
        return fail('worktree needs mode: add | remove | prune.')
      }
      default:
        return fail(`Unknown git action: ${action}`)
    }
  }
}
