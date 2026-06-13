import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { AgentEvent } from '@shared/types'
import type { DeepCodeApi } from '@shared/api'

const api: DeepCodeApi = {
  // settings
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (s: unknown) => ipcRenderer.invoke(IPC.saveSettings, s),

  // sessions
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getSession: (id: string) => ipcRenderer.invoke(IPC.getSession, id),
  createSession: (cwd?: string, projectId?: string) =>
    ipcRenderer.invoke(IPC.createSession, cwd, projectId),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.deleteSession, id),
  renameSession: (id: string, title: string) => ipcRenderer.invoke(IPC.renameSession, id, title),
  exportSession: (id: string) => ipcRenderer.invoke(IPC.exportSession, id),

  // projects
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  saveProject: (p: unknown) => ipcRenderer.invoke(IPC.saveProject, p),
  deleteProject: (id: string) => ipcRenderer.invoke(IPC.deleteProject, id),

  // usage
  usageSummary: () => ipcRenderer.invoke(IPC.usageSummary),
  listAudit: () => ipcRenderer.invoke(IPC.listAudit),
  searchSessions: (q: string) => ipcRenderer.invoke(IPC.searchSessions, q),

  // night shift + project health
  nightGet: () => ipcRenderer.invoke(IPC.nightGet),
  nightSave: (s: unknown) => ipcRenderer.invoke(IPC.nightSave, s),
  nightStart: () => ipcRenderer.invoke(IPC.nightStart),
  nightStop: () => ipcRenderer.invoke(IPC.nightStop),
  nightOpenReport: (path: string) => ipcRenderer.invoke(IPC.nightOpenReport, path),
  projectHealth: (cwd: string) => ipcRenderer.invoke(IPC.projectHealth, cwd),
  watchStart: (cwd: string) => ipcRenderer.invoke(IPC.watchStart, cwd),
  watchStop: () => ipcRenderer.invoke(IPC.watchStop),

  // agent
  sendMessage: (sessionId: string, text: string, attachments?: string[], mode?: string) =>
    ipcRenderer.invoke(IPC.sendMessage, sessionId, text, attachments, mode),
  resendMessage: (
    sessionId: string,
    messageId: string,
    newText?: string,
    mode?: string,
    attachments?: string[]
  ) => ipcRenderer.invoke(IPC.resendMessage, sessionId, messageId, newText, mode, attachments),
  listFiles: (cwd: string) => ipcRenderer.invoke(IPC.listFiles, cwd),
  secondOpinion: (sessionId: string) => ipcRenderer.invoke(IPC.secondOpinion, sessionId),
  arena: (sessionId: string, modelB?: string) => ipcRenderer.invoke(IPC.arena, sessionId, modelB),
  arenaVote: (winner: string, loser: string) => ipcRenderer.invoke(IPC.arenaVote, winner, loser),
  listLocalModels: () => ipcRenderer.invoke(IPC.listLocalModels),
  readFileHead: (path: string, maxChars?: number) =>
    ipcRenderer.invoke(IPC.readFileHead, path, maxChars),
  imageDataUri: (path: string) => ipcRenderer.invoke(IPC.imageDataUri, path),
  previewDiff: (name: string, argsJson: string, cwd: string) =>
    ipcRenderer.invoke(IPC.previewDiff, name, argsJson, cwd),
  installFromGit: (url: string) => ipcRenderer.invoke(IPC.installFromGit, url),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  checkUpdates: () => ipcRenderer.invoke(IPC.checkUpdates),
  cancelTurn: (sessionId: string) => ipcRenderer.invoke(IPC.cancelTurn, sessionId),
  approveTool: (callId: string, approved: boolean, remember?: boolean) =>
    ipcRenderer.invoke(IPC.approveTool, callId, approved, remember),
  compactSession: (sessionId: string) => ipcRenderer.invoke(IPC.compactSession, sessionId),
  forecastTurn: (sessionId: string) => ipcRenderer.invoke(IPC.forecastTurn, sessionId),
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

  // visual workflows
  listWorkflows: () => ipcRenderer.invoke(IPC.listWorkflows),
  getWorkflow: (id: string) => ipcRenderer.invoke(IPC.getWorkflow, id),
  saveWorkflow: (def: unknown) => ipcRenderer.invoke(IPC.saveWorkflow, def),
  deleteWorkflow: (id: string) => ipcRenderer.invoke(IPC.deleteWorkflow, id),
  runWorkflow: (id: string, runId: string, vars?: Record<string, string>, fromNodeId?: string) =>
    ipcRenderer.invoke(IPC.runWorkflow, id, runId, vars, fromNodeId),
  cancelWorkflow: (runId: string) => ipcRenderer.invoke(IPC.cancelWorkflow, runId),
  listWorkflowRuns: (workflowId?: string) => ipcRenderer.invoke(IPC.listWorkflowRuns, workflowId),
  getWorkflowRun: (runId: string) => ipcRenderer.invoke(IPC.getWorkflowRun, runId),
  exportWorkflow: (id: string) => ipcRenderer.invoke(IPC.exportWorkflow, id),
  importWorkflow: () => ipcRenderer.invoke(IPC.importWorkflow),

  // automations
  listAutomations: () => ipcRenderer.invoke(IPC.listAutomations),
  saveAutomation: (a: unknown) => ipcRenderer.invoke(IPC.saveAutomation, a),
  deleteAutomation: (id: string) => ipcRenderer.invoke(IPC.deleteAutomation, id),
  runAutomation: (id: string) => ipcRenderer.invoke(IPC.runAutomation, id),

  // persistent approval allowlist
  listApprovedCommands: () => ipcRenderer.invoke(IPC.listApprovedCommands),
  removeApprovedCommand: (command: string, cwd: string) =>
    ipcRenderer.invoke(IPC.removeApprovedCommand, command, cwd),

  // in-chat find
  findInPage: (text: string, forward: boolean, findNext: boolean) =>
    ipcRenderer.invoke(IPC.findInPage, text, forward, findNext),
  stopFindInPage: () => ipcRenderer.invoke(IPC.stopFindInPage),
  onFindResult: (cb: (r: { matches: number; activeMatchOrdinal: number }) => void): (() => void) => {
    const listener = (_e: unknown, r: { matches: number; activeMatchOrdinal: number }): void => cb(r)
    ipcRenderer.on(IPC.findResult, listener)
    return () => {
      ipcRenderer.removeListener(IPC.findResult, listener)
    }
  },

  // project preview
  detectPreview: (cwd: string) => ipcRenderer.invoke(IPC.detectPreview, cwd),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),

  // misc
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles),
  openConfigDir: () => ipcRenderer.invoke(IPC.openConfigDir),
  getCwdInfo: (cwd: string) => ipcRenderer.invoke(IPC.getCwdInfo, cwd)
}

contextBridge.exposeInMainWorld('deepcode', api)

export type { DeepCodeApi } from '@shared/api'
