import { describe, it, expect } from 'vitest'
import { WorkflowWatchManager, matchesWatch } from '../src/main/workflows/watch-trigger'
import type { WorkflowDef } from '../src/shared/types'

// The file-watch trigger: a saved workflow with trigger.mode='filewatch' fires when a
// matching file under the project changes. We unit-test the match + throttle + in-flight
// guard via the injectable dispatch() (no real fs watcher / store needed).

function wf(id: string, cfg: Record<string, unknown>): WorkflowDef {
  return { id, name: id, createdAt: 0, updatedAt: 0, nodes: [{ id: 't', type: 'trigger', config: { mode: 'filewatch', ...cfg } }], edges: [] }
}

describe('workflow file-watch trigger', () => {
  it('matchesWatch: path-prefix + basename glob', () => {
    expect(matchesWatch('src/app.ts', '', '')).toBe(true) // empty path = whole project
    expect(matchesWatch('src/app.ts', 'src', '')).toBe(true)
    expect(matchesWatch('docs/app.ts', 'src', '')).toBe(false) // outside watched subtree
    expect(matchesWatch('src/app.ts', 'src', '*.ts')).toBe(true)
    expect(matchesWatch('src/app.js', 'src', '*.ts')).toBe(false) // glob excludes
    expect(matchesWatch('src/app.ts', 'src/app.ts', '')).toBe(true) // exact file
  })

  it('matchesWatch: a pathological all-wildcard glob cannot ReDoS-freeze (returns fast)', () => {
    // adjacent '*'s used to compile to `.*.*.*…` → catastrophic backtracking (~86s). Now
    // every '*' run collapses to a single `[^/]*`, so a non-matching name returns instantly.
    const t = Date.now()
    expect(matchesWatch('a'.repeat(120), 'a'.repeat(120), '*'.repeat(40) + 'X')).toBe(false)
    expect(Date.now() - t).toBeLessThan(200)
  })

  it('fires only matching workflows, injecting changed files as input', () => {
    const fired: Array<{ id: string; input?: string }> = []
    const defs = [wf('a', { path: 'src', glob: '*.ts' }), wf('b', { path: 'docs' })]
    const m = new WorkflowWatchManager(
      (def, input) => { fired.push({ id: def.id, input }) },
      () => '/tmp',
      () => 1_000_000, // realistic clock (Date.now() is always >> the throttle window)
      () => defs
    )
    m.dispatch(['src/app.ts', 'README.md'])
    expect(fired).toEqual([{ id: 'a', input: 'src/app.ts' }]) // b's 'docs' didn't match
  })

  it('throttles a workflow to one fire per MIN_INTERVAL and guards an in-flight run', () => {
    const fired: string[] = []
    const defs = [wf('a', { path: 'src' })]
    let now = 1_000_000
    let resolveRun!: () => void
    const m = new WorkflowWatchManager(
      (def) => { fired.push(def.id); return new Promise<void>((r) => { resolveRun = r }) },
      () => '/tmp',
      () => now,
      () => defs
    )
    m.dispatch(['src/a.ts']) // fires, run in flight
    m.dispatch(['src/b.ts']) // in-flight guard → no second fire
    expect(fired).toEqual(['a'])
    resolveRun() // run finishes (active cleared on the next microtask)
    return Promise.resolve().then(() => {
      now += 1000 // still inside the 5s throttle window
      m.dispatch(['src/c.ts'])
      expect(fired).toEqual(['a'])
      now += 5000 // past the throttle floor
      m.dispatch(['src/d.ts'])
      expect(fired).toEqual(['a', 'a'])
    })
  })
})
