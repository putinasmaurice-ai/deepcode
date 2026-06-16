// Canonical list of IPC channel names shared by main + preload + renderer.

export const IPC = {
  // settings
  getSettings: 'settings:get',
  saveSettings: 'settings:save',

  // sessions
  listSessions: 'sessions:list',
  getSession: 'sessions:get',
  createSession: 'sessions:create',
  deleteSession: 'sessions:delete',
  renameSession: 'sessions:rename',
  exportSession: 'sessions:export',

  // projects
  listProjects: 'projects:list',
  saveProject: 'projects:save',
  deleteProject: 'projects:delete',

  // usage / costs
  usageSummary: 'usage:summary',

  // audit + history search
  listAudit: 'audit:list',
  searchSessions: 'sessions:search',

  // night shift + project health
  nightGet: 'night:get',
  nightSave: 'night:save',
  nightStart: 'night:start',
  nightStop: 'night:stop',
  nightOpenReport: 'night:openReport',
  projectHealth: 'projects:health',
  watchStart: 'watch:start',
  watchStop: 'watch:stop',

  // agent turn
  sendMessage: 'agent:send',
  cancelTurn: 'agent:cancel',
  approveTool: 'agent:approveTool',
  submitSecret: 'agent:submitSecret',
  agentEvent: 'agent:event', // main -> renderer push channel
  compactSession: 'agent:compact',
  forecastTurn: 'agent:forecast',
  resendMessage: 'agent:resend',
  secondOpinion: 'agent:secondOpinion',
  arena: 'agent:arena',
  arenaVote: 'memory:arenaVote',
  listLocalModels: 'provider:localModels',
  readFileHead: 'fs:readHead',
  imageDataUri: 'fs:imageDataUri',
  previewDiff: 'fs:previewDiff',
  installFromGit: 'market:installGit',
  getAppInfo: 'app:info',
  checkUpdates: 'app:checkUpdates',
  updateSessionModel: 'sessions:setModel',
  changeCwd: 'sessions:setCwd',
  listFiles: 'fs:listFiles',

  // feature systems
  listSkills: 'skills:list',
  listCommands: 'commands:list',
  listSubagents: 'subagents:list',
  listHooks: 'hooks:list',
  listMemory: 'memory:list',
  saveMemory: 'memory:save',
  deleteMemory: 'memory:delete',

  // mcp
  listMcp: 'mcp:list',
  saveMcp: 'mcp:save',
  connectMcp: 'mcp:connect',
  disconnectMcp: 'mcp:disconnect',

  // plugins
  listPlugins: 'plugins:list',
  togglePlugin: 'plugins:toggle',

  // visual workflows
  listWorkflows: 'workflows:list',
  getWorkflow: 'workflows:get',
  saveWorkflow: 'workflows:save',
  generateWorkflow: 'workflows:generate',
  deleteWorkflow: 'workflows:delete',
  runWorkflow: 'workflows:run',
  cancelWorkflow: 'workflows:cancel',
  healWorkflow: 'workflows:heal',
  listWorkflowRuns: 'workflows:runs',
  getWorkflowRun: 'workflows:getRun',
  listTraces: 'traces:list',
  getTrace: 'traces:get',
  swarmBranches: 'swarm:branches',
  swarmDiff: 'swarm:diff',
  swarmMerge: 'swarm:merge',
  swarmDeleteBranch: 'swarm:deleteBranch',
  exportWorkflow: 'workflows:export',
  importWorkflow: 'workflows:import',
  secretsList: 'workflows:secretsList',
  secretSet: 'workflows:secretSet',
  secretDelete: 'workflows:secretDelete',

  // backup / restore (portable JSON export of the user's config)
  exportBackup: 'backup:export',
  importBackup: 'backup:import',

  // automations
  listAutomations: 'automations:list',
  saveAutomation: 'automations:save',
  deleteAutomation: 'automations:delete',
  runAutomation: 'automations:run',

  // mission control (autonomous multi-task missions, machine-verified + auto-committed)
  missionsList: 'missions:list',
  missionGet: 'missions:get',
  missionSave: 'missions:save',
  missionDelete: 'missions:delete',
  missionGeneratePlan: 'missions:generatePlan',
  missionStart: 'missions:start',
  missionStop: 'missions:stop',
  missionSchedule: 'missions:schedule',
  missionReport: 'missions:report',

  // time machine (causal replay + branch-from-here) — read-only timeline + a local fork branch
  tmTimeline: 'timemachine:timeline',
  tmTick: 'timemachine:tick',
  tmFork: 'timemachine:fork',
  tmForks: 'timemachine:forks',
  tmForkDiff: 'timemachine:forkDiff',
  tmDeleteFork: 'timemachine:deleteFork',

  // persistent approval allowlist
  listApprovedCommands: 'approvals:list',
  removeApprovedCommand: 'approvals:remove',

  // in-chat find (Electron findInPage)
  findInPage: 'find:inPage',
  stopFindInPage: 'find:stop',
  findResult: 'find:result', // main -> renderer push channel

  // project preview pane
  detectPreview: 'preview:detect',
  openExternal: 'shell:openExternal',

  // misc
  pickDirectory: 'dialog:pickDirectory',
  createDirectory: 'dialog:createDirectory',
  pickFiles: 'dialog:pickFiles',
  openConfigDir: 'shell:openConfigDir',
  getCwdInfo: 'fs:cwdInfo'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
