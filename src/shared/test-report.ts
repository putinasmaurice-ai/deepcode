// Pure, dependency-free test-runner output parsing — shared so it's unit-testable without
// the engine/disk. The main-process verify-report.ts spawns the runner with a JSON reporter
// and hands the file/stdout text here. Mirrors the skill-test.ts house style.

export type TestFramework = 'vitest' | 'jest' | 'mocha' | 'pytest'

export interface TestFailure {
  name: string
  file?: string
  message: string
}
export interface TestReport {
  ok: boolean
  total: number
  passed: number
  failures: TestFailure[]
}

// Identify the runner from the verify command so we can pick the right reporter flag + parser.
export function detectFramework(cmd: string): TestFramework | null {
  const c = String(cmd || '')
  if (/\bvitest\b/.test(c)) return 'vitest'
  if (/\bjest\b/.test(c)) return 'jest'
  if (/\bmocha\b/.test(c)) return 'mocha'
  if (/\bpytest\b|\bpy\.test\b/.test(c)) return 'pytest'
  return null
}

// Augment a verify command to ALSO emit a machine-readable report to `tmpFile`. Honours the
// npm/pnpm/yarn `--` forwarding rule (flags after an existing ' -- ', else add one).
export function buildReporterCommand(cmd: string, framework: TestFramework, tmpFile: string): string {
  const t = JSON.stringify(tmpFile) // quote the path (spaces) for either shell
  let flags: string
  switch (framework) {
    case 'vitest':
      flags = `--reporter=json --outputFile=${t}`
      break
    case 'jest':
      flags = `--json --outputFile=${t}`
      break
    case 'mocha':
      flags = `--reporter json --reporter-options output=${t}`
      break
    case 'pytest':
      flags = `--json-report --json-report-file=${t}`
      break
  }
  if (/\b(npm|pnpm|yarn)\b/.test(cmd)) {
    return / -- /.test(cmd) ? `${cmd} ${flags}` : `${cmd} -- ${flags}`
  }
  return `${cmd} ${flags}`
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

// Parse a runner's JSON report into the normalized TestReport. Returns null on any shape
// mismatch / parse failure so the caller can fall back to raw-output behaviour.
export function parseReport(framework: TestFramework, text: string): TestReport | null {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  try {
    if (framework === 'vitest' || framework === 'jest') {
      const results = asArray(j.testResults)
      const failures: TestFailure[] = []
      let passed = 0
      let total = 0
      for (const tr of results as Record<string, unknown>[]) {
        const file = str(tr.name)
        for (const ar of asArray(tr.assertionResults) as Record<string, unknown>[]) {
          total++
          if (ar.status === 'passed') passed++
          else if (ar.status === 'failed')
            failures.push({
              name: str(ar.fullName) || str(ar.title) || '(test)',
              file,
              message: asArray(ar.failureMessages).map(str).join('\n').slice(0, 2000)
            })
        }
      }
      // prefer the runner's own total when present; derive passed from total−failures so the
      // two counts can never disagree (a runner may give one field but not the other).
      if (typeof j.numTotalTests === 'number') total = j.numTotalTests as number
      if (!total && !failures.length) return null
      passed = Math.max(0, total - failures.length)
      return { ok: failures.length === 0, total, passed, failures }
    }
    if (framework === 'pytest') {
      const tests = asArray(j.tests) as Record<string, unknown>[]
      const summary = (j.summary ?? {}) as Record<string, unknown>
      const failures: TestFailure[] = []
      for (const t of tests) {
        if (t.outcome === 'failed' || t.outcome === 'error') {
          const phase = (t.call ?? t.setup ?? t.teardown ?? {}) as Record<string, unknown>
          const crash = (phase.crash ?? {}) as Record<string, unknown>
          failures.push({
            name: str(t.nodeid) || '(test)',
            file: str(t.nodeid).split('::')[0] || undefined,
            message: (str(crash.message) || str(phase.longrepr)).slice(0, 2000)
          })
        }
      }
      const total = typeof summary.total === 'number' ? (summary.total as number) : tests.length
      const passed = typeof summary.passed === 'number' ? (summary.passed as number) : total - failures.length
      if (!total && !failures.length) return null
      return { ok: failures.length === 0, total, passed, failures }
    }
    // mocha
    const stats = (j.stats ?? {}) as Record<string, unknown>
    const failures: TestFailure[] = (asArray(j.failures) as Record<string, unknown>[]).map((f) => {
      const err = (f.err ?? {}) as Record<string, unknown>
      return {
        name: str(f.fullTitle) || str(f.title) || '(test)',
        file: str(f.file) || undefined,
        message: (str(err.message) + (err.stack ? '\n' + str(err.stack) : '')).slice(0, 2000)
      }
    })
    const total = typeof stats.tests === 'number' ? (stats.tests as number) : 0
    const passed = typeof stats.passes === 'number' ? (stats.passes as number) : total - failures.length
    if (!total && !failures.length) return null
    return { ok: failures.length === 0, total, passed, failures }
  } catch {
    return null
  }
}

// Build a compact, high-signal fix prompt from the failing tests — focuses the model on ONE
// (or few) concrete failures instead of a 5000-char wall of runner output.
export function focusFeedback(report: TestReport, max = 3): string {
  const shown = report.failures.slice(0, max)
  const head = `Tests: ${report.passed}/${report.total} grün, ${report.failures.length} rot.`
  const body = shown
    .map((f, i) => `\n[${i + 1}] ${f.name}${f.file ? `  (${f.file})` : ''}\n${f.message.slice(0, 800)}`)
    .join('\n')
  const more = report.failures.length > shown.length ? `\n\n… und ${report.failures.length - shown.length} weitere.` : ''
  return `${head}\nBehebe gezielt den/die folgenden fehlgeschlagenen Test(s) — Ursache analysieren, minimal fixen, keine Tests aufweichen:\n${body}${more}`
}
