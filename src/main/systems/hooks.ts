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

// A matched PreToolUse hook may VETO the tool: it blocks when the hook process exits
// non-zero, or when it prints the deny token "DEEPCODE_BLOCK" anywhere on stdout/stderr.
// The remaining output (token stripped) is surfaced to the model as the block reason.
const DENY_TOKEN = 'DEEPCODE_BLOCK'

export interface HookGate {
  block: boolean
  reason?: string
}

function matchedHooks(event: HookEvent, ctx: HookContext, hooks?: HookDef[]): HookDef[] {
  const all = (hooks ?? loadHooks(ctx.cwd)).filter((h) => h.event === event)
  return all.filter((h) => {
    if (!h.matcher) return true
    if (event !== 'PreToolUse' && event !== 'PostToolUse') return true
    try {
      return new RegExp(h.matcher).test(ctx.toolName ?? '')
    } catch {
      return false
    }
  })
}

// Runs all hooks matching an event. Returns combined stdout (which the caller
// may inject into context, e.g. for UserPromptSubmit). Failures are swallowed
// but reported in the returned text.
export async function runHooks(
  event: HookEvent,
  ctx: HookContext,
  hooks?: HookDef[]
): Promise<string> {
  const matched = matchedHooks(event, ctx, hooks)
  if (!matched.length) return ''

  const outputs: string[] = []
  for (const hook of matched) {
    try {
      const { out } = await runOne(hook.command, ctx)
      if (out.trim()) outputs.push(out.trim())
    } catch (e) {
      outputs.push(`[hook error] ${(e as Error).message}`)
    }
  }
  return outputs.join('\n')
}

// PreToolUse gate: like runHooks, but a matched hook that exits non-zero (or prints the
// DEEPCODE_BLOCK deny token) vetoes the tool. The engine short-circuits tool.execute and
// surfaces `reason` to the model. A hook error is treated as non-blocking (fail-open) so a
// broken hook can't wedge every tool call.
export async function runPreToolUseHooks(ctx: HookContext, hooks?: HookDef[]): Promise<HookGate> {
  const matched = matchedHooks('PreToolUse', ctx, hooks)
  for (const hook of matched) {
    try {
      const { code, out } = await runOne(hook.command, ctx)
      const denied = code !== 0 || out.includes(DENY_TOKEN)
      if (denied) {
        const reason = out.split(DENY_TOKEN).join('').trim()
        return { block: true, reason: reason || `PreToolUse-Hook hat den Aufruf blockiert (Exit-Code ${code}).` }
      }
    } catch {
      /* a broken hook must never wedge the tool loop — fail open */
    }
  }
  return { block: false }
}

function runOne(command: string, ctx: HookContext): Promise<{ code: number; out: string }> {
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
    child.on('close', (code) => {
      clearTimeout(timer)
      // SIGKILL (timeout/buffer cap) yields a null code → treat as failure (non-zero)
      resolve({ code: code ?? 1, out })
    })
  })
}
