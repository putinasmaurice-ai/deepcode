import { Mission } from '@shared/types'
import { listMissions } from './store'
import { cronMatches } from '../systems/automations'
import { inOffPeak } from '@shared/offpeak'

// OVERNIGHT OPERATOR: fires SCHEDULED missions whose window is currently open — turning Mission
// Control into a "set it and walk away" operations center. Mirrors WorkflowScheduler: a 20s ticker,
// at most one fire per mission per absolute minute, no overlap with itself. The actual guarded start
// (clean-tree / daily-cap / one-mission-at-a-time) lives in the runner the ipc layer supplies —
// this class only decides WHICH due mission to hand it, one at a time.
//
// `mode: cron` is RECURRING: it fires on each matching 5-field cron minute. The mission's status is
// consumed (driven to a terminal state) by the run, so the ipc launcher RE-ARMS a cron mission back
// to 'scheduled' (with a reset plan) after each run — that, plus the per-minute lastFired key, is
// what makes a nightly cron fire again every night without double-firing within a minute.
// `mode: offpeak` is SINGLE-SHOT by design: it fires once when the discount window is open and is NOT
// re-armed (re-arming would re-fire continuously across the whole window). Re-schedule it to run again.

export type MissionTriggerRunner = (mission: Mission) => Promise<void> | void

export class MissionScheduler {
  private timer: NodeJS.Timeout | null = null
  private lastFired = new Map<string, number>() // missionId -> absolute-minute key
  private active = false // a fired mission's runner is still in flight — never stack a second
  private ticking = false
  constructor(private runner: MissionTriggerRunner) {}

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 20_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // Is THIS mission's schedule window open right now? Pure so it can be unit-tested.
  private isDue(m: Mission, now: Date): boolean {
    if (m.status !== 'scheduled' || !m.schedule) return false
    if (m.schedule.mode === 'offpeak') return inOffPeak(now)
    if (m.schedule.mode === 'cron') {
      const cron = String(m.schedule.cron ?? '').trim()
      return !!cron && cronMatches(cron, now)
    }
    return false
  }

  private tick(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      // one scheduled mission's runner already in flight → don't even scan (one-at-a-time guard,
      // mirroring the ipc layer's missionRunning latch — belt and suspenders).
      if (this.active) return
      const now = new Date()
      // absolute-minute key (never repeats across days) so a daily cron / nightly off-peak fires
      // again each day, but at most once per minute per mission.
      const minuteKey = Math.floor(now.getTime() / 60_000)
      for (const m of listMissions()) {
        if (this.lastFired.get(m.id) === minuteKey) continue // already fired this minute
        if (!this.isDue(m, now)) continue
        this.lastFired.set(m.id, minuteKey)
        this.active = true
        try {
          const p = this.runner(m)
          if (p && typeof p.then === 'function') p.finally(() => (this.active = false))
          else this.active = false
        } catch (e) {
          this.active = false
          console.error(`Mission-Trigger "${m.goal.slice(0, 40)}" failed:`, (e as Error).message)
        }
        break // only ONE mission per tick — the next due one waits for the active run to finish
      }
    } finally {
      this.ticking = false
    }
  }
}
