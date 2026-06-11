import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PATHS } from '../paths'
import { AutomationDef } from '@shared/types'

// Automations / routines: cron-scheduled prompts that run the agent headlessly.
// Stored in ~/.deepcode/automations.json. A 60s ticker fires due jobs.

export function loadAutomations(): AutomationDef[] {
  if (!existsSync(PATHS.automations)) return []
  try {
    return JSON.parse(readFileSync(PATHS.automations, 'utf8')) as AutomationDef[]
  } catch {
    return []
  }
}

export function saveAutomations(list: AutomationDef[]): void {
  writeFileSync(PATHS.automations, JSON.stringify(list, null, 2), 'utf8')
}

export function upsertAutomation(a: AutomationDef): AutomationDef[] {
  const list = loadAutomations()
  const idx = list.findIndex((x) => x.id === a.id)
  if (idx >= 0) list[idx] = a
  else list.push(a)
  saveAutomations(list)
  return list
}

export function deleteAutomation(id: string): AutomationDef[] {
  const list = loadAutomations().filter((x) => x.id !== id)
  saveAutomations(list)
  return list
}

// ---- Minimal 5-field cron matcher: minute hour day month weekday ----
// Supports *, lists (1,2), ranges (1-5), steps (*/5, 1-30/2).

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    let [range, stepStr] = part.split('/')
    const step = stepStr ? parseInt(stepStr, 10) : 1
    let lo = min
    let hi = max
    if (range !== '*') {
      const bounds = range.split('-')
      lo = parseInt(bounds[0], 10)
      hi = bounds[1] !== undefined ? parseInt(bounds[1], 10) : lo
    }
    if (value < lo || value > hi) continue
    if ((value - lo) % step === 0) return true
  }
  return false
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, mon, dow] = fields
  return (
    matchField(min, date.getMinutes(), 0, 59) &&
    matchField(hour, date.getHours(), 0, 23) &&
    matchField(dom, date.getDate(), 1, 31) &&
    matchField(mon, date.getMonth() + 1, 1, 12) &&
    matchField(dow, date.getDay(), 0, 6)
  )
}

export type AutomationRunner = (a: AutomationDef) => Promise<void>

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null
  private lastTickMinute = -1
  constructor(private runner: AutomationRunner) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 20_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    const now = new Date()
    const minuteKey = now.getHours() * 60 + now.getMinutes()
    if (minuteKey === this.lastTickMinute) return // run at most once per minute
    this.lastTickMinute = minuteKey

    for (const a of loadAutomations()) {
      if (!a.enabled) continue
      if (cronMatches(a.schedule, now)) {
        try {
          await this.runner(a)
          a.lastRun = now.getTime()
          upsertAutomation(a)
        } catch (e) {
          console.error(`Automation "${a.name}" failed:`, (e as Error).message)
        }
      }
    }
  }
}
