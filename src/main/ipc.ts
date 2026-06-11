import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { existsSync, statSync } from 'fs'
import { IPC } from '@shared/ipc'
import {
  AgentEvent,
  AppSettings,
  AutomationDef,
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

let settings: AppSettings = loadSettings()
const engine = new AgentEngine(settings)

export function getEngine(): AgentEngine {
  return engine
}

function emitter(win: BrowserWindow): (e: AgentEvent) => void {
  return (e) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.agentEvent, e)
  }
}

export function registerIpc(win: BrowserWindow): void {
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
    const dir = cwd || settings.defaultCwd || homedir()
    const session: Session = {
      id: randomUUID(),
      title: 'New session',
      cwd: dir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      model: settings.provider.model
    }
    saveSession(session)
    return session
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
    // slash command expansion (file-based commands)
    if (rawText.trim().startsWith('/')) {
      const [cmd, ...rest] = rawText.trim().slice(1).split(/\s+/)
      const args = rawText.trim().slice(1 + cmd.length).trim()
      const expanded = expandCommand(cmd, args, session.cwd)
      if (expanded) text = expanded
    }

    // auto-title from first user message
    if (session.title === 'New session') {
      session.title = rawText.replace(/\s+/g, ' ').slice(0, 50) || 'New session'
      saveSession(session)
    }

    await engine.runTurn(session, text, emit)
    return true
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
    cwd: a.cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  }
  saveSession(session)
  emit({ type: 'status', message: `Automation "${a.name}" running...` })
  await engine.runTurn(session, a.prompt, emit)
}

// connect enabled MCP servers in the background after startup
export function bootstrapMcp(): void {
  mcpManager.connectAllEnabled().catch((e) => console.error('MCP bootstrap error:', e))
}
