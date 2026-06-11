import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { AgentEvent } from '@shared/types'

const api = {
  // settings
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (s: unknown) => ipcRenderer.invoke(IPC.saveSettings, s),

  // sessions
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getSession: (id: string) => ipcRenderer.invoke(IPC.getSession, id),
  createSession: (cwd?: string) => ipcRenderer.invoke(IPC.createSession, cwd),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.deleteSession, id),
  renameSession: (id: string, title: string) => ipcRenderer.invoke(IPC.renameSession, id, title),

  // agent
  sendMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke(IPC.sendMessage, sessionId, text),
  cancelTurn: (sessionId: string) => ipcRenderer.invoke(IPC.cancelTurn, sessionId),
  approveTool: (callId: string, approved: boolean) =>
    ipcRenderer.invoke(IPC.approveTool, callId, approved),
  compactSession: (sessionId: string) => ipcRenderer.invoke(IPC.compactSession, sessionId),
  updateSessionModel: (id: string, model: string) =>
    ipcRenderer.invoke(IPC.updateSessionModel, id, model),
  changeCwd: (id: string, cwd: string) => ipcRenderer.invoke(IPC.changeCwd, id, cwd),
  onAgentEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const listener = (_e: unknown, ev: AgentEvent): void => cb(ev)
    ipcRenderer.on(IPC.agentEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.agentEvent, listener)
    }
  },

  // feature systems
  listSkills: (cwd?: string) => ipcRenderer.invoke(IPC.listSkills, cwd),
  listCommands: (cwd?: string) => ipcRenderer.invoke(IPC.listCommands, cwd),
  listSubagents: (cwd?: string) => ipcRenderer.invoke(IPC.listSubagents, cwd),
  listHooks: (cwd?: string) => ipcRenderer.invoke(IPC.listHooks, cwd),

  // memory
  listMemory: () => ipcRenderer.invoke(IPC.listMemory),
  saveMemory: (entry: unknown) => ipcRenderer.invoke(IPC.saveMemory, entry),
  deleteMemory: (name: string) => ipcRenderer.invoke(IPC.deleteMemory, name),

  // mcp
  listMcp: () => ipcRenderer.invoke(IPC.listMcp),
  saveMcp: (defs: unknown) => ipcRenderer.invoke(IPC.saveMcp, defs),
  connectMcp: (name: string) => ipcRenderer.invoke(IPC.connectMcp, name),
  disconnectMcp: (name: string) => ipcRenderer.invoke(IPC.disconnectMcp, name),

  // plugins
  listPlugins: () => ipcRenderer.invoke(IPC.listPlugins),
  togglePlugin: (name: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.togglePlugin, name, enabled),

  // automations
  listAutomations: () => ipcRenderer.invoke(IPC.listAutomations),
  saveAutomation: (a: unknown) => ipcRenderer.invoke(IPC.saveAutomation, a),
  deleteAutomation: (id: string) => ipcRenderer.invoke(IPC.deleteAutomation, id),
  runAutomation: (id: string) => ipcRenderer.invoke(IPC.runAutomation, id),

  // misc
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  openConfigDir: () => ipcRenderer.invoke(IPC.openConfigDir),
  getCwdInfo: (cwd: string) => ipcRenderer.invoke(IPC.getCwdInfo, cwd)
}

contextBridge.exposeInMainWorld('deepcode', api)

export type DeepCodeApi = typeof api
