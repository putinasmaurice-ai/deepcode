import { WorkflowDef } from '@shared/types'
import { listWorkflows } from './store'
import { cronMatches } from '../systems/automations'

// Fires saved workflows whose TRIGGER node is configured for a cron schedule — this is
// what turns the builder into "automation software". Mirrors AutomationScheduler: a 20s
// ticker, at most one fire per workflow per absolute minute, no overlap with itself.

// `input` is passed by the file-watch trigger (the changed file list); cron passes nothing.
export type WorkflowTriggerRunner = (def: WorkflowDef, input?: string) => Promise<void> | void

export class WorkflowScheduler {
  private timer: NodeJS.Timeout | null = null
  private lastFired = new Map<string, number>() // workflowId -> absolute-minute key
  private active = new Set<string>() // workflowIds whose previous run is still in flight
  private ticking = false
  constructor(private runner: WorkflowTriggerRunner) {}

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 20_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = new Date()
      // absolute-minute key (never repeats across days), so a daily cron fires every day
      const minuteKey = Math.floor(now.getTime() / 60_000)
      for (const def of listWorkflows()) {
        const nodes = Array.isArray(def.nodes) ? def.nodes : []
        const trigger = nodes.find((n) => n.type === 'trigger')
        const cfg = trigger?.config || {}
        if (cfg.mode !== 'cron') continue
        const cron = String(cfg.cron ?? '').trim()
        if (!cron) continue
        if (this.lastFired.get(def.id) === minuteKey) continue // already fired this minute
        if (this.active.has(def.id)) continue // previous run still in flight — don't stack
        if (!cronMatches(cron, now)) continue
        this.lastFired.set(def.id, minuteKey)
        this.active.add(def.id)
        try {
          const p = this.runner(def)
          if (p && typeof p.then === 'function') p.finally(() => this.active.delete(def.id))
          else this.active.delete(def.id)
        } catch (e) {
          this.active.delete(def.id)
          console.error(`Workflow-Trigger "${def.name}" failed:`, (e as Error).message)
        }
      }
    } finally {
      this.ticking = false
    }
  }
}
