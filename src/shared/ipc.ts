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

  // agent turn
  sendMessage: 'agent:send',
  cancelTurn: 'agent:cancel',
  approveTool: 'agent:approveTool',
  agentEvent: 'agent:event', // main -> renderer push channel

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

  // automations
  listAutomations: 'automations:list',
  saveAutomation: 'automations:save',
  deleteAutomation: 'automations:delete',
  runAutomation: 'automations:run',

  // misc
  pickDirectory: 'dialog:pickDirectory',
  openConfigDir: 'shell:openConfigDir',
  getCwdInfo: 'fs:cwdInfo'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
