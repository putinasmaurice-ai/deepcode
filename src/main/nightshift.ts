import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS } from './paths'
import { AgentEvent, NightShiftState, Session } from '@shared/types'
import { AgentEngine } from './agent/engine'
import { saveSession } from './store'

// Night shift: a queue of tasks the agent works through autonomously
// (e.g. overnight), producing a morning report. State persists in
// ~/.deepcode/nightshift.json so a queued list survives restarts.

const FILE = join(PATHS.root, 'nightshift.json')
let stopRequested = false
let running = false

export function getNightShift(): NightShiftState {
  if (existsSync(FILE)) {
    try {
      const s = JSON.parse(readFileSync(FILE, 'utf8')) as NightShiftState
      s.running = running // runtime truth beats persisted flag
      return s
    } catch {
      /* fall through */
    }
  }
  return { tasks: [], running: false, autonomy: 'safe' }
}

export function saveNightShift(state: NightShiftState): NightShiftState {
  writeFileSync(FILE, JSON.stringify({ ...state, running }, null, 2), 'utf8')
  return getNightShift()
}

export function requestStop(): void {
  stopRequested = true
}

export async function runNightShift(
  engine: AgentEngine,
  emit: (e: AgentEvent) => void
): Promise<NightShiftState> {
  if (running) throw new Error('Nachtschicht läuft bereits.')
  running = true
  stopRequested = false
  const state = getNightShift()
  const lines: string[] = [`# 🌙 Nachtschicht-Bericht — ${new Date().toLocaleString()}`, '']

  try {
    for (const task of state.tasks) {
      if (stopRequested) break
      if (task.status === 'done') continue
      task.status = 'running'
      saveNightShift(state)
      emit({ type: 'status', message: `🌙 Nachtschicht: "${task.prompt.slice(0, 60)}…"` })

      const session: Session = {
        id: randomUUID(),
        title: `[🌙] ${task.prompt.replace(/\s+/g, ' ').slice(0, 45)}`,
        cwd: task.cwd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        projectId: task.projectId
      }
      saveSession(session)

      try {
        await engine.runTurn(session, task.prompt, emit, state.autonomy)
        const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant')
        let tokens = 0
        let cost = 0
        for (const m of session.messages) {
          if (m.usage) {
            tokens += m.usage.totalTokens
            cost += m.usage.cost
          }
        }
        task.status = 'done'
        task.summary = (lastAssistant?.content ?? '(keine Antwort)').slice(0, 600)
        task.tokens = tokens
        task.cost = cost
      } catch (e) {
        task.status = 'failed'
        task.summary = (e as Error).message
      }
      saveNightShift(state)

      lines.push(`## ${task.status === 'done' ? '✅' : '❌'} ${task.prompt}`)
      lines.push('')
      lines.push(task.summary ?? '')
      if (task.tokens) lines.push(`\n_${task.tokens.toLocaleString()} Tokens · $${(task.cost ?? 0).toFixed(4)}_`)
      lines.push('')
    }

    const totalCost = state.tasks.reduce((s, t) => s + (t.cost ?? 0), 0)
    lines.push('---')
    lines.push(
      `**Gesamt:** ${state.tasks.filter((t) => t.status === 'done').length}/${state.tasks.length} erledigt · $${totalCost.toFixed(4)}`
    )
    const reportPath = join(PATHS.root, `nightshift-report-${new Date().toISOString().slice(0, 10)}.md`)
    writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8')
    state.lastReportPath = reportPath
    state.lastRunAt = Date.now()
    saveNightShift(state)
    emit({ type: 'status', message: `🌙 Nachtschicht fertig — Bericht: ${reportPath}` })
  } finally {
    running = false
    saveNightShift(state)
  }
  return getNightShift()
}
