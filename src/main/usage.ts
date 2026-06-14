import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'
import { Session, UsageSummary } from '@shared/types'
import { loadProjects } from './projects'
import { lifetimeTotals, monthTotals } from './ledger'

// Aggregates token usage + estimated cost across all stored sessions:
// per session, per project, and total. Reads session files on demand —
// cheap enough for a settings-panel refresh.

export function computeUsageSummary(): UsageSummary {
  const projects = loadProjects()
  const projName = new Map(projects.map((p) => [p.id, p.name]))

  const perSession: UsageSummary['perSession'] = []
  let files: string[] = []
  try {
    files = readdirSync(PATHS.sessions).filter((f) => f.endsWith('.json'))
  } catch {
    files = []
  }

  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(PATHS.sessions, f), 'utf8')) as Session
      let tokens = 0
      let cost = 0
      for (const m of s.messages ?? []) {
        if (m.usage) {
          tokens += m.usage.totalTokens
          cost += m.usage.cost
        }
      }
      perSession.push({
        id: s.id,
        title: s.title || 'Untitled',
        projectId: s.projectId,
        tokens,
        cost,
        updatedAt: s.updatedAt
      })
    } catch {
      /* skip corrupt session */
    }
  }

  const byProject = new Map<string, { tokens: number; cost: number; sessions: number }>()
  for (const s of perSession) {
    const key = s.projectId ?? ''
    const agg = byProject.get(key) ?? { tokens: 0, cost: 0, sessions: 0 }
    agg.tokens += s.tokens
    agg.cost += s.cost
    agg.sessions += 1
    byProject.set(key, agg)
  }

  const perProject = [...byProject.entries()]
    .map(([projectId, agg]) => ({
      projectId,
      name: projectId ? (projName.get(projectId) ?? '(deleted project)') : 'Ohne Projekt',
      ...agg
    }))
    .sort((a, b) => b.cost - a.cost)

  perSession.sort((a, b) => b.updatedAt - a.updatedAt)

  // Headline totals come from the persistent ledger so they never drop when
  // chats are deleted. The per-project / per-chat breakdown stays live (existing
  // sessions only).
  const life = lifetimeTotals()
  const mon = monthTotals()
  return {
    total: { tokens: life.tokens, cost: life.cost, sessions: perSession.length },
    month: { tokens: mon.tokens, cost: mon.cost },
    perProject,
    perSession
  }
}

// Compact text version for the /cost slash command.
export function usageSummaryText(): string {
  const u = computeUsageSummary()
  const fmt = (c: number): string => '$' + c.toFixed(4)
  const lines: string[] = []
  lines.push(`## Kostenübersicht`)
  lines.push('')
  lines.push(
    `**Gesamt:** ${u.total.tokens.toLocaleString()} Tokens · ${fmt(u.total.cost)} · ${u.total.sessions} Chats`
  )
  if (u.perProject.length) {
    lines.push('')
    lines.push('**Pro Projekt:**')
    for (const p of u.perProject) {
      lines.push(`- ${p.name}: ${p.tokens.toLocaleString()} Tokens · ${fmt(p.cost)} (${p.sessions} Chats)`)
    }
  }
  const top = u.perSession.filter((s) => s.tokens > 0).slice(0, 8)
  if (top.length) {
    lines.push('')
    lines.push('**Letzte Chats:**')
    for (const s of top) {
      lines.push(`- ${s.title}: ${s.tokens.toLocaleString()} Tokens · ${fmt(s.cost)}`)
    }
  }
  lines.push('')
  lines.push('_Mehr Details im Usage-Panel (Sidebar → Kosten)._')
  return lines.join('\n')
}
