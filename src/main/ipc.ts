import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { existsSync, statSync } from 'fs'
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
  ipcMain.handle(IPC.createSession, (_e, cwd?: string) => {
    const session: Session = {
      id: randomUUID(),
      title: 'New session',
      cwd: validDir(cwd) || validDir(settings.defaultCwd) || homedir(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      model: settings.provider.model
    }
    saveSession(session)
    return session
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
  ipcMain.handle(IPC.sendMessage, async (_e, sessionId: string, rawText: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')

    let text = rawText
    if (rawText.trim().startsWith('/')) {
      const trimmed = rawText.trim()
      const cmd = trimmed.slice(1).split(/\s+/)[0]
      const args = trimmed.slice(1 + cmd.length).trim()

      // Built-in commands handled here (no model turn needed for /help).
      if (cmd === 'help') {
        emitHelp(emit, session.cwd)
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

    if (session.title === 'New session') {
      session.title = rawText.replace(/\s+/g, ' ').slice(0, 50) || 'New session'
      saveSession(session)
    }

    await engine.runTurn(session, text, emit)
    return true
  })
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
  ipcMain.handle(IPC.openConfigDir, () => {
    shell.openPath(PATHS.root)
    return true
  })
  ipcMain.handle(IPC.getCwdInfo, (_e, cwd: string) => {
    const exists = existsSync(cwd) && statSync(cwd).isDirectory()
    return { cwd, exists }
  })

  // ---- automation scheduler ----
  const scheduler = new AutomationScheduler((a) => runAutomationNow(a, emit))
  scheduler.start()
}

async function runAutomationNow(a: AutomationDef, emit: (e: AgentEvent) => void): Promise<void> {
  const session: Session = {
    id: randomUUID(),
    title: `[auto] ${a.name}`,
    cwd: validDir(a.cwd) || settings.defaultCwd || homedir(),
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

// Render the /help output as a synthetic assistant message.
function emitHelp(emit: (e: AgentEvent) => void, cwd: string): void {
  const cmds = [...loadCommands(cwd), ...pluginCommands()]
  const skills = [...loadSkills(cwd), ...pluginSkills()]
  const agents = [...loadSubagents(cwd), ...pluginSubagents()]
  const lines: string[] = []
  lines.push('## DeepCode — quick help\n')
  lines.push('**What I can do:** understand codebases, read/create/edit files, run shell commands, fix bugs, implement features across a project, run tests, and plan refactors.\n')
  lines.push('**Built-in tools:** read_file, write_file, edit_file, apply_patch, list_dir, glob, grep, run_command, task (subagents), use_skill, plus any MCP connector tools.\n')
  lines.push('**Slash commands:**')
  lines.push('- `/help` — this message')
  lines.push('- `/init` — analyze the project and write DEEPCODE.md')
  for (const c of cmds) lines.push(`- \`/${c.name}\` — ${c.description}`)
  if (skills.length) {
    lines.push('\n**Skills:** ' + skills.map((s) => s.name).join(', '))
  }
  if (agents.length) {
    lines.push('\n**Subagents:** ' + agents.map((a) => a.name).join(', '))
  }
  lines.push('\nManage everything in the left sidebar (Skills, Commands, Subagents, MCP, Hooks, Memory, Automations, Plugins).')

  const id = randomUUID()
  const message: ChatMessage = { id, role: 'assistant', content: '', createdAt: Date.now() }
  emit({ type: 'message_start', message })
  const full = lines.join('\n')
  emit({ type: 'content_delta', messageId: id, delta: full })
  emit({ type: 'message_done', message: { ...message, content: full } })
}

// connect enabled MCP servers in the background after startup
export function bootstrapMcp(): void {
  mcpManager.connectAllEnabled().catch((e) => console.error('MCP bootstrap error:', e))
}
