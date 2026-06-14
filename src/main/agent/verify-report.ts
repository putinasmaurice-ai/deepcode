import { readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { runVerify } from './verify'
import { detectFramework, buildReporterCommand, parseReport, TestReport } from '@shared/test-report'

// Runs the project's verify command and, when the runner is a known test framework, ALSO
// captures a machine-readable report so the engine can give the auto-fixer focused per-test
// feedback instead of a 5000-char wall. Fully backward compatible: on any framework/parse
// miss it degrades to the plain { ok, output } contract of runVerify.

export interface StructuredVerify {
  ok: boolean
  output: string // raw tail (fallback + context)
  report?: TestReport // present only when a JSON report parsed cleanly
}

// only augment a SINGLE simple runner invocation — never a chained/scripted command, where
// appending flags after the last token would land on the wrong process and could break it.
function isSimpleInvocation(cmd: string): boolean {
  return !/(\&\&|\|\||;|\||>|<|`|\$\()/.test(cmd)
}

export async function runStructuredVerify(command: string, cwd: string, signal: AbortSignal): Promise<StructuredVerify> {
  const framework = detectFramework(command)
  if (!framework || !isSimpleInvocation(command)) {
    const v = await runVerify(command, cwd, signal)
    return { ok: v.ok, output: v.output }
  }
  const tmp = join(tmpdir(), `dc-testreport-${randomUUID()}.json`)
  try {
    const v = await runVerify(buildReporterCommand(command, framework, tmp), cwd, signal)
    let report: TestReport | null = null
    if (existsSync(tmp)) {
      try {
        const text = readFileSync(tmp, 'utf8')
        if (text.trim()) report = parseReport(framework, text)
      } catch {
        /* unreadable → fall back */
      }
    }
    if (report) {
      // combine signals: a parsed report wins for per-test detail, but a NON-ZERO exit still
      // counts as failure (coverage threshold, a runner crash after tests, etc.) — never upgrade
      // a non-zero exit to ok.
      return { ok: report.ok && v.ok, output: v.output, report }
    }
    // No report produced (e.g. pytest without the json plugin, or the flag broke the runner):
    // re-run the ORIGINAL bare command so the augmentation can NEVER turn a passing gate red.
    const bare = await runVerify(command, cwd, signal)
    return { ok: bare.ok, output: bare.output }
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best effort */
    }
  }
}
