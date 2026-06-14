// Bounded-concurrency worker pool: runs tasks with at most `concurrency` in flight, aborting
// on signal or when the absolute deadline passes. A task that throws rejects the whole pool
// (callers wrap tasks to implement continue-on-error); AbortError always propagates.
// failFast note: on the first failure we stop PULLING new tasks (so no further sub-runs start),
// but tasks already in flight run to completion — we don't forcibly cancel a mid-await sub-run.
// Generic + dependency-free so the workflow executor AND the swarm orchestrator can share it.
export async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal: AbortSignal,
  deadline?: number
): Promise<T[]> {
  const results = new Array<T>(tasks.length)
  let cursor = 0
  let failed = false
  const n = Math.max(1, Math.min(concurrency, 8, tasks.length || 1))
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (deadline && Date.now() > deadline) throw new Error('Zeitbudget überschritten — gestoppt.')
      if (failed) return // a sibling already failed (failFast) — don't launch more
      const i = cursor++
      if (i >= tasks.length) return
      try {
        results[i] = await tasks[i]!()
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker))
  return results
}
