import type {
  AgentEvent,
  AppSettings,
  AutomationDef,
  HookDef,
  McpServerDef,
  MemoryEntry,
  Mission,
  MissionTask,
  NightShiftState,
  PluginDef,
  ProjectDef,
  ProjectHealth,
  Session,
  SkillDef,
  SlashCommandDef,
  SubagentDef,
  UsageSummary,
  WorkflowDef,
  WorkflowRun,
  Trace,
  SwarmBranch
} from './types'

// Approval mode the renderer can request for a turn (mirrors the engine's ApprovalPolicy).
export type ApprovalMode = 'interactive' | 'plan' | 'full' | 'safe'

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

export interface FindResult {
  matches: number
  activeMatchOrdinal: number
}

export interface ApprovedCommand {
  command: string
  cwd: string
}

export interface TurnForecast {
  contextTokens: number // current context size that will be sent
  estInputCost: number // estimated input cost of that context (USD; 0 for local)
  isLocal: boolean
  // rolling average of the user's own recent turns (0/empty until enough history)
  avgCost: number
  avgTokens: number
  avgDurationMs: number
  sampleCount: number
}

export interface PreviewInfo {
  // best-guess URL to load (file:// for static html, http://localhost for dev servers)
  url: string | null
  kind: 'static' | 'dev' | 'none'
  // a dev script exists in package.json (so the user can start it)
  devScript: string | null
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
  sendMessage(
    sessionId: string,
    text: string,
    attachments?: string[],
    mode?: ApprovalMode,
    // restrict the turn to a tool allowlist (the workflow chat dock passes a safe set so its
    // 'full' mode can't reach write_file/run_command/web_request/git/MCP). Omit = full toolset.
    toolAllow?: string[]
  ): Promise<boolean>
  resendMessage(
    sessionId: string,
    messageId: string,
    newText?: string,
    mode?: ApprovalMode,
    attachments?: string[]
  ): Promise<boolean>
  cancelTurn(sessionId: string): Promise<boolean>
  approveTool(callId: string, approved: boolean, remember?: boolean): Promise<boolean>
  // securely submit a value the agent requested via a secret_request event. The value goes
  // renderer→main→setSecret only — it is never re-emitted to the renderer/LLM. Resolves with the
  // store OUTCOME ({ set, error? }) so the UI can warn on a rejected value (error is a static
  // constraint message — min length / no OS encryption — never the value itself).
  submitSecret(callId: string, value: string | null): Promise<{ set: boolean; error?: string }>
  compactSession(sessionId: string): Promise<Session>
  forecastTurn(sessionId: string): Promise<TurnForecast>
  secondOpinion(sessionId: string): Promise<boolean>
  arena(sessionId: string, modelB?: string): Promise<boolean>
  arenaVote(winner: string, loser: string): Promise<boolean>
  listLocalModels(): Promise<string[]>
  listFiles(cwd: string): Promise<string[]>
  readFileHead(path: string, maxChars?: number): Promise<string>
  imageDataUri(path: string): Promise<string | null>
  previewDiff(name: string, argsJson: string, cwd: string): Promise<string>
  installFromGit(url: string): Promise<{ ok: boolean; message: string }>
  getAppInfo(): Promise<{ version: string; electron: string }>
  checkUpdates(): Promise<{ status: string; version?: string; message?: string }>
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

  // visual workflows
  listWorkflows(): Promise<WorkflowDef[]>
  getWorkflow(id: string): Promise<WorkflowDef | null>
  saveWorkflow(def: WorkflowDef): Promise<WorkflowDef>
  generateWorkflow(description: string): Promise<WorkflowDef>
  deleteWorkflow(id: string): Promise<boolean>
  runWorkflow(id: string, runId: string, vars?: Record<string, string>, fromNodeId?: string): Promise<string>
  cancelWorkflow(runId: string): Promise<boolean>
  healWorkflow(id: string, runId?: string): Promise<string>
  listWorkflowRuns(workflowId?: string): Promise<WorkflowRun[]>
  getWorkflowRun(runId: string): Promise<WorkflowRun | null>
  listTraces(sessionId?: string): Promise<Trace[]>
  getTrace(id: string): Promise<Trace | null>
  swarmBranches(): Promise<SwarmBranch[]>
  swarmDiff(branch: string): Promise<string>
  swarmMerge(branch: string): Promise<{ ok: boolean; output: string }>
  swarmDeleteBranch(branch: string): Promise<{ ok: boolean; output: string }>
  exportWorkflow(id: string): Promise<boolean>
  importWorkflow(): Promise<WorkflowDef | null>
  secretsList(): Promise<string[]>
  secretSet(name: string, value: string): Promise<boolean>
  secretDelete(name: string): Promise<boolean>

  // backup / restore
  exportBackup(): Promise<{ ok: boolean; path?: string }>
  importBackup(): Promise<{ ok: boolean; restored?: string[]; message?: string }>

  // automations
  listAutomations(): Promise<AutomationDef[]>
  saveAutomation(a: AutomationDef): Promise<AutomationDef[]>
  deleteAutomation(id: string): Promise<AutomationDef[]>
  runAutomation(id: string): Promise<boolean>

  // mission control
  listMissions(): Promise<Mission[]>
  getMission(id: string): Promise<Mission | null>
  saveMission(m: Mission): Promise<Mission>
  deleteMission(id: string): Promise<boolean>
  // decompose a high-level goal into 3-8 linear tasks (LLM); returns the task list to fill a draft
  generatePlan(goal: string): Promise<MissionTask[]>
  // start the overseer loop for a saved mission (one mission at a time); progress streams via
  // 'mission' agent events. Returns the mission as it stands at launch.
  startMission(id: string): Promise<Mission>
  stopMission(id: string): Promise<boolean>

  // night shift
  nightGet(): Promise<NightShiftState>
  nightSave(s: NightShiftState): Promise<NightShiftState>
  nightStart(): Promise<NightShiftState>
  nightStop(): Promise<boolean>
  nightOpenReport(path: string): Promise<boolean>

  // watcher
  watchStart(cwd: string): Promise<boolean>
  watchStop(): Promise<boolean>

  // persistent approval allowlist (cwd-scoped)
  listApprovedCommands(): Promise<ApprovedCommand[]>
  removeApprovedCommand(command: string, cwd: string): Promise<ApprovedCommand[]>

  // in-chat find
  findInPage(text: string, forward: boolean, findNext: boolean): Promise<boolean>
  stopFindInPage(): Promise<boolean>
  onFindResult(cb: (r: FindResult) => void): () => void

  // project preview
  detectPreview(cwd: string): Promise<PreviewInfo>
  openExternal(url: string): Promise<boolean>

  // misc
  pickDirectory(): Promise<string | null>
  pickFiles(): Promise<string[]>
  openConfigDir(): Promise<boolean>
  getCwdInfo(cwd: string): Promise<CwdInfo>
}
