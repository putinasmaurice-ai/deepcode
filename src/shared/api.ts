import type {
  AgentEvent,
  AppSettings,
  AutomationDef,
  HookDef,
  McpServerDef,
  MemoryEntry,
  NightShiftState,
  PluginDef,
  ProjectDef,
  ProjectHealth,
  Session,
  SkillDef,
  SlashCommandDef,
  SubagentDef,
  UsageSummary
} from './types'

export interface CwdInfo {
  cwd: string
  exists: boolean
  gitBranch: string | null
  gitDirty: number
}

export interface AuditEntry {
  time: string
  kind: string
  detail: string
}

export interface SearchHit {
  sessionId: string
  title: string
  snippet: string
  updatedAt: number
}

// The full typed surface of window.deepcode (implemented in src/preload).
export interface DeepCodeApi {
  // settings
  getSettings(): Promise<AppSettings>
  saveSettings(s: AppSettings): Promise<AppSettings>

  // sessions
  listSessions(): Promise<Session[]>
  getSession(id: string): Promise<Session | null>
  createSession(cwd?: string, projectId?: string): Promise<Session>
  deleteSession(id: string): Promise<boolean>
  renameSession(id: string, title: string): Promise<boolean>
  exportSession(id: string): Promise<string>
  changeCwd(id: string, cwd: string): Promise<Session>
  updateSessionModel(id: string, model: string): Promise<boolean>

  // projects
  listProjects(): Promise<ProjectDef[]>
  saveProject(p: ProjectDef): Promise<ProjectDef[]>
  deleteProject(id: string): Promise<ProjectDef[]>
  projectHealth(cwd: string): Promise<ProjectHealth>

  // usage / history
  usageSummary(): Promise<UsageSummary>
  listAudit(): Promise<AuditEntry[]>
  searchSessions(q: string): Promise<SearchHit[]>

  // agent
  sendMessage(sessionId: string, text: string, attachments?: string[], mode?: string): Promise<boolean>
  resendMessage(
    sessionId: string,
    messageId: string,
    newText?: string,
    mode?: string,
    attachments?: string[]
  ): Promise<boolean>
  cancelTurn(sessionId: string): Promise<boolean>
  approveTool(callId: string, approved: boolean): Promise<boolean>
  compactSession(sessionId: string): Promise<Session>
  secondOpinion(sessionId: string): Promise<boolean>
  arena(sessionId: string, modelB?: string): Promise<boolean>
  arenaVote(winner: string, loser: string): Promise<boolean>
  listLocalModels(): Promise<string[]>
  listFiles(cwd: string): Promise<string[]>
  readFileHead(path: string, maxChars?: number): Promise<string>
  onAgentEvent(cb: (e: AgentEvent) => void): () => void

  // feature systems
  listSkills(cwd?: string): Promise<SkillDef[]>
  listCommands(cwd?: string): Promise<SlashCommandDef[]>
  listSubagents(cwd?: string): Promise<SubagentDef[]>
  listHooks(cwd?: string): Promise<HookDef[]>

  // memory
  listMemory(): Promise<MemoryEntry[]>
  saveMemory(entry: Omit<MemoryEntry, 'path'>): Promise<MemoryEntry>
  deleteMemory(name: string): Promise<boolean>

  // mcp
  listMcp(): Promise<McpServerDef[]>
  saveMcp(defs: McpServerDef[]): Promise<McpServerDef[]>
  connectMcp(name: string): Promise<McpServerDef>
  disconnectMcp(name: string): Promise<boolean>

  // plugins
  listPlugins(): Promise<PluginDef[]>
  togglePlugin(name: string, enabled: boolean): Promise<PluginDef[]>

  // automations
  listAutomations(): Promise<AutomationDef[]>
  saveAutomation(a: AutomationDef): Promise<AutomationDef[]>
  deleteAutomation(id: string): Promise<AutomationDef[]>
  runAutomation(id: string): Promise<boolean>

  // night shift
  nightGet(): Promise<NightShiftState>
  nightSave(s: NightShiftState): Promise<NightShiftState>
  nightStart(): Promise<NightShiftState>
  nightStop(): Promise<boolean>

  // watcher
  watchStart(cwd: string): Promise<boolean>
  watchStop(): Promise<boolean>

  // misc
  pickDirectory(): Promise<string | null>
  pickFiles(): Promise<string[]>
  openConfigDir(): Promise<boolean>
  getCwdInfo(cwd: string): Promise<CwdInfo>
}
