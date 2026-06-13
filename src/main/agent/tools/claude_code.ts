import { spawn } from 'child_process'
import { Tool, ok, fail } from './types'
import { auditLog } from '../../audit'

// Configuration for the Claude Code helper tool (from AppSettings.claudeCode).
export interface ClaudeCodeConfig {
  path: string // binary, default 'claude' (resolved on PATH)
  permissionMode: 'plan' | 'acceptEdits' // ceiling: 'plan' = always read-only
  model?: string // claude model alias/id; '' = Claude's default
  maxBudgetUsd?: number // 0 = no cap
}

// Lets the DeepSeek-driven agent delegate a focused sub-task to the Claude Code
// CLI running headlessly (`claude -p`). DeepSeek stays the orchestrator; this is
// just one more tool. Costs are billed to the user's Anthropic account, NOT the
// DeepSeek ledger. Default is read-only (plan mode) so Claude can analyse but not
// modify the repo unless the user explicitly raised the ceiling in Settings.
export function makeClaudeCodeTool(cfg: ClaudeCodeConfig): Tool {
  return {
    name: 'claude_code',
    description:
      'Delegate a focused sub-task to Claude Code (an external AI coding assistant by Anthropic) ' +
      'running headlessly in the current working directory. Use for a second opinion, a deep ' +
      'analysis, or a hard sub-problem, then build on its answer. Returns Claude’s text result. ' +
      (cfg.permissionMode === 'plan'
        ? 'Claude runs READ-ONLY here and cannot modify files or run commands.'
        : 'Claude may edit files when allow_edits=true; otherwise it is read-only.'),
    permission: 'bash', // spawns an external process — always gate it
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The task or question for Claude. Be specific; include the files/areas to look at.'
        },
        allow_edits: {
          type: 'boolean',
          description:
            'Let Claude modify files for this call. Ignored (forced read-only) unless the user enabled edit mode in Settings.'
        }
      },
      required: ['prompt']
    },
    summarize: (a) => `\u{1F91D} Claude: ${String(a.prompt ?? '').slice(0, 70)}`,
    async execute(args, ctx) {
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) return fail('claude_code: prompt is required.')

      // Effective mode: the Settings value is a CEILING. allow_edits can only
      // raise plan->acceptEdits when the user already permitted edits.
      const mode = cfg.permissionMode === 'acceptEdits' && args.allow_edits ? 'acceptEdits' : 'plan'
      const cliArgs = ['-p', prompt, '--output-format', 'json', '--permission-mode', mode]
      if (cfg.model) cliArgs.push('--model', cfg.model)
      if (cfg.maxBudgetUsd && cfg.maxBudgetUsd > 0) cliArgs.push('--max-budget-usd', String(cfg.maxBudgetUsd))

      auditLog('claude_code', `${ctx.cwd} :: [${mode}] ${prompt.slice(0, 120)}`)

      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (r: ReturnType<typeof ok>): void => {
          if (settled) return
          settled = true
          resolve(r)
        }

        let child: ReturnType<typeof spawn>
        try {
          child = spawn(cfg.path || 'claude', cliArgs, {
            cwd: ctx.cwd,
            env: process.env,
            windowsHide: true
          })
        } catch (err) {
          return finish(fail(`claude_code: could not start "${cfg.path}": ${(err as Error).message}`))
        }

        // generous cap: Claude's agentic loop can run for minutes
        const timer = setTimeout(() => child.kill('SIGKILL'), 600_000)
        const onAbort = (): void => {
          child.kill('SIGKILL')
        }
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        const cleanup = (): void => {
          clearTimeout(timer)
          ctx.signal.removeEventListener('abort', onAbort)
        }

        child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
        child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')))

        child.on('error', (err) => {
          cleanup()
          const hint =
            (err as NodeJS.ErrnoException).code === 'ENOENT'
              ? ` — is Claude Code installed and on PATH? Set the binary path in Settings if needed.`
              : ''
          finish(fail(`claude_code: ${err.message}${hint}`))
        })

        child.on('close', (code) => {
          cleanup()
          const raw = stdout.trim()
          // --output-format json prints a single result object.
          try {
            const obj = JSON.parse(raw)
            const text = typeof obj.result === 'string' ? obj.result : raw
            const meta = {
              provider: 'anthropic',
              costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
              mode
            }
            if (obj.is_error) return finish(fail(`Claude reported an error:\n${text}`, meta))
            return finish(ok(text || '(Claude returned no text)', meta))
          } catch {
            // not JSON (e.g. an auth/usage error printed as text)
            if (code === 0 && raw) return finish(ok(raw, { provider: 'anthropic', mode }))
            const msg = (stderr.trim() || raw || `claude exited with code ${code}`).slice(0, 4000)
            return finish(fail(`claude_code failed (exit ${code}):\n${msg}`))
          }
        })
      })
    }
  }
}
