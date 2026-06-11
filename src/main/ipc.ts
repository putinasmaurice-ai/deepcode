import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { existsSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import {
  AgentEvent,
  AppSettings,
  AutomationDef,
  ChatMessage,
  McpServerDef,
  MemoryEntry,
  Session
} from '@shared/types'
import {
  loadSettings,
  saveSettings,
  listSessions,
  getSession,
  saveSession,
  deleteSession
} from './store'
import { AgentEngine } from './agent/engine'
import { loadSkills } from './systems/skills'
import { loadCommands, expandCommand } from './systems/commands'
import { loadSubagents } from './systems/subagents'
import { loadHooks } from './systems/hooks'
import { pluginSkills, pluginCommands, pluginSubagents, pluginHooks, loadPlugins, togglePlugin } from './systems/plugins'
import { loadMemory, saveMemory, deleteMemory } from './systems/memory'
import { mcpManager } from './systems/mcp'
import { PATHS } from './paths'
import { buildAttachmentContext, listProjectFiles } from './attachments'
import { rewindLastTurn } from './checkpoints'
import type { ApprovalPolicy } from './agent/engine'
import { loadProjects, getProject, upsertProject, deleteProject as removeProject } from './projects'
import { computeUsageSummary, usageSummaryText } from './usage'
import { exportSessionMarkdown } from './export'
import { ProjectDef } from '@shared/types'
import {
  loadAutomations,
  upsertAutomation,
  deleteAutomation,
  AutomationScheduler
} from './systems/automations'

// Initialized in registerIpc() (after app 'ready', so safeStorage is available).
let settings: AppSettings
let engine: AgentEngine

export function getEngine(): AgentEngine {
  return engine
}

function emitter(win: BrowserWindow): (e: AgentEvent) => void {
  return (e) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.agentEvent, e)
  }
}

