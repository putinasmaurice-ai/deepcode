import { join, isAbsolute, relative, dirname } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { runGit } from '../agent/tools/git'
import { PATHS, safeId } from '../paths'
import { getSession } from '../store'
import { reconstructStateBefore, ReconstructedFile } from './reconstruct'
import { TimeMachineFork, ForkResult } from '@shared/types'

// Branch-from-here: take the FS state a session had BEFORE a past turn (the tick) and materialize
// it as a brand-new LOCAL git branch — WITHOUT ever touching the live working tree and WITHOUT
// ever pushing. The reconstruction happens inside a throwaway worktree that is always torn down;
// only the branch ref survives for the user to review/checkout. Mirrors swarm-branches.ts (list/
// diff/delete are confined to timemachine/* refs) and the worktree machinery in agent/swarm.ts.

const DIFF_CAP = 60_000

// Only ever operate on timemachine/* branches with safe chars (a renderer-supplied name is guarded
// here so a list/diff/delete op can never reach a real branch or inject a git option).
export function isTimeMachineBranch(b: string): boolean {
  return typeof b === 'string' && /^timemachine\/[A-Za-z0-9._\-]+$/.test(b) && !b.includes('..')
}

// Resolve the project cwd from the persisted session — NEVER trust a renderer-supplied cwd.
function cwdOf(sessionId: string): string {
  const s = getSession(sessionId)
  if (!s?.cwd) throw new Error('Sitzung hat kein Arbeitsverzeichnis.')
  return s.cwd
}

// Map a reconstructed (absolute) file path onto its location inside the worktree. Returns null when
// the path lies OUTSIDE the project cwd (a git edit there would escape the worktree) — caller skips.
function inWorktree(f: ReconstructedFile, cwd: string, dir: string): string | null {
  // Prefer the precomputed rel; fall back to deriving it. Reject absolute/escaping rels.
  let rel = f.rel
  if (!rel || isAbsolute(rel)) rel = relative(cwd, f.path)
  if (!rel || isAbsolute(rel) || rel.startsWith('..')) return null
  return join(dir, rel)
}

