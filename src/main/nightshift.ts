import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS } from './paths'
import { AgentEvent, NightShiftState, NightTask, Session } from '@shared/types'
import { inOffPeak } from '@shared/offpeak'
import { AgentEngine } from './agent/engine'
import { saveSession, loadSettings } from './store'
import { overDailyCap } from './ledger'
import { beginAgentOp, endAgentOp } from './watcher'

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
  // atomic write (tmp + rename) so a crash mid-write can't corrupt the queue file
  const tmp = FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify({ ...state, running }, null, 2), 'utf8')
  renameSync(tmp, FILE)
  return getNightShift()
}

// Merge a status update for ONE task into the persisted queue by id, without
// rewriting the whole list from a stale in-memory snapshot. This stops a long
// run from clobbering concurrent user edits (added/removed/reordered tasks), and
// won't resurrect a task the user deleted mid-run (skipped when not found).
function updateTask(id: string, patch: Partial<NightTask>): void {
  const cur = getNightShift()
  const idx = cur.tasks.findIndex((t) => t.id === id)
  if (idx < 0) return
  cur.tasks[idx] = { ...cur.tasks[idx], ...patch }
  saveNightShift(cur)
}

export function requestStop(): void {
  stopRequested = true
}

// DeepSeek off-peak discount window: UTC 16:30–00:30 (chat −50%, reasoner −75%).
// Shared window logic lives in src/shared/offpeak.ts.
export function inOffPeakWindow(d = new Date()): boolean {
  return inOffPeak(d)
}

export async function runNightShift(
  engine: AgentEngine,
  emit: (e: AgentEvent) => void
): Promise<NightShiftState> {
  if (running) throw new Error('Nachtschicht läuft bereits.')
  running = true
  stopRequested = false
  const state = getNightShift()

  // optionally hold until DeepSeek's discount window opens
  if (state.waitForOffPeak) {
    while (!inOffPeakWindow() && !stopRequested) {
      emit({
        type: 'status',
        sessionId: 'nightshift', // background id → renderer drops it (no foreground bleed)
        message: '🌙 Nachtschicht wartet auf das DeepSeek-Off-Peak-Fenster (UTC 16:30–00:30, bis −75%)…'
      })
      await new Promise((r) => setTimeout(r, 60_000))
    }
  }
  const lines: string[] = [`# 🌙 Nachtschicht-Bericht — ${new Date().toLocaleString()}`, '']

  try {
    const dailyCap = loadSettings().maxCostPerDay
    for (const task of state.tasks) {
      if (stopRequested) break
      // daily spend cap: stop the (unattended, overnight) run once today's budget is used up.
      if (overDailyCap(dailyCap)) {
        emit({ type: 'status', sessionId: 'nightshift', message: `🌙 Nachtschicht gestoppt — Tagesbudget ($${dailyCap}) erreicht.` })
        lines.push(`\n_⚠ Abgebrochen: Tagesbudget ($${dailyCap}) erreicht — restliche Aufgaben nicht ausgeführt._`)
        break
      }
      if (task.status === 'done') continue
      task.status = 'running'
      updateTask(task.id, { status: 'running' })
      emit({ type: 'status', sessionId: 'nightshift', message: `🌙 Nachtschicht: "${task.prompt.slice(0, 60)}…"` })

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
        beginAgentOp()
        try {
          // Night Shift is fully unattended (runs overnight while the user is away) → gate
          // high-blast-radius tools (MCP/claude_code/task/git push|pr), like workflows/automations.
          await engine.runTurn(session, task.prompt, emit, state.autonomy, undefined, true)
        } finally {
          endAgentOp()
        }
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
      // merge this task's result by id (don't clobber concurrent queue edits)
      updateTask(task.id, {
        status: task.status,
        summary: task.summary,
        tokens: task.tokens,
        cost: task.cost
      })

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
    // re-read so report metadata doesn't overwrite concurrent queue edits
    const cur = getNightShift()
    cur.lastReportPath = reportPath
    cur.lastRunAt = Date.now()
    saveNightShift(cur)
    emit({ type: 'status', sessionId: 'nightshift', message: `🌙 Nachtschicht fertig — Bericht: ${reportPath}` })
  } finally {
    running = false
    saveNightShift(getNightShift()) // flip running off without clobbering the live queue
  }
  return getNightShift()
}
