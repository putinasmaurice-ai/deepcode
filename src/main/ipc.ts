import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { previewToolDiff } from './preview-diff'
import { checkForUpdates } from './updater'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { existsSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
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
import { loadMemory, saveMemory, deleteMemory, recordArenaVote } from './systems/memory'
import { mcpManager } from './systems/mcp'
import { PATHS } from './paths'
import { buildAttachmentContext, listProjectFiles } from './attachments'
import { runBuiltin } from './builtins'
import { execFile } from 'child_process'
import type { ApprovalPolicy } from './agent/engine'
import { loadProjects, getProject, upsertProject, deleteProject as removeProject } from './projects'
import { computeUsageSummary } from './usage'
import { listAudit, searchSessions } from './history'
import { getNightShift, saveNightShift, runNightShift, requestStop } from './nightshift'
import { startWatch, stopWatch, beginAgentOp, endAgentOp } from './watcher'
import { computeProjectHealth } from './health'
import { NightShiftState } from '@shared/types'
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
  ipcMain.handle(IPC.listAudit, () => listAudit())
  ipcMain.handle(IPC.searchSessions, (_e, q: string) => searchSessions(q))

  // ---- night shift + project health ----
  ipcMain.handle(IPC.nightGet, () => getNightShift())
  ipcMain.handle(IPC.nightSave, (_e, state: NightShiftState) => saveNightShift(state))
  ipcMain.handle(IPC.nightStart, () => {
    // fire and forget — progress arrives via agent events; renderer polls state
    runNightShift(engine, emit).catch((err) =>
      emit({ type: 'error', message: `Nachtschicht: ${(err as Error).message}` })
    )
    return getNightShift()
  })
  ipcMain.handle(IPC.nightStop, () => {
    requestStop()
    return true
  })
  ipcMain.handle(IPC.nightOpenReport, (_e, path: string) => {
    shell.openPath(path)
    return true
  })
  ipcMain.handle(IPC.projectHealth, (_e, cwd: string) => computeProjectHealth(cwd))
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

      const builtin = await runBuiltin(cmd, { session, args, emit, engine, settings })
      if (builtin === 'handled') {
        emit({ type: 'turn_done', sessionId: session.id })
        return true
      }
      if (typeof builtin === 'string') {
        text = builtin // builtin expanded into a normal agent prompt (/init)
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

    beginAgentOp()
    try {
      await engine.runTurn(session, text, emit, mode)
    } finally {
      endAgentOp()
    }
    return true
    }
  )
  // Re-run from a user message: truncate history at that point and run again
  // (optionally with edited text). Powers "Regenerate".
  ipcMain.handle(
    IPC.resendMessage,
    async (
      _e,
      sessionId: string,
      messageId: string,
      newText?: string,
      mode?: ApprovalPolicy,
      attachments?: string[]
    ) => {
      const session = getSession(sessionId)
      if (!session) throw new Error('Session not found')
      const idx = session.messages.findIndex((m) => m.id === messageId && m.role === 'user')
      if (idx < 0) throw new Error('User message not found')
      const original = session.messages[idx].content
      session.messages = session.messages.slice(0, idx)
      saveSession(session)
      let text = newText ?? original
      if (attachments?.length) {
        const ctx = buildAttachmentContext(attachments, session.cwd)
        if (ctx) text = `${ctx}\n\n${text}`
      }
      // No 'session' event here: the renderer truncates its transcript locally,
      // keeping its optimistic user message visible during the rerun.
      beginAgentOp()
      try {
        await engine.runTurn(session, text, emit, mode)
      } finally {
        endAgentOp()
      }
      return true
    }
  )
  ipcMain.handle(IPC.watchStart, (_e, cwd: string) => {
    startWatch(cwd, (files) => emit({ type: 'fs_change', files }))
    return true
  })
  ipcMain.handle(IPC.watchStop, () => {
    stopWatch()
    return true
  })
  ipcMain.handle(IPC.listFiles, (_e, cwd: string) => listProjectFiles(cwd))
  ipcMain.handle(IPC.secondOpinion, async (_e, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    await engine.secondOpinion(session, emit)
    return true
  })
  ipcMain.handle(IPC.arena, async (_e, sessionId: string, modelB?: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    await engine.arena(session, emit, modelB)
    return true
  })
  ipcMain.handle(IPC.arenaVote, (_e, winner: string, loser: string) => {
    recordArenaVote(winner, loser)
    return true
  })
  // local models from the OpenAI-compatible endpoint (Ollama / LM Studio)
  ipcMain.handle(IPC.listLocalModels, async () => {
    try {
      const base = (settings.provider.localBaseUrl || 'http://localhost:11434/v1').replace(/\/$/, '')
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      const res = await fetch(`${base}/models`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!res.ok) return []
      const json = (await res.json()) as { data?: { id: string }[] }
      return (json.data ?? [])
        .map((m) => m.id)
        .filter((id) => !/embed|minilm/i.test(id)) // hide embedding models
    } catch {
      return [] // endpoint not running — that's fine
    }
  })
  ipcMain.handle(IPC.previewDiff, (_e, name: string, argsJson: string, cwd: string) =>
    previewToolDiff(name, argsJson, cwd)
  )
  ipcMain.handle(IPC.getAppInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron
  }))
  ipcMain.handle(IPC.checkUpdates, () => checkForUpdates())
  // Marketplace: install a plugin/skill bundle by cloning a git repo into
  // ~/.deepcode/plugins/<repo>. Shallow clone, 60s cap.
  ipcMain.handle(IPC.installFromGit, async (_e, url: string) => {
    const m = url.trim().match(/^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/([\w.-]+?)(\.git)?\/?$/)
    if (!m) return { ok: false, message: 'Bitte eine https-Repo-URL angeben (GitHub/GitLab/Codeberg).' }
    const name = m[2]
    const dest = join(PATHS.plugins, name)
    if (existsSync(dest)) return { ok: false, message: `"${name}" ist bereits installiert.` }
    return new Promise((resolvePromise) => {
      execFile(
        'git',
        ['clone', '--depth', '1', url.trim(), dest],
        { timeout: 60_000 },
        (err) => {
          if (err) {
            resolvePromise({ ok: false, message: `Clone fehlgeschlagen: ${err.message.slice(0, 200)}` })
            return
          }
          const hasPlugin = existsSync(join(dest, 'plugin.json'))
          const hasSkills = existsSync(join(dest, 'skills')) || existsSync(join(dest, 'SKILL.md'))
          resolvePromise({
            ok: true,
            message: `"${name}" installiert${hasPlugin ? ' (Plugin)' : hasSkills ? ' (Skills)' : ''} — im Plugins-Panel aktivierbar.`
          })
        }
      )
    })
  })
  ipcMain.handle(IPC.readFileHead, (_e, path: string, maxChars?: number) => {
    try {
      if (!existsSync(path)) return '(Datei nicht gefunden)'
      const st = statSync(path)
      if (st.isDirectory()) return '(Ordner)'
      if (st.size > 2_000_000) return `(zu groß: ${Math.round(st.size / 1024)} KB)`
      return readFileSync(path, 'utf8').slice(0, Math.min(maxChars ?? 1500, 8000))
    } catch (e) {
      return `(Fehler: ${(e as Error).message})`
    }
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
  ipcMain.handle(IPC.getCwdInfo, async (_e, cwd: string) => {
    const exists = existsSync(cwd) && statSync(cwd).isDirectory()
    let gitBranch: string | null = null
    let gitDirty = 0
    try {
      const head = join(cwd, '.git', 'HEAD')
      if (existsSync(head)) {
        const txt = readFileSync(head, 'utf8').trim()
        gitBranch = txt.startsWith('ref:') ? txt.split('/').pop() || null : txt.slice(0, 8)
        gitDirty = await new Promise<number>((resolve) => {
          let settled = false
          const finish = (n: number): void => {
            if (settled) return
            settled = true
            clearTimeout(t)
            resolve(n)
          }
          const t = setTimeout(() => finish(0), 2500)
          execFile('git', ['status', '--porcelain'], { cwd, timeout: 2000 }, (err, stdout) => {
            finish(err ? 0 : stdout.split('\n').filter(Boolean).length)
          })
        })
      }
    } catch {
      /* not a repo */
    }
    return { cwd, exists, gitBranch, gitDirty }
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

// connect enabled MCP servers in the background after startup
export function bootstrapMcp(): void {
  mcpManager.connectAllEnabled().catch((e) => console.error('MCP bootstrap error:', e))
}
