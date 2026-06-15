import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS } from '../paths'
import { Mission, MissionTask } from '@shared/types'

// MORNING REPORT for a mission run (the overnight operator's deliverable). Mirrors nightshift.ts'
// report: a markdown file written to ~/.deepcode/missions/reports/ after a run, surfaced in the
// panel. Per-task: status, commit sha, per-milestone branch, cost. Plus an approve(keep) / rewind
// hint for each verified milestone so the user can review the LOCAL stack the run produced.
//
// Pure markdown assembly (no electron/fs side effects in buildMissionReport itself) so it can be
// unit-tested against a synthetic mission; writeMissionReport does the atomic disk write.

const ICON: Record<MissionTask['status'], string> = {
  pending: '⏳',
  running: '◐',
  done: '✅',
  failed: '❌'
}

const STATUS_LABEL: Record<Mission['status'], string> = {
  planning: 'in Planung',
  ready: 'bereit',
  running: 'läuft',
  done: 'abgeschlossen',
  failed: 'fehlgeschlagen',
  stopped: 'gestoppt',
  scheduled: 'geplant'
}

// Build the report markdown for a mission. Deterministic over the mission object — no I/O.
export function buildMissionReport(mission: Mission): string {
  const when = new Date(mission.lastRunAt ?? mission.updatedAt ?? Date.now()).toLocaleString()
  const tasks = Array.isArray(mission.tasks) ? mission.tasks : []
  const done = tasks.filter((t) => t.status === 'done').length
  const totalCost = tasks.reduce((s, t) => s + (t.cost ?? 0), 0)
  const totalTokens = tasks.reduce((s, t) => s + (t.tokens ?? 0), 0)

  const lines: string[] = []
  lines.push(`# 🎯 Mission-Bericht — ${when}`)
  lines.push('')
  lines.push(`**Ziel:** ${mission.goal || '(ohne Ziel)'}`)
  lines.push('')
  lines.push(
    `**Status:** ${STATUS_LABEL[mission.status] ?? mission.status} · ` +
      `${done}/${tasks.length} verifiziert · ` +
      `$${totalCost.toFixed(4)}${mission.branch ? ` · Branch \`${mission.branch}\`` : ''}`
  )
  if (mission.replansUsed) {
    lines.push('')
    lines.push(`_Umplanungen: ${mission.replansUsed}/${mission.maxReplans ?? 2}_`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const [i, t] of tasks.entries()) {
    const tag = t.kind === 'remediation' ? ' 🩹' : ''
    lines.push(`## ${ICON[t.status] ?? '•'} ${i + 1}. ${t.title}${tag}`)
    lines.push('')
    if (t.summary) {
      lines.push(t.summary.slice(0, 600))
      lines.push('')
    }
    const meta: string[] = []
    if (t.commit) meta.push(`commit \`${t.commit}\``)
    if (t.branch) meta.push(`Branch \`${t.branch}\``)
    if (t.attempts > 1) meta.push(`${t.attempts} Versuche`)
    if (t.tokens) meta.push(`${t.tokens.toLocaleString()} tok`)
    if (t.cost) meta.push(`$${t.cost.toFixed(4)}`)
    if (meta.length) {
      lines.push(`_${meta.join(' · ')}_`)
      lines.push('')
    }
    // per-milestone review hints: keep (already on the mission branch) or rewind to BEFORE this
    // milestone. LOCAL git only — the user runs these by hand after reviewing the stack.
    if (t.status === 'done' && t.commit) {
      lines.push('> Behalten: bereits auf dem Mission-Branch.' + (t.branch ? ` Review: \`git diff ${t.commit}^ ${t.commit}\`.` : ''))
      lines.push(`> Zurückrollen (lokal): \`git revert --no-edit ${t.commit}\`.`)
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('')
  lines.push(`**Gesamt:** ${done}/${tasks.length} verifiziert · ${totalTokens.toLocaleString()} Tokens · $${totalCost.toFixed(4)}`)
  if (mission.status === 'failed') {
    lines.push('')
    lines.push('_⚠ Mission abgebrochen — eine Aufgabe blieb nach erneutem Versuch (und ggf. Umplanung) rot. Es wurde nicht auf einer kaputten Basis weitergebaut._')
  }
  return lines.join('\n') + '\n'
}

const REPORT_DIR = join(PATHS.root, 'missions', 'reports')

function ensureDir(): void {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true })
}

// Where a mission's report lives. One file per mission (overwritten each run) so the panel always
// points at the latest. Reuses the store's safeId rule via the id slug guard below.
export function missionReportPath(missionId: string): string {
  const id = /^[A-Za-z0-9_-]+$/.test(missionId) ? missionId : 'mission'
  return join(REPORT_DIR, `${id}.md`)
}

// Build + atomically write the report; return its path (assigned to mission.reportPath by the caller).
export function writeMissionReport(mission: Mission): string {
  ensureDir()
  const path = missionReportPath(mission.id)
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, buildMissionReport(mission), 'utf8')
    renameSync(tmp, path)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best-effort cleanup */
    }
    throw e
  }
  return path
}
