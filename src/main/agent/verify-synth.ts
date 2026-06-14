import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname, resolve, relative, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import { runVerify } from './verify'
import { PATHS } from '../paths'
import { Snapshot } from '../checkpoints'

// Test synthesis support for turns WITHOUT a project verifyCommand: detect the test framework,
// and PROVE a synthesized test red-first — it must FAIL against the reverted (pre-change) code
// and PASS against the current code. A test that passes against the old code doesn't
// discriminate the new behaviour (it's grading nothing) and is rejected. The revert is an
// in-memory swap with a GUARANTEED restore so the agent's work is never left undone.

export interface SynthFramework {
  name: 'vitest' | 'jest' | 'mocha' | 'pytest'
  runFile: (testFile: string) => string // command to run ONE test file
  testGlobHint: string // where/how to name the test file (for the synthesis prompt)
}

const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|[\\/])(test_[^\\/]+|[^\\/]+_test)\.py$)/i
export function isTestFile(p: string): boolean {
  return TEST_FILE_RE.test(p)
}

function readPkg(cwd: string): { scripts?: Record<string, string>; deps: Record<string, string> } | null {
  try {
    const j = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>
    return {
      scripts: (j.scripts as Record<string, string>) || {},
      deps: { ...((j.dependencies as object) || {}), ...((j.devDependencies as object) || {}) } as Record<string, string>
    }
  } catch {
    return null
  }
}

export function detectTestFramework(cwd: string): SynthFramework | null {
  const pkg = readPkg(cwd)
  if (pkg) {
    const blob = (JSON.stringify(pkg.deps) + ' ' + JSON.stringify(pkg.scripts || {})).toLowerCase()
    if (/vitest/.test(blob)) return { name: 'vitest', runFile: (f) => `npx vitest run ${JSON.stringify(f)}`, testGlobHint: 'neben der Quelldatei als <name>.test.ts (Vitest)' }
    if (/jest/.test(blob)) return { name: 'jest', runFile: (f) => `npx jest ${JSON.stringify(f)}`, testGlobHint: 'neben der Quelldatei als <name>.test.js (Jest)' }
    if (/mocha/.test(blob)) return { name: 'mocha', runFile: (f) => `npx mocha ${JSON.stringify(f)}`, testGlobHint: 'unter test/ als <name>.spec.js (Mocha)' }
  }
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py')) || existsSync(join(cwd, 'requirements.txt'))) {
    return { name: 'pytest', runFile: (f) => `pytest ${JSON.stringify(f)}`, testGlobHint: 'als test_<name>.py (pytest)' }
  }
  return null
}

export interface RedFirstResult {
  discriminates: boolean // the test FAILED against the reverted (old) code → it actually checks the change
  green: boolean // the test PASSES against the current code
  output: string // the relevant runner output (red phase if non-discriminating, else green phase)
  incomplete?: boolean // a changed source couldn't be reverted (>5MB/binary marker) → can't prove
}

// True only if `p` resolves INSIDE `cwd` — proveRedFirst must never write a snapshot path that
// (through tampering/corruption) points outside the project.
function insideCwd(p: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), resolve(p))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}
// Read current content. null = a READ FAILURE on an existing file (NOT an empty file) — the
// caller must abort rather than risk restoring '' over the agent's work.
function readCurrent(p: string): { existed: boolean; content: string } | null {
  if (!existsSync(p)) return { existed: false, content: '' }
  try {
    return { existed: true, content: readFileSync(p, 'utf8') }
  } catch {
    return null
  }
}
function writeState(path: string, existed: boolean, content: string): boolean {
  try {
    if (existed) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
    } else if (existsSync(path)) {
      rmSync(path)
    }
    return true
  } catch {
    return false
  }
}

// Prove a synthesized test red-first WITHOUT risking the agent's work:
// 1) capture each non-test source's CURRENT (post-change) content to memory + a disk backup —
//    ABORT before touching anything if a source can't be read (never revert what we can't restore);
// 2) revert sources to their pre-image, run the test → expect RED (proves it discriminates);
// 3) restore the current content (retried), run again → expect GREEN.
// Restore is guaranteed in finally; a restore that still fails throws loudly and KEEPS the backups.
export async function proveRedFirst(
  testFile: string,
  snapshots: Snapshot[],
  runFileCmd: string,
  cwd: string,
  signal: AbortSignal,
  confine = true
): Promise<RedFirstResult> {
  const sources = snapshots.filter((s) => s.path !== testFile && (!confine || insideCwd(s.path, cwd)))
  // ABSTAIN if any changed source has no captured pre-image (snapshotter skipped a >5MB/locked
  // file): we cannot faithfully revert it, so a red/green verdict would be wrong. Touch nothing.
  if (sources.some((s) => s.skipped)) return { discriminates: false, green: false, output: 'incomplete', incomplete: true }
  const backupDir = join(PATHS.root, 'tmp', `synth-${randomUUID()}`)
  // CAPTURE first — abort entirely if any existing source is unreadable
  const captured: { path: string; existed: boolean; content: string }[] = []
  for (const s of sources) {
    const cur = readCurrent(s.path)
    if (!cur) throw new Error(`Beweis abgebrochen: „${s.path}" ist nicht lesbar — es wird NICHTS verändert.`)
    if (cur.existed) {
      try {
        mkdirSync(backupDir, { recursive: true })
        writeFileSync(join(backupDir, `${captured.length}.bak`), cur.content, 'utf8')
      } catch {
        throw new Error('Beweis abgebrochen: konnte kein Sicherungs-Backup anlegen — es wird NICHTS verändert.')
      }
    }
    captured.push({ path: s.path, existed: cur.existed, content: cur.content })
  }
  // a manifest maps each <i>.bak back to its real path → unambiguous manual recovery if a
  // restore ever fails (the .bak files are otherwise index-named).
  if (captured.some((c) => c.existed)) {
    try {
      writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(captured.map((c, i) => ({ i, path: c.path, existed: c.existed })), null, 2), 'utf8')
    } catch {
      /* manifest is a convenience — its absence doesn't compromise the .bak contents */
    }
  }

  let restored = false
  let restoreFailures: string[] = []
  const doRestore = (): void => {
    if (restored) return
    restored = true
    for (const c of captured) {
      let ok = false
      for (let i = 0; i < 3 && !ok; i++) ok = writeState(c.path, c.existed, c.content)
      if (!ok) restoreFailures.push(c.path)
    }
  }

  try {
    for (const s of sources) writeState(s.path, s.existed, s.content) // → pre-image (old code)
    const red = await runVerify(runFileCmd, cwd, signal)
    doRestore()
    if (restoreFailures.length)
      throw new Error(`Konnte ${restoreFailures.length} Datei(en) nach dem Beweis nicht wiederherstellen: ${restoreFailures.join(', ')} — Backups liegen unter ${backupDir}.`)
    if (red.ok) return { discriminates: false, green: true, output: red.output } // green on OLD code → vacuous
    const green = await runVerify(runFileCmd, cwd, signal)
    return { discriminates: true, green: green.ok, output: green.output }
  } finally {
    doRestore() // guarantee restore on every path (abort/throw)
    // keep backups if anything failed to restore; otherwise clean up
    if (!restoreFailures.length) {
      try {
        rmSync(backupDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
}
