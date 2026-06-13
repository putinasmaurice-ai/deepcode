import { watch, FSWatcher } from 'fs'
import { sep } from 'path'
import { WorkflowDef } from '@shared/types'
import { listWorkflows } from './store'
import { IGNORE, agentBusy } from '../watcher'
import { WorkflowTriggerRunner } from './scheduler'

// Fires saved workflows whose TRIGGER node is set to mode='filewatch' when a matching
// file under the project changes — the event-driven sibling of the cron scheduler. One
// recursive watcher on the cwd; each (debounced) change is matched against every
// filewatch workflow's path/glob and dispatched to the SAME guarded runner as cron.

const DEBOUNCE_MS = 1200
const MIN_INTERVAL_MS = 5000 // per-workflow floor so a save burst fires a run at most this often

// Minimal glob -> regex, anchored, applied ONLY to a basename (never contains '/').
// Runs of '*' collapse to a SINGLE `[^/]*` so two unbounded quantifiers can never sit
// adjacent — otherwise a glob like `****…*X` is catastrophic-backtracking ReDoS that
// freezes the main event loop for tens of seconds on a non-matching name.
function globToRe(glob: string): RegExp {
  let body = ''
  for (const ch of glob.replace(/\*+/g, '*')) {
    if (ch === '*') body += '[^/]*'
    else if (ch === '?') body += '[^/]'
    else body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${body}$`)
}

// exported for unit tests: does a changed rel-path fall under watchPath (prefix) + glob (basename)?
export function matchesWatch(rel: string, watchPath: string, glob: string): boolean {
  if (watchPath && rel !== watchPath && !rel.startsWith(watchPath + '/')) return false
  // basename only + length-capped: defense-in-depth against a pathological glob/name
  if (glob && !globToRe(glob).test((rel.split('/').pop() || rel).slice(0, 256))) return false
  return true
}

export class WorkflowWatchManager {
  private watcher: FSWatcher | null = null
  private boundCwd: string | null = null
  private pending = new Set<string>()
  private debounce: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private lastFired = new Map<string, number>() // workflowId -> ms
  private active = new Set<string>() // in-flight workflowIds (guarded by the runner promise)
  constructor(
    private runner: WorkflowTriggerRunner,
    private getCwd: () => string,
    private now: () => number = () => Date.now(),
    private list: () => WorkflowDef[] = listWorkflows // injectable for tests
  ) {}

  start(): void {
    this.rebind()
    if (!this.heartbeat) this.heartbeat = setInterval(() => this.rebind(), 30_000) // follow defaultCwd changes
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.debounce) clearTimeout(this.debounce)
    this.heartbeat = this.debounce = null
    try {
      this.watcher?.close()
    } catch {
      /* ignore */
    }
    this.watcher = null
    this.boundCwd = null
    this.pending.clear()
  }

  private rebind(): void {
    const cwd = this.getCwd()
    if (cwd === this.boundCwd && this.watcher) return
    try {
      this.watcher?.close()
    } catch {
      /* ignore */
    }
    this.watcher = null
    this.boundCwd = null
    try {
      this.watcher = watch(cwd, { recursive: true }, (_e, filename) => {
        if (!filename || agentBusy()) return // our own writes while busy — never self-trigger
        const rel = String(filename).split(sep).join('/')
        if (IGNORE.test(rel)) return
        this.pending.add(rel)
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => this.dispatch(), DEBOUNCE_MS)
      })
      this.boundCwd = cwd
    } catch {
      this.watcher = null
    }
  }

  // exposed for unit testing the match/throttle logic without a real fs watcher
  dispatch(files?: string[]): void {
    const changed = files ?? [...this.pending]
    this.pending.clear()
    if (!changed.length || agentBusy()) return
    const now = this.now()
    for (const def of this.list()) {
      const trigger = (Array.isArray(def.nodes) ? def.nodes : []).find((n) => n.type === 'trigger')
      const cfg = trigger?.config || {}
      if (cfg.mode !== 'filewatch') continue
      if (this.active.has(def.id)) continue
      if (now - (this.lastFired.get(def.id) ?? 0) < MIN_INTERVAL_MS) continue
      const watchPath = String(cfg.path ?? '').trim().replace(/^\.?\//, '').replace(/\/$/, '')
      const glob = String(cfg.glob ?? '').trim()
      const hits = changed.filter((rel) => matchesWatch(rel, watchPath, glob))
      if (!hits.length) continue
      this.lastFired.set(def.id, now)
      this.active.add(def.id)
      try {
        const p = this.runner(def, hits.join('\n'))
        if (p && typeof p.then === 'function') p.finally(() => this.active.delete(def.id))
        else this.active.delete(def.id)
      } catch (e) {
        this.active.delete(def.id)
        console.error(`Workflow-Filewatch "${def.name}" failed:`, (e as Error).message)
      }
    }
  }
}
