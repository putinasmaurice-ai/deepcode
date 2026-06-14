import { runGit } from './agent/tools/git'
import { SwarmBranch } from '@shared/types'

// Merge-gate backend for swarm mode: list / diff / merge / delete the swarm/* branches a swarm
// run produced. The git branches ARE the source of truth (no separate store — survives restarts
// and stays correct even if the user deletes branches manually). All mutating ops are confined
// to swarm/* branch names so the panel can never touch a real branch.

export type { SwarmBranch }

// Guard: only ever operate on swarm/* branches with safe chars (the renderer supplies the name).
export function isSwarmBranch(b: string): boolean {
  return typeof b === 'string' && /^swarm\/[A-Za-z0-9._/-]+$/.test(b) && !b.includes('..')
}

const DIFF_CAP = 60_000

export async function listSwarmBranches(cwd: string, signal: AbortSignal): Promise<SwarmBranch[]> {
  const r = await runGit(['for-each-ref', '--format=%(refname:short)%09%(subject)', 'refs/heads/swarm/'], cwd, signal)
  if (r.code !== 0) return []
  const out: SwarmBranch[] = []
  for (const line of r.out.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const branch = line.slice(0, tab).trim()
    if (!isSwarmBranch(branch)) continue
    const subject = line.slice(tab + 1).trim()
    const stat = await runGit(['diff', '--stat', `HEAD...${branch}`], cwd, signal)
    out.push({ branch, subject, stat: stat.out.trim().slice(0, 4000) })
  }
  return out
}

export async function swarmBranchDiff(cwd: string, branch: string, signal: AbortSignal): Promise<string> {
  if (!isSwarmBranch(branch)) return 'Ungültiger Branch-Name.'
  const r = await runGit(['diff', `HEAD...${branch}`], cwd, signal)
  return r.out.slice(0, DIFF_CAP) || '(keine Unterschiede)'
}

// Merge a swarm branch into the current HEAD. On conflict (or any failure) the merge is ABORTED
// so the repo is never left in a half-merged/conflicted state — the user is told to merge manually.
export async function swarmMerge(cwd: string, branch: string, signal: AbortSignal): Promise<{ ok: boolean; output: string }> {
  if (!isSwarmBranch(branch)) return { ok: false, output: 'Ungültiger Branch-Name.' }
  // NEVER merge into a dirty tree: a merge that refuses (or conflicts) followed by `merge --abort`
  // would reset to HEAD and silently DISCARD the user's uncommitted work. Require a clean tree.
  const st = await runGit(['status', '--porcelain'], cwd, signal)
  if (st.out.trim()) {
    return { ok: false, output: 'Arbeitsverzeichnis ist nicht sauber — bitte zuerst committen oder stashen, dann erneut mergen.' }
  }
  const m = await runGit(['merge', '--no-edit', branch], cwd, signal)
  if (m.code === 0) return { ok: true, output: m.out.trim() || `„${branch}" gemerged.` }
  // undo the failed/conflicted merge — and only claim "safely aborted" if the abort ACTUALLY succeeded
  const ab = await runGit(['merge', '--abort'], cwd, signal)
  return {
    ok: false,
    output:
      ab.code === 0
        ? `Merge von „${branch}" fehlgeschlagen (Konflikt) — sicher abgebrochen, das Repo ist sauber. Bitte manuell mergen.\n\n${m.out.slice(0, 2000)}`
        : `⚠ Merge von „${branch}" fehlgeschlagen UND der Abbruch ebenfalls — das Repo ist evtl. halb-gemerged. Bitte SOFORT prüfen (git status / git merge --abort).\n\n${m.out.slice(0, 1500)}\n--- abort ---\n${ab.out.slice(0, 500)}`
  }
}

export async function swarmDeleteBranch(cwd: string, branch: string, signal: AbortSignal): Promise<{ ok: boolean; output: string }> {
  if (!isSwarmBranch(branch)) return { ok: false, output: 'Ungültiger Branch-Name.' }
  const r = await runGit(['branch', '-D', branch], cwd, signal)
  return { ok: r.code === 0, output: r.out.trim() || `„${branch}" gelöscht.` }
}
