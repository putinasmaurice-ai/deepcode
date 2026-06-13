import { watch, FSWatcher } from 'fs'
import { sep } from 'path'

// Live watcher: notifies the renderer when project files change OUTSIDE the
// agent (editor saves, git operations). Deliberately conservative: debounced,
// ignore-listed, and fully suppressed while the agent itself is working.

export const IGNORE = /(^|[\\/])(node_modules|\.git|out|dist|release|\.next|\.cache|\.venv|__pycache__|\.deepcode)([\\/]|$)|CHANGELOG-DEEPCODE\.md$|\.log$|~$/

let watcher: FSWatcher | null = null
let watchedCwd: string | null = null
let pending = new Set<string>()
let timer: NodeJS.Timeout | null = null

// agent-activity suppression: ref-count of running agent operations + cooldown
let agentOps = 0
let cooldownUntil = 0

export function beginAgentOp(): void {
  agentOps++
}
export function endAgentOp(): void {
  agentOps = Math.max(0, agentOps - 1)
  cooldownUntil = Date.now() + 5000 // file events can trail the op slightly
}
function suppressed(): boolean {
  return agentOps > 0 || Date.now() < cooldownUntil
}

// Exposed so the workflow file-watch trigger reuses the SAME suppression: while the
// agent or any (cron/manual/watch) workflow run is in flight, file events are the
// app's own writes — firing on them would create self-trigger storms/loops.
export function agentBusy(): boolean {
  return suppressed()
}

export function startWatch(cwd: string, onChange: (files: string[]) => void): void {
  if (watchedCwd === cwd && watcher) return
  stopWatch()
  try {
    watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      if (!filename || suppressed()) return
      const rel = String(filename).split(sep).join('/')
      if (IGNORE.test(rel)) return
      pending.add(rel)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!suppressed() && pending.size) {
          onChange([...pending].slice(0, 10))
        }
        pending = new Set()
      }, 1500)
    })
    watchedCwd = cwd
  } catch {
    watcher = null
    watchedCwd = null
  }
}

export function stopWatch(): void {
  if (timer) clearTimeout(timer)
  timer = null
  pending = new Set()
  try {
    watcher?.close()
  } catch {
    /* ignore */
  }
  watcher = null
  watchedCwd = null
}
