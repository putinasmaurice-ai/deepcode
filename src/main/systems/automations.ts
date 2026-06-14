import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
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
  // atomic write: a torn in-place write would leave automations.json corrupt, loadAutomations
  // would return [] (silently disabling EVERY automation), and the next save would persist that.
  const tmp = `${PATHS.automations}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    renameSync(tmp, PATHS.automations)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore cleanup failure */
    }
    throw e
  }
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

// Update an EXISTING automation's lastRun in place. Crucially does NOT create the
// entry if it was deleted while a (possibly minutes-long) run was in flight —
// otherwise the post-run write would resurrect a just-deleted automation.
export function recordAutomationRun(id: string, lastRun: number): void {
  const list = loadAutomations()
  const idx = list.findIndex((x) => x.id === id)
  if (idx < 0) return // deleted mid-run — do not resurrect
  list[idx] = { ...list[idx], lastRun }
  saveAutomations(list)
}

// ---- Minimal 5-field cron matcher: minute hour day month weekday ----
// Supports *, lists (1,2), ranges (1-5), steps (*/5, 1-30/2).

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/')
    const step = stepStr ? parseInt(stepStr, 10) : 1
    if (!(step >= 1)) continue // step 0 / NaN would make (value-lo)%step NaN → never fire
    let lo = min
    let hi = max
    if (range !== '*') {
      const bounds = range.split('-')
      lo = parseInt(bounds[0], 10)
      // a bare value WITH a step means "from value to max, by step" (Vixie cron: 5/15 → 5,20,35,50);
      // a bare value WITHOUT a step matches only that value.
      hi = bounds[1] !== undefined ? parseInt(bounds[1], 10) : stepStr ? max : lo
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue
    if (value < lo || value > hi) continue
    if ((value - lo) % step === 0) return true
  }
  return false
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, mon, dow] = fields
  const domMatch = matchField(dom, date.getDate(), 1, 31)
  // day-of-week: getDay() is 0-6 (Sun=0). Standard cron also accepts 7 for Sunday, so on a
  // Sunday additionally test the field against 7 (e.g. a `7` or `1-7` expression).
  const dowMatch =
    matchField(dow, date.getDay(), 0, 6) || (date.getDay() === 0 && matchField(dow, 7, 0, 7))
  // Standard cron: when BOTH day-of-month and day-of-week are restricted, the job
  // runs if EITHER matches (OR); otherwise the restricted one applies (AND with *).
  const dayMatch = dom !== '*' && dow !== '*' ? domMatch || dowMatch : domMatch && dowMatch
  return (
    matchField(min, date.getMinutes(), 0, 59) &&
    matchField(hour, date.getHours(), 0, 23) &&
    matchField(mon, date.getMonth() + 1, 1, 12) &&
    dayMatch
  )
}

export type AutomationRunner = (a: AutomationDef) => Promise<void>

// Replay at most this many recent minutes per tick so a missed minute (main process blocked
// across a boundary) still fires, while a long freeze/sleep can't unleash a backlog storm.
const MAX_CATCHUP_MINUTES = 5

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null
  private lastTickMinute = -1
  // in-flight runs keyed by automation id — overlap is prevented PER automation, not with a
  // single global flag (which would let one slow run swallow every other due automation's minute).
  private inFlight = new Set<string>()
  constructor(private runner: AutomationRunner) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 20_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    const now = new Date()
    const minuteKey = now.getHours() * 60 + now.getMinutes()
    if (minuteKey === this.lastTickMinute) return // evaluate the schedule at most once per minute
    this.lastTickMinute = minuteKey

    // Each tick fires every 20s but evaluates at most once per minute. If the main process is
    // blocked across one or more minute boundaries, those minutes' automations would never fire.
    // So replay each skipped minute, oldest first — BOUNDED to the last 5 to avoid a firing storm
    // after a long sleep/freeze. cronMatches is tested per minute; lastRun bookkeeping + per-id
    // overlap locks prevent double-firing a minute that already ran.
    const list = loadAutomations()
    for (let back = MAX_CATCHUP_MINUTES - 1; back >= 0; back--) {
      const at = new Date(now.getTime() - back * 60_000)
      this.fireDueMinute(list, at)
    }
  }

  // Fire every automation whose cron matches `at`'s minute and whose lastRun predates that minute.
  private fireDueMinute(list: AutomationDef[], at: Date): void {
    const minuteStart = new Date(at)
    minuteStart.setSeconds(0, 0)
    const minuteStartMs = minuteStart.getTime()
    for (const a of list) {
      if (!a.enabled) continue
      if (this.inFlight.has(a.id)) continue // a previous run of THIS automation is still going
      if ((a.lastRun ?? 0) >= minuteStartMs) continue // already ran for this minute (no double-fire)
      if (!cronMatches(a.schedule, at)) continue
      this.inFlight.add(a.id)
      const firedAt = minuteStartMs
      // dispatch concurrently (do NOT await) so a slow run can't block sibling automations
      // that are due in the same minute; track overlap per id.
      Promise.resolve()
        .then(() => this.runner(a))
        // only-update-if-still-present: never resurrect an automation deleted mid-run.
        .then(() => recordAutomationRun(a.id, firedAt))
        .catch((e) => console.error(`Automation "${a.name}" failed:`, (e as Error).message))
        .finally(() => this.inFlight.delete(a.id))
    }
  }
}
