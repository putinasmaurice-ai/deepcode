import { randomUUID } from 'crypto'
import { AgentEvent, AppSettings, ChatMessage, Session } from '@shared/types'
import { AgentEngine } from './agent/engine'
import { getProject, upsertProject } from './projects'
import { saveSession } from './store'
import { usageSummaryText } from './usage'
import { rewindLastTurn } from './checkpoints'
import { listJobs, killJob } from './jobs'
import { loadCommands } from './systems/commands'
import { loadSkills } from './systems/skills'
import { loadSubagents } from './systems/subagents'
import { pluginCommands, pluginSkills, pluginSubagents } from './systems/plugins'

// Built-in slash commands (/help, /goal, /cost, …) as a registry instead of an
// inline if-chain in the IPC layer. Each handler fully services the command;
// sendMessage returns early when one matched.

export interface BuiltinCtx {
  session: Session
  args: string
  emit: (e: AgentEvent) => void
  engine: AgentEngine
  settings: AppSettings
}

type BuiltinHandler = (ctx: BuiltinCtx) => Promise<string | void> | string | void

// Push a synthetic assistant message (no API call).
export function emitInfo(emit: (e: AgentEvent) => void, content: string): void {
  const id = randomUUID()
  const message: ChatMessage = { id, role: 'assistant', content: '', createdAt: Date.now() }
  emit({ type: 'message_start', message })
  emit({ type: 'content_delta', messageId: id, delta: content })
  emit({ type: 'message_done', message: { ...message, content } })
}

const builtins = new Map<string, BuiltinHandler>()

builtins.set('help', ({ emit, session }) => {
  const cmds = [...loadCommands(session.cwd), ...pluginCommands()]
  const skills = [...loadSkills(session.cwd), ...pluginSkills()]
  const agents = [...loadSubagents(session.cwd), ...pluginSubagents()]
  const lines: string[] = []
  lines.push('## DeepCode — Hilfe\n')
  lines.push('**Was ich kann:** Codebasen verstehen, Dateien lesen/erstellen/ändern, Terminal-Befehle ausführen, Bugs fixen, Features projektweit implementieren, Tests ausführen, Refactorings planen.\n')
  lines.push('**Built-in Tools:** read_file, write_file, edit_file, apply_patch, list_dir, glob, grep, run_command, Hintergrund-Jobs, web_fetch, task (Subagents), use_skill, todo_write + alle MCP-Tools.\n')
  lines.push('**Built-in Befehle:**')
  lines.push('- `/help` — diese Übersicht')
  lines.push('- `/init` — Projekt analysieren und DEEPCODE.md schreiben')
  lines.push('- `/goal [Ziel|clear]` — dauerhaftes Ziel setzen/anzeigen/löschen')
  lines.push('- `/cost` — Kostenübersicht (pro Chat / Projekt / gesamt)')
  lines.push('- `/model [id]` — Modell dieser Session anzeigen/wechseln')
  lines.push('- `/compact` — ältere Nachrichten zusammenfassen (Kontext sparen)')
  lines.push('- `/rewind` — Datei-Änderungen der letzten Runde rückgängig machen')
  lines.push('- `/jobs [kill <id>]` — Hintergrund-Jobs anzeigen/stoppen')
  lines.push('- `/learn [Fokus]` — aus diesem Chat einen wiederverwendbaren Skill destillieren')
  lines.push('- `/remember` — bleibende Fakten aus diesem Chat ins Memory aufnehmen')
  if (cmds.length) {
    lines.push('\n**Eigene Befehle:**')
    for (const c of cmds) lines.push(`- \`/${c.name}\` — ${c.description}`)
  }
  if (skills.length)
    lines.push(`\n**Skills (${skills.length}):** ` + skills.slice(0, 30).map((s) => s.name).join(', ') + (skills.length > 30 ? ', …' : ''))
  if (agents.length) lines.push('\n**Subagents:** ' + agents.map((a) => a.name).join(', '))
  lines.push('\nAlles verwaltbar über die Sidebar (Projekte, Skills, Commands, Subagents, MCP, Hooks, Memory, Automations, Plugins, Kosten, Nachtschicht).')
  emitInfo(emit, lines.join('\n'))
})

