import { existsSync, readFileSync } from 'fs'
import { spawn } from 'child_process'
import { platform } from 'os'
import { join } from 'path'
import { PATHS, projectConfigDir } from '../paths'
import { HookDef, HookEvent } from '@shared/types'
import { auditLog, safeEnv } from '../audit'

// Hooks run shell commands when lifecycle events fire. Config lives in
// ~/.deepcode/hooks.json (and optionally <project>/.deepcode/hooks.json):
//   {
//     "PreToolUse": [{ "matcher": "write_file|edit_file", "command": "git add -A" }],
//     "PostToolUse": [{ "matcher": "run_command", "command": "echo done" }],
//     "UserPromptSubmit": [{ "command": "..." }],
//     "Stop": [{ "command": "..." }]
//   }

const isWin = platform() === 'win32'

interface HooksFile {
  [event: string]: { matcher?: string; command: string }[]
}

function loadFile(path: string, source: HookDef['source']): HookDef[] {
  if (!existsSync(path)) return []
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as HooksFile
    const out: HookDef[] = []
    for (const [event, list] of Object.entries(json)) {
      if (!Array.isArray(list)) continue
      for (const h of list) {
        out.push({ event: event as HookEvent, matcher: h.matcher, command: h.command, source })
      }
    }
    return out
  } catch {
    return []
  }
}

export function loadHooks(cwd?: string): HookDef[] {
  const hooks = loadFile(PATHS.hooks, 'user')
  if (cwd) hooks.push(...loadFile(join(projectConfigDir(cwd), 'hooks.json'), 'project'))
  return hooks
}

export interface HookContext {
  toolName?: string
  toolArgs?: unknown
  prompt?: string
  cwd: string
}

// Runs all hooks matching an event. Returns combined stdout (which the caller
// may inject into context, e.g. for UserPromptSubmit). Failures are swallowed
// but reported in the returned text.
export async function runHooks(
  event: HookEvent,
  ctx: HookContext,
  hooks?: HookDef[]
): Promise<string> {
  const all = (hooks ?? loadHooks(ctx.cwd)).filter((h) => h.event === event)
  const matched = all.filter((h) => {
    if (!h.matcher) return true
    if (event !== 'PreToolUse' && event !== 'PostToolUse') return true
    try {
      return new RegExp(h.matcher).test(ctx.toolName ?? '')
    } catch {
      return false
    }
  })
  if (!matched.length) return ''

  const outputs: string[] = []
  for (const hook of matched) {
    try {
      const text = await runOne(hook.command, ctx)
      if (text.trim()) outputs.push(text.trim())
    } catch (e) {
      outputs.push(`[hook error] ${(e as Error).message}`)
    }
  }
  return outputs.join('\n')
}

function runOne(command: string, ctx: HookContext): Promise<string> {
  const shell = isWin ? 'powershell.exe' : '/bin/bash'
  const shellArgs = isWin
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-lc', command]
  auditLog('hook', `${ctx.cwd} :: ${command}`)
  return new Promise((resolve, reject) => {
    let out = ''
    const child = spawn(shell, shellArgs, {
      cwd: ctx.cwd,
      windowsHide: true,
      // Hooks run automatically — give them a sanitized env without secrets.
      env: safeEnv({
        DEEPCODE_TOOL: ctx.toolName ?? '',
        DEEPCODE_PROMPT: ctx.prompt ?? '',
        DEEPCODE_ARGS: ctx.toolArgs ? JSON.stringify(ctx.toolArgs) : ''
      })
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    // cap the buffer like bash.ts/jobs.ts so a chatty hook can't balloon memory
    const append = (c: Buffer): void => {
      out += c.toString()
      if (out.length > 200_000) {
        out = out.slice(0, 200_000) + '\n... (truncated)'
        child.kill('SIGKILL')
      }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}