export function registerIpc(win: BrowserWindow): void {
  settings = loadSettings()
  engine = new AgentEngine(settings)
  const emit = emitter(win)

  // ---- settings ----
  ipcMain.handle(IPC.getSettings, () => settings)
  ipcMain.handle(IPC.saveSettings, (_e, next: AppSettings) => {
    settings = next
    saveSettings(next)
    engine.updateSettings(next)
    return settings
  })

  // ---- sessions ----
  ipcMain.handle(IPC.listSessions, () => listSessions())
  ipcMain.handle(IPC.getSession, (_e, id: string) => getSession(id))
  ipcMain.handle(IPC.createSession, (_e, cwd?: string, projectId?: string) => {
    const project = projectId ? getProject(projectId) : null
    const session: Session = {
      id: randomUUID(),
      title: 'New session',
      cwd: validDir(cwd) || validDir(project?.cwd) || validDir(settings.defaultCwd) || homedir(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      model: settings.provider.model,
      projectId: project?.id
    }
    saveSession(session)
    return session
  })

  // ---- projects ----
  ipcMain.handle(IPC.listProjects, () => loadProjects())
  ipcMain.handle(IPC.saveProject, (_e, p: ProjectDef) => {
    if (!p.id) p.id = randomUUID()
    if (!p.createdAt) p.createdAt = Date.now()
    return upsertProject(p)
  })
  ipcMain.handle(IPC.deleteProject, (_e, id: string) => removeProject(id))

  // ---- usage / export ----
  ipcMain.handle(IPC.usageSummary, () => computeUsageSummary())
  ipcMain.handle(IPC.exportSession, (_e, id: string) => {
    const s = getSession(id)
    if (!s) throw new Error('Session not found')
    return exportSessionMarkdown(s)
  })
  ipcMain.handle(IPC.changeCwd, (_e, id: string, cwd: string) => {
    const s = getSession(id)
    if (!s) throw new Error('Session not found')
    const dir = validDir(cwd)
    if (!dir) throw new Error('Not a valid directory: ' + cwd)
    s.cwd = dir
    saveSession(s)
    return s
  })
  ipcMain.handle(IPC.updateSessionModel, (_e, id: string, model: string) => {
    const s = getSession(id)
    if (s) {
      s.model = model
      saveSession(s)
    }
    return true
  })
  ipcMain.handle(IPC.deleteSession, (_e, id: string) => {
    deleteSession(id)
    return true
  })
  ipcMain.handle(IPC.renameSession, (_e, id: string, title: string) => {
    const s = getSession(id)
    if (s) {
      s.title = title
      saveSession(s)
    }
    return true
  })

  // ---- agent turn ----
  ipcMain.handle(
    IPC.sendMessage,
    async (_e, sessionId: string, rawText: string, attachments?: string[], mode?: ApprovalPolicy) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')

    let text = rawText
    if (rawText.trim().startsWith('/')) {
      const trimmed = rawText.trim()
      const cmd = trimmed.slice(1).split(/\s+/)[0]
      const args = trimmed.slice(1 + cmd.length).trim()

      // Built-in commands handled here (no model turn needed for most).
      if (cmd === 'help') {
        emitHelp(emit, session.cwd)
        emit({ type: 'turn_done', sessionId: session.id })
        return true
      }
      if (cmd === 'goal') {
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
        emit({ type: 'turn_done', sessionId: session.id })
        return true
      }
      if (cmd === 'cost') {
        emitInfo(emit, usageSummaryText())
        emit({ type: 'turn_done', sessionId: session.id })
        return true
      }
      if (cmd === 'model') {
        if (args) {
          session.model = args
          saveSession(session)
          emitInfo(emit, `Modell für diese Session: **${args}**`)
        } else {
          emitInfo(
            emit,
            `Aktuelles Modell: **${session.model || settings.provider.model}**\nVerfügbar: \`${settings.provider.model}\`, \`${settings.provider.reasonerModel}\`\nWechseln mit \`/model <id>\``
          )
        }
        emit({ type: 'turn_done', sessionId: session.id })
        return true
      }
      if (cmd === 'compact') {
        const updated = await engine.compactSession(session, emit)
        emit({ type: 'session', session: updated })
        emit({ type: 'turn_done', sessionId: session.id })
        return true
      }
      if (cmd === 'rewind') {
        const restored = rewindLastTurn(session.id)
        emitInfo(
          emit,
          restored.length
            ? `⏪ **Rewind:** ${restored.length} Datei(en) auf den Stand vor der letzten Änderungsrunde zurückgesetzt:\n${restored.map((p) => `- \`${p}\``).join('\n')}\n\n_Nochmal /rewind setzt die Runde davor zurück._`
            : 'Keine Checkpoints vorhanden — es wurde in dieser Session noch nichts geändert.'
        )
        emit({ type: 'turn_done', sessionId: session.id })
        return true
      }
      if (cmd === 'init') {
        text =
          'Analyze this project: explore the directory structure, identify the tech stack, ' +
          'entry points, key modules, build/test commands and conventions. Then write a concise ' +
          'DEEPCODE.md at the project root documenting all of that so future sessions have context. ' +
          (args ? `Extra guidance: ${args}` : '')
      } else {
        const expanded = expandCommand(cmd, args, session.cwd)
        if (expanded) text = expanded
      }
    }

    // Prepend attached files/folders (cheap: files inlined up to a cap, folders as a tree).
    if (attachments && attachments.length) {
      const ctx = buildAttachmentContext(attachments, session.cwd)
      if (ctx) text = `${ctx}\n\n${text}`
    }

    if (session.title === 'New session') {
      session.title = rawText.replace(/\s+/g, ' ').slice(0, 50) || 'New session'
      saveSession(session)
    }

    await engine.runTurn(session, text, emit, mode)
    return true
    }
  )
  // Re-run from a user message: truncate history at that point and run again
  // (optionally with edited text). Powers "Regenerate".
  ipcMain.handle(
    IPC.resendMessage,
    async (_e, sessionId: string, messageId: string, newText?: string, mode?: ApprovalPolicy) => {
      const session = getSession(sessionId)
      if (!session) throw new Error('Session not found')
      const idx = session.messages.findIndex((m) => m.id === messageId && m.role === 'user')
      if (idx < 0) throw new Error('User message not found')
      const original = session.messages[idx].content
      session.messages = session.messages.slice(0, idx)
      saveSession(session)
      emit({ type: 'session', session })
      await engine.runTurn(session, newText ?? original, emit, mode)
      return true
    }
  )
  ipcMain.handle(IPC.listFiles, (_e, cwd: string) => listProjectFiles(cwd))
  ipcMain.handle(IPC.compactSession, async (_e, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    const updated = await engine.compactSession(session, emit)
    emit({ type: 'turn_done', sessionId: session.id })
    return updated
  })
  ipcMain.handle(IPC.cancelTurn, (_e, sessionId: string) => {
    engine.cancel(sessionId)
    return true
  })
  ipcMain.handle(IPC.approveTool, (_e, callId: string, approved: boolean) => {
    engine.approve(callId, approved)
    return true
  })

  // ---- feature systems (read-only listings) ----
  ipcMain.handle(IPC.listSkills, (_e, cwd?: string) => [...loadSkills(cwd), ...pluginSkills()])
  ipcMain.handle(IPC.listCommands, (_e, cwd?: string) => [...loadCommands(cwd), ...pluginCommands()])
  ipcMain.handle(IPC.listSubagents, (_e, cwd?: string) => [...loadSubagents(cwd), ...pluginSubagents()])
  ipcMain.handle(IPC.listHooks, (_e, cwd?: string) => [...loadHooks(cwd), ...pluginHooks()])

  // ---- memory ----
  ipcMain.handle(IPC.listMemory, () => loadMemory())
  ipcMain.handle(IPC.saveMemory, (_e, entry: Omit<MemoryEntry, 'path'>) => saveMemory(entry))
  ipcMain.handle(IPC.deleteMemory, (_e, name: string) => {
    deleteMemory(name)
    return true
  })

  // ---- mcp ----
  ipcMain.handle(IPC.listMcp, () => mcpManager.listStatus())
  ipcMain.handle(IPC.saveMcp, (_e, defs: McpServerDef[]) => {
    mcpManager.saveConfig(defs)
    return mcpManager.listStatus()
  })
  ipcMain.handle(IPC.connectMcp, async (_e, name: string) => {
    try {
      return await mcpManager.connect(name)
    } catch (err) {
      return { name, transport: 'stdio', enabled: true, status: 'error', error: (err as Error).message }
    }
  })
  ipcMain.handle(IPC.disconnectMcp, async (_e, name: string) => {
    await mcpManager.disconnect(name)
    return true
  })

  // ---- plugins ----
  ipcMain.handle(IPC.listPlugins, () => loadPlugins())
  ipcMain.handle(IPC.togglePlugin, (_e, name: string, enabled: boolean) => {
    togglePlugin(name, enabled)
    return loadPlugins()
  })

  // ---- automations ----
  ipcMain.handle(IPC.listAutomations, () => loadAutomations())
  ipcMain.handle(IPC.saveAutomation, (_e, a: AutomationDef) => upsertAutomation(a))
  ipcMain.handle(IPC.deleteAutomation, (_e, id: string) => deleteAutomation(id))
  ipcMain.handle(IPC.runAutomation, async (_e, id: string) => {
    const a = loadAutomations().find((x) => x.id === id)
    if (a) await runAutomationNow(a, emit)
    return true
  })

  // ---- misc ----
  ipcMain.handle(IPC.pickDirectory, async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle(IPC.pickFiles, async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle(IPC.openConfigDir, () => {
    shell.openPath(PATHS.root)
    return true
  })
  ipcMain.handle(IPC.getCwdInfo, (_e, cwd: string) => {
    const exists = existsSync(cwd) && statSync(cwd).isDirectory()
    let gitBranch: string | null = null
    try {
      const head = join(cwd, '.git', 'HEAD')
      if (existsSync(head)) {
        const txt = readFileSync(head, 'utf8').trim()
        gitBranch = txt.startsWith('ref:') ? txt.split('/').pop() || null : txt.slice(0, 8)
      }
    } catch {
      /* not a repo */
    }
    return { cwd, exists, gitBranch }
  })

  // ---- automation scheduler ----
  const scheduler = new AutomationScheduler((a) => runAutomationNow(a, emit))
  scheduler.start()
}

async function runAutomationNow(a: AutomationDef, emit: (e: AgentEvent) => void): Promise<void> {
  const session: Session = {
    id: randomUUID(),
    title: `[auto] ${a.name}`,
    cwd: validDir(a.cwd) || validDir(settings.defaultCwd) || homedir(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    model: settings.provider.model
  }
  saveSession(session)
  emit({ type: 'status', message: `Automation "${a.name}" running...` })
  // 'safe' = only auto-approved reads run unattended; 'full' = writes + shell too.
  const policy = a.autonomy === 'full' ? 'full' : 'safe'
  await engine.runTurn(session, a.prompt, emit, policy)
}

function validDir(p?: string): string | null {
  if (!p) return null
  try {
    return existsSync(p) && statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

// Push a synthetic assistant message (for built-in commands, no API call).
function emitInfo(emit: (e: AgentEvent) => void, content: string): void {
  const id = randomUUID()
  const message: ChatMessage = { id, role: 'assistant', content: '', createdAt: Date.now() }
  emit({ type: 'message_start', message })
  emit({ type: 'content_delta', messageId: id, delta: content })
  emit({ type: 'message_done', message: { ...message, content } })
}

// Render the /help output as a synthetic assistant message.
function emitHelp(emit: (e: AgentEvent) => void, cwd: string): void {
  const cmds = [...loadCommands(cwd), ...pluginCommands()]
  const skills = [...loadSkills(cwd), ...pluginSkills()]
  const agents = [...loadSubagents(cwd), ...pluginSubagents()]
  const lines: string[] = []
  lines.push('## DeepCode — Hilfe\n')
  lines.push('**Was ich kann:** Codebasen verstehen, Dateien lesen/erstellen/ändern, Terminal-Befehle ausführen, Bugs fixen, Features projektweit implementieren, Tests ausführen, Refactorings planen.\n')
  lines.push('**Built-in Tools:** read_file, write_file, edit_file, apply_patch, list_dir, glob, grep, run_command, task (Subagents), use_skill + alle MCP-Connector-Tools.\n')
  lines.push('**Built-in Befehle:**')
  lines.push('- `/help` — diese Übersicht')
  lines.push('- `/init` — Projekt analysieren und DEEPCODE.md schreiben')
  lines.push('- `/goal [Ziel|clear]` — dauerhaftes Ziel setzen/anzeigen/löschen')
  lines.push('- `/cost` — Kostenübersicht (pro Chat / Projekt / gesamt)')
  lines.push('- `/model [id]` — Modell dieser Session anzeigen/wechseln')
  lines.push('- `/compact` — ältere Nachrichten zusammenfassen (Kontext sparen)')
  lines.push('- `/rewind` — Datei-Änderungen der letzten Runde rückgängig machen')
  if (cmds.length) {
    lines.push('\n**Eigene Befehle:**')
    for (const c of cmds) lines.push(`- \`/${c.name}\` — ${c.description}`)
  }
  if (skills.length) lines.push(`\n**Skills (${skills.length}):** ` + skills.slice(0, 30).map((s) => s.name).join(', ') + (skills.length > 30 ? ', …' : ''))
  if (agents.length) lines.push('\n**Subagents:** ' + agents.map((a) => a.name).join(', '))
  lines.push('\nAlles verwaltbar über die Sidebar (Projekte, Skills, Commands, Subagents, MCP, Hooks, Memory, Automations, Plugins, Kosten).')
  emitInfo(emit, lines.join('\n'))
}

// connect enabled MCP servers in the background after startup
export function bootstrapMcp(): void {
  mcpManager.connectAllEnabled().catch((e) => console.error('MCP bootstrap error:', e))
}