builtins.set('goal', ({ session, args, emit }) => {
  const project = session.projectId ? getProject(session.projectId) : null
  if (!args) {
    const current = project?.goal || session.goal
    emitInfo(
      emit,
      current
        ? `🎯 **Aktuelles Goal${project ? ` (Projekt „${project.name}")` : ''}:**\n\n${current}\n\n_Ändern mit \`/goal <neues Ziel>\` · löschen mit \`/goal clear\`_`
        : 'Kein Goal gesetzt. Setze eines mit `/goal <dein Ziel>` — es wird dauerhaft in jeden System-Prompt eingespeist.'
    )
  } else if (args === 'clear') {
    if (project) upsertProject({ ...project, goal: undefined, goalSetAt: undefined })
    session.goal = undefined
    saveSession(session)
    emitInfo(emit, '🎯 Goal gelöscht.')
  } else {
    if (project) upsertProject({ ...project, goal: args, goalSetAt: Date.now() })
    else {
      session.goal = args
      saveSession(session)
    }
    emitInfo(
      emit,
      `🎯 **Goal gesetzt${project ? ` für Projekt „${project.name}"` : ''}:**\n\n${args}\n\nJede weitere Antwort wird daran ausgerichtet.`
    )
  }
})

builtins.set('cost', ({ emit }) => emitInfo(emit, usageSummaryText()))

builtins.set('model', ({ session, args, emit, settings }) => {
  if (args) {
    session.model = args
    saveSession(session)
    emitInfo(emit, `Modell für diese Session: **${args}**`)
  } else {
    emitInfo(
      emit,
      `Aktuelles Modell: **${session.model || settings.provider.model}**\nVerfügbar: \`${settings.provider.model}\`, \`${settings.provider.reasonerModel}\` + lokale (\`local:…\`)\nWechseln mit \`/model <id>\``
    )
  }
})

builtins.set('compact', async ({ session, emit, engine }) => {
  const updated = await engine.compactSession(session, emit)
  emit({ type: 'session', session: updated })
})

builtins.set('rewind', ({ session, emit }) => {
  const restored = rewindLastTurn(session.id)
  emitInfo(
    emit,
    restored.length
      ? `⏪ **Rewind:** ${restored.length} Datei(en) auf den Stand vor der letzten Änderungsrunde zurückgesetzt:\n${restored.map((p) => `- \`${p}\``).join('\n')}\n\n_Nochmal /rewind setzt die Runde davor zurück._`
      : 'Keine Checkpoints vorhanden — es wurde in dieser Session noch nichts geändert.'
  )
})

builtins.set('jobs', ({ args, emit }) => {
  if (args.startsWith('kill ')) {
    const id = args.slice(5).trim()
    emitInfo(emit, killJob(id) ? `🛑 Job \`${id}\` gestoppt.` : `Job \`${id}\` nicht gefunden oder beendet.`)
    return
  }
  const all = listJobs()
  emitInfo(
    emit,
    all.length
      ? `## Hintergrund-Jobs\n${all
          .map(
            (j) =>
              `- \`${j.id}\` **${j.status}**${j.exitCode !== null ? ` (exit ${j.exitCode})` : ''} — \`${j.command.slice(0, 70)}\``
          )
          .join('\n')}\n\n_Stoppen mit \`/jobs kill <id>\`._`
      : 'Keine Hintergrund-Jobs. Der Agent startet sie mit `run_background_command` (z.B. Dev-Server).'
  )
})

builtins.set('learn', async ({ session, args, emit, engine }) => {
  if (session.messages.filter((m) => m.role === 'assistant').length === 0) {
    emitInfo(emit, 'Noch nichts zu lernen — führe erst eine Aufgabe in diesem Chat durch, dann destilliere ich daraus einen Skill.')
    return
  }
  emit({ type: 'status', message: 'Destilliere Skill aus diesem Chat…' })
  try {
    const skill = await engine.distillSkill(session, args)
    emitInfo(
      emit,
      `🎓 **Skill gelernt:** \`${skill.name}\`\n\nGespeichert unter \`${skill.path}\`. Ab sofort steht er in jedem Chat zur Verfügung — ich lade ihn automatisch, wenn eine ähnliche Aufgabe kommt. Bearbeiten kannst du ihn im Skills-Panel.`
    )
  } catch (e) {
    emitInfo(emit, `Destillation fehlgeschlagen: ${(e as Error).message}`)
  }
})

builtins.set('remember', async ({ session, emit, engine }) => {
  if (session.messages.filter((m) => m.role === 'assistant').length === 0) {
    emitInfo(emit, 'Noch nichts zu merken — führe erst eine Aufgabe in diesem Chat durch.')
    return
  }
  emit({ type: 'status', message: 'Extrahiere bleibende Fakten aus diesem Chat…' })
  try {
    const saved = await engine.extractMemories(session)
    emitInfo(
      emit,
      saved.length
        ? `🧠 **Gemerkt (${saved.length}):** ${saved.map((n) => `\`${n}\``).join(', ')}\n\nFließt ab sofort (semantisch relevant) in künftige Chats ein. Verwalten im Memory-Panel.`
        : 'Nichts Neues, Dauerhaftes gefunden — die wichtigen Fakten sind schon im Memory.'
    )
  } catch (e) {
    emitInfo(emit, `Extraktion fehlgeschlagen: ${(e as Error).message}`)
  }
})

// /init expands into a normal agent turn — signalled by returning the prompt.
builtins.set('init', ({ args }) => {
  return (
    'Analyze this project: explore the directory structure, identify the tech stack, ' +
    'entry points, key modules, build/test commands and conventions. Then write a concise ' +
    'DEEPCODE.md at the project root documenting all of that so future sessions have context. ' +
    (args ? `Extra guidance: ${args}` : '')
  )
})

// Returns: 'handled' (turn done), a string (expanded prompt for a normal turn),
// or null (not a builtin).
export async function runBuiltin(
  cmd: string,
  ctx: BuiltinCtx
): Promise<'handled' | string | null> {
  const handler = builtins.get(cmd)
  if (!handler) return null
  const result = await handler(ctx)
  return typeof result === 'string' ? result : 'handled'
}
