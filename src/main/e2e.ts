import { app } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadSettings, saveSession, deleteSession } from './store'
import { AgentEngine } from './agent/engine'
import { AgentEvent, Session } from '@shared/types'

// Headless end-to-end smoke mode: set DEEPCODE_E2E_PROMPT (+ optional
// DEEPCODE_E2E_CWD / DEEPCODE_E2E_LOG) to run one real agent turn through the
// full engine (tools, prompt, settings, checkpoints) without a window, then quit.
// Used by CI-style smoke tests; never active in normal app starts.

export async function maybeRunE2E(): Promise<boolean> {
  const prompt = process.env.DEEPCODE_E2E_PROMPT
  if (!prompt) return false

  const cwd = process.env.DEEPCODE_E2E_CWD || process.cwd()
  const logPath = process.env.DEEPCODE_E2E_LOG || join(cwd, 'deepcode-e2e.log')
  const lines: string[] = []
  const log = (s: string): void => {
    lines.push(s)
    console.log('[E2E]', s)
  }
  let sessionId: string | null = null

  try {
    const settings = loadSettings()
    // The stored key is encrypted via safeStorage and may not decrypt in a headless
    // run; let CI/smoke tests supply a plaintext key via env so a real turn can run.
    if (process.env.DEEPCODE_E2E_API_KEY) settings.provider.apiKey = process.env.DEEPCODE_E2E_API_KEY
    const engine = new AgentEngine(settings)
    const session: Session = {
      id: randomUUID(),
      title: '[e2e] ' + prompt.replace(/\s+/g, ' ').slice(0, 40),
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      model: process.env.DEEPCODE_E2E_MODEL || settings.provider.model
    }
    saveSession(session)
    sessionId = session.id
    log(`PROMPT: ${prompt}`)
    log(`CWD: ${cwd} | MODEL: ${session.model}`)

    const emit = (e: AgentEvent): void => {
      if (e.type === 'message_done' && e.message.role === 'assistant') {
        if (e.message.toolCalls?.length)
          log('CALLS: ' + e.message.toolCalls.map((t) => t.name).join(', '))
        if (e.message.content) log('ASSISTANT: ' + e.message.content.slice(0, 1500))
      } else if (e.type === 'tool_result') {
        log(`TOOL ${e.name}: ${e.result.ok ? 'ok' : 'FAIL'} | ${e.result.content.split('\n')[0].slice(0, 160)}`)
      } else if (e.type === 'error') {
        log('ERROR: ' + e.message)
      } else if (e.type === 'status') {
        log('STATUS: ' + e.message)
      }
    }

    // 'full' policy: headless run, no approval UI available → unattended gate (consistent
    // with workflows/automations/night-shift: no MCP/claude_code/task/git push|pr)
    await engine.runTurn(session, prompt, emit, 'full', undefined, true)

    let tokens = 0
    let cost = 0
    for (const m of session.messages) {
      if (m.usage) {
        tokens += m.usage.totalTokens
        cost += m.usage.cost
      }
    }
    log(`TOTAL: ${tokens} tokens | $${cost.toFixed(5)} | ${session.messages.length} messages`)
    log('E2E_DONE')
  } catch (e) {
    log('E2E_FATAL: ' + (e as Error).message)
  }

  try {
    writeFileSync(logPath, lines.join('\n') + '\n', 'utf8')
  } catch {
    /* ignore */
  }
  // smoke sessions are throwaway — don't clutter the user's chat list
  if (sessionId) {
    try {
      deleteSession(sessionId)
    } catch {
      /* ignore */
    }
  }
  app.quit()
  return true
}