export async function branchFromHere(sessionId: string, tick: number, signal: AbortSignal): Promise<ForkResult> {
  let applied = 0
  let skipped = 0
  let deleted = 0
  // teardown must survive an abort: runGit short-circuits on an aborted signal, so all cleanup
  // git ops use a fresh, never-aborted signal (same pattern as swarm.ts).
  const td = new AbortController().signal
  let cwd: string
  try {
    cwd = cwdOf(sessionId)
  } catch (e) {
    return { ok: false, applied, skipped, deleted, message: (e as Error).message }
  }

  // safeId throws on a malformed id — keep it inside a guard so the handler always gets a
  // structured ForkResult (never a rejected promise). Unreachable for a real stored session, but
  // hardens the error contract if the surrounding resolution is ever changed.
  let branch = ''
  let dir = ''
  try {
    branch = 'timemachine/' + safeId(sessionId).slice(0, 12) + '-t' + tick
    dir = join(PATHS.root, 'timemachine', safeId(sessionId), String(tick))
  } catch (e) {
    return { ok: false, applied, skipped, deleted, message: 'Ungültige Sitzungs-ID: ' + (e as Error).message }
  }
  if (!isTimeMachineBranch(branch)) {
    return { ok: false, applied, skipped, deleted, message: 'Konnte keinen gültigen Branch-Namen bilden.' }
  }
  let created = false

  try {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (e) {
      return { ok: false, applied, skipped, deleted, message: 'Worktree-Verzeichnis: ' + (e as Error).message }
    }

    // create the throwaway worktree on a new branch off the CURRENT HEAD (live tree untouched)
    const add = await runGit(['worktree', 'add', dir, '-b', branch], cwd, signal)
    if (add.code !== 0) {
      return { ok: false, applied, skipped, deleted, message: 'worktree add fehlgeschlagen: ' + add.out.slice(0, 300) }
    }
    created = true

    // apply the reconstructed pre-image into the worktree
    let files: ReconstructedFile[]
    try {
      files = reconstructStateBefore(sessionId, tick)
    } catch (e) {
      return { ok: false, applied, skipped, deleted, message: 'Rekonstruktion fehlgeschlagen: ' + (e as Error).message }
    }
    for (const f of files) {
      const target = inWorktree(f, cwd, dir)
      if (!target) {
        skipped++ // path outside cwd — cannot safely place it in the worktree
        continue
      }
      try {
        if (f.skipped) {
          skipped++ // pre-image not captured (locked/>5MB) — leave the HEAD version in place
        } else if (!f.existed) {
          if (existsSync(target)) rmSync(target) // file did not exist at the tick → remove it
          deleted++
        } else {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, f.content, 'utf8')
          applied++
        }
      } catch {
        skipped++ // a single-file failure must not abort the whole reconstruction
      }
    }

    // commit the reconstructed state on the new branch (inside the worktree)
    const iso = new Date(tick).toISOString()
    await runGit(['add', '-A'], dir, signal)
    const commit = await runGit(['commit', '-m', `Time Machine: Stand vor Turn ${iso}`, '--allow-empty'], dir, signal)
    if (commit.code !== 0) {
      return { ok: false, branch, applied, skipped, deleted, message: 'commit fehlgeschlagen: ' + commit.out.slice(0, 300) }
    }
    const sha = await runGit(['rev-parse', '--short', 'HEAD'], dir, signal)
    return {
      ok: true,
      branch,
      sha: sha.code === 0 ? sha.out.trim().slice(0, 40) : undefined,
      applied,
      skipped,
      deleted,
      message: `Branch „${branch}" erstellt: ${applied} Datei(en) wiederhergestellt, ${deleted} entfernt, ${skipped} übersprungen.`
    }
  } catch (e) {
    return { ok: false, branch, applied, skipped, deleted, message: 'Unerwarteter Fehler: ' + (e as Error).message }
  } finally {
    // ALWAYS tear down the worktree (on the non-aborted signal) — the branch ref persists.
    if (created) await runGit(['worktree', 'remove', '--force', dir], cwd, td)
    await runGit(['worktree', 'prune'], cwd, td)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

export async function listForks(sessionId: string, signal: AbortSignal): Promise<TimeMachineFork[]> {
  let cwd: string
  try {
    cwd = cwdOf(sessionId)
  } catch {
    return []
  }
  const r = await runGit(
    ['for-each-ref', '--format=%(refname:short)%09%(subject)', 'refs/heads/timemachine/'],
    cwd,
    signal
  )
  if (r.code !== 0) return []
  const out: TimeMachineFork[] = []
  for (const line of r.out.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const branch = line.slice(0, tab).trim()
    if (!isTimeMachineBranch(branch)) continue
    const subject = line.slice(tab + 1).trim()
    const stat = await runGit(['diff', '--stat', `HEAD...${branch}`], cwd, signal)
    out.push({ branch, subject, stat: stat.out.trim().slice(0, 4000) })
  }
  return out
}

export async function forkDiff(sessionId: string, branch: string, signal: AbortSignal): Promise<string> {
  if (!isTimeMachineBranch(branch)) return 'Ungültiger Branch-Name.'
  let cwd: string
  try {
    cwd = cwdOf(sessionId)
  } catch (e) {
    return (e as Error).message
  }
  const r = await runGit(['diff', `HEAD...${branch}`], cwd, signal)
  return r.out.slice(0, DIFF_CAP) || '(keine Unterschiede)'
}

export async function deleteFork(
  sessionId: string,
  branch: string,
  signal: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  if (!isTimeMachineBranch(branch)) return { ok: false, output: 'Ungültiger Branch-Name.' }
  let cwd: string
  try {
    cwd = cwdOf(sessionId)
  } catch (e) {
    return { ok: false, output: (e as Error).message }
  }
  const r = await runGit(['branch', '-D', branch], cwd, signal)
  return { ok: r.code === 0, output: r.out.trim() || `„${branch}" gelöscht.` }
}
