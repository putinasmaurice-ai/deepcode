import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AgentEvent, AppSettings, ChatMessage, Session, WorkflowDef } from '@shared/types'
import { AgentEngine } from './agent/engine'
import { getProject, upsertProject } from './projects'
import { listWorkflows } from './workflows/store'
import { resolveWorkflow } from './workflows/wf-name-match'
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

// Result of running a workflow from chat. The output/error are already secret-MASKED by the
// provider (ipc.ts owns the maskList), so the builtin can safely echo them into the transcript.
export interface ChatWorkflowResult {
  status: 'done' | 'error' | 'cancelled'
  output: string
  error?: string
}

export interface BuiltinCtx {
  session: Session
  args: string
  emit: (e: AgentEvent) => void
  engine: AgentEngine
  settings: AppSettings
  // Run a saved workflow unattended and return its (masked) final output. Provided by the IPC
  // layer, which holds the workflow-run machinery (makeWfDeps); absent in contexts that can't run.
  runWorkflowFromChat?: (def: WorkflowDef, input: string) => Promise<ChatWorkflowResult>
  // Swarm mode: plan a task into independent shards and run them in parallel isolated git
  // worktrees; returns a chat-ready report. Provided by the IPC layer.
  runSwarmFromChat?: (task: string) => Promise<string>
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
  lines.push('- `/wf [Name] [Eingabe]` — gespeicherten Workflow auflisten/aus dem Chat starten')
  lines.push('- `/swarm <Aufgabe>` — Aufgabe parallel von mehreren Agenten in isolierten git-Worktrees bearbeiten (je ein Branch)')
  lines.push('- `/skill-test <name>` — einen Skill gegen seine tests.json prüfen (offline mit `mock`)')
  lines.push('- `/blueprint [Plan|generate]` — PROJECT.md-Plan setzen/erzeugen (wird in Subagents & Workflows injiziert)')
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

builtins.set('skill-test', async ({ args, emit, engine, session }) => {
  const name = args.trim()
  if (!name) {
    emitInfo(emit, 'Nutzung: `/skill-test <skill-name>` — prüft einen Skill gegen seine `tests.json` (Szenarien mit expected/forbidden; `mock`-Antworten laufen offline/gratis).')
    return
  }
  emit({ type: 'status', message: `Teste Skill „${name}"…` })
  try {
    const { found, results } = await engine.testSkill(name, session.cwd)
    if (!found) {
      emitInfo(emit, `Skill „${name}" nicht gefunden. \`/help\` listet verfügbare Skills.`)
      return
    }
    if (!results.length) {
      emitInfo(emit, `Skill „${name}" hat keine Tests. Lege eine \`tests.json\` neben die SKILL.md (siehe code-review als Beispiel).`)
      return
    }
    const passed = results.filter((r) => r.pass).length
    const lines = results.map((r) => {
      const head = `${r.pass ? '✅' : '❌'} ${r.name}${r.usedMock ? ' _(mock)_' : ''}`
      if (r.pass) return head
      const det: string[] = []
      if (r.missingExpect.length) det.push(`fehlt: ${r.missingExpect.map((s) => `\`${s}\``).join(', ')}`)
      if (r.hitForbid.length) det.push(`verboten gefunden: ${r.hitForbid.map((s) => `\`${s}\``).join(', ')}`)
      return `${head}\n   ${det.join(' · ')}`
    })
    emitInfo(emit, `## 🧪 Skill-Test „${name}": ${passed}/${results.length} bestanden\n\n${lines.join('\n')}`)
  } catch (e) {
    emitInfo(emit, `Skill-Test fehlgeschlagen: ${(e as Error).message}`)
  }
})

// /blueprint — view/set/generate the task-scoped PROJECT.md blueprint. It is injected (cwd-based)
// into the main turn AND delegated subagents AND workflow agent nodes, so delegated work follows
// the same plan and doesn't drift.
builtins.set('blueprint', ({ session, args, emit }) => {
  const rootPath = join(session.cwd, 'PROJECT.md')
  const dotPath = join(session.cwd, '.deepcode', 'PROJECT.md')
  const read = (): { name: string; text: string } | null => {
    for (const [name, p] of [['PROJECT.md', rootPath], ['.deepcode/PROJECT.md', dotPath]] as const) {
      if (existsSync(p)) {
        try {
          return { name, text: readFileSync(p, 'utf8') }
        } catch {
          /* ignore */
        }
      }
    }
    return null
  }
  const a = args.trim()
  if (!a) {
    const cur = read()
    emitInfo(
      emit,
      cur
        ? `📋 **Blueprint (${cur.name})** — fließt in Haupt-Chat, Subagents & Workflow-Agent-Schritte:\n\n${cur.text.slice(0, 4000)}\n\n_Ändern: \`/blueprint <Plan>\` · neu generieren: \`/blueprint generate\`_`
        : 'Kein **PROJECT.md**-Blueprint in diesem Projekt. Ein Blueprint ist ein task-scoped Plan (Architektur, Entscheidungen, Konventionen, nächste Schritte), der in **alle** Agenten — auch delegierte Subagents und Workflow-Agent-Schritte — injiziert wird, damit nichts vom Plan abweicht.\n\nSetzen: `/blueprint <Plan-Text>` · automatisch erzeugen: `/blueprint generate`'
    )
    return
  }
  if (a === 'generate') {
    // expand into a normal agent turn that writes PROJECT.md
    return (
      'Analysiere dieses Projekt und schreibe eine knappe, plan-first **PROJECT.md** in den Projekt-Root: ' +
      'Zweck, Architektur/Schlüsselmodule, Konventionen und den aktuellen Plan/nächste Schritte. ' +
      'Halte sie kompakt (die „source of truth" für die laufende Arbeit, an der sich auch delegierte Subagents ausrichten). ' +
      'Nutze write_file für PROJECT.md.'
    )
  }
  try {
    writeFileSync(rootPath, a + '\n', 'utf8')
    emitInfo(emit, '📋 Blueprint in `PROJECT.md` gespeichert. Fließt ab sofort in Haupt-Chat, Subagents und Workflow-Agent-Schritte.')
  } catch (e) {
    emitInfo(emit, `Konnte PROJECT.md nicht schreiben: ${(e as Error).message}`)
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

builtins.set('wf', async ({ args, emit, runWorkflowFromChat }) => {
  const all = listWorkflows()
  if (!args.trim()) {
    emitInfo(
      emit,
      all.length
        ? `## Workflows (${all.length})\n${all
            .map((w) => `- \`${w.name}\`${w.description ? ` — ${w.description}` : ''}`)
            .join('\n')}\n\n_Starten mit \`/wf <Name> [Eingabe]\`. Die Eingabe steht im Workflow als \`{{input}}\` zur Verfügung; das Ergebnis kommt aus der Variable \`output\` (sonst \`result\`/\`last\`). Läuft unbeaufsichtigt (ohne Freigabe-Dialoge)._`
        : 'Noch keine Workflows. Erstelle einen im **Workflows-Panel** (visueller Editor) und starte ihn dann hier mit `/wf <Name>`.'
    )
    return
  }
  if (!all.length) {
    emitInfo(emit, 'Noch keine Workflows vorhanden. Erstelle einen im **Workflows-Panel**.')
    return
  }
  const { def, input, matches } = resolveWorkflow(all, args.trim())
  if (!def) {
    emitInfo(
      emit,
      matches.length
        ? `Kein Workflow „${args.trim()}" gefunden. Meintest du:\n${matches.map((w) => `- \`${w.name}\``).join('\n')}`
        : `Kein Workflow „${args.trim()}" gefunden. \`/wf\` ohne Argumente listet alle.`
    )
    return
  }
  if (!runWorkflowFromChat) {
    emitInfo(emit, 'Workflow-Ausführung steht in diesem Kontext nicht zur Verfügung.')
    return
  }
  emit({ type: 'status', message: `Starte Workflow „${def.name}"…` })
  try {
    const res = await runWorkflowFromChat(def, input)
    if (res.status === 'done') {
      // cap the echoed result so a huge workflow output can't bloat the session / jank the chat
      // (the full result stays available in the workflow's run history).
      const full = res.output.trim()
      const MAX_ECHO = 8000
      const shown = full.length > MAX_ECHO ? `${full.slice(0, MAX_ECHO)}\n\n_…(${full.length - MAX_ECHO} Zeichen gekürzt — vollständig im Verlauf)_` : full
      emitInfo(
        emit,
        `✅ **Workflow „${def.name}" abgeschlossen.**${shown ? `\n\n${shown}` : '\n\n_(keine Textausgabe)_'}`
      )
    } else if (res.status === 'cancelled') {
      emitInfo(emit, `⏹️ Workflow „${def.name}" abgebrochen.`)
    } else {
      emitInfo(emit, `❌ Workflow „${def.name}" fehlgeschlagen: ${res.error || 'unbekannter Fehler'}`)
    }
  } catch (e) {
    emitInfo(emit, `❌ Workflow „${def.name}" konnte nicht ausgeführt werden: ${(e as Error).message}`)
  }
})

// /swarm <task> — parallel agents in isolated git worktrees, one branch each.
builtins.set('swarm', async ({ args, emit, runSwarmFromChat }) => {
  const task = args.trim()
  if (!task) {
    emitInfo(
      emit,
      '🐝 **Schwarm-Modus** — `/swarm <Aufgabe>` zerlegt die Aufgabe in unabhängige Teilaufgaben und bearbeitet sie PARALLEL, jede in einem isolierten git-Worktree als eigener Branch (kein Kollidieren). Danach kannst du die Branches prüfen/mergen.\n\nBeispiel: `/swarm migriere alle Module von moment.js auf date-fns`. Braucht ein git-Repository.'
    )
    return
  }
  if (!runSwarmFromChat) {
    emitInfo(emit, 'Schwarm-Modus steht in diesem Kontext nicht zur Verfügung.')
    return
  }
  try {
    emitInfo(emit, await runSwarmFromChat(task))
  } catch (e) {
    emitInfo(emit, `🐝 Schwarm-Fehler: ${(e as Error).message}`)
  }
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
