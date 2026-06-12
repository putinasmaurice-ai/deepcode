import { useEffect, useState } from 'react'
import type {
  AppSettings,
  AutomationDef,
  HookDef,
  McpServerDef,
  MemoryEntry,
  PluginDef,
  SkillDef,
  SlashCommandDef,
  SubagentDef
} from '../../../shared/types'

const api = window.deepcode

function Switch({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  return <span className={'switch' + (on ? ' on' : '')} onClick={onClick} />
}

function PanelShell({
  title,
  sub,
  children
}: {
  title: string
  sub: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>{title}</h1>
        <p className="sub">{sub}</p>
        {children}
      </div>
    </div>
  )
}

// ---- Settings ----
export function SettingsPanel({
  settings,
  onSettings
}: {
  settings: AppSettings
  onSettings: (s: AppSettings) => void
}): JSX.Element {
  const [s, setS] = useState<AppSettings>(settings)
  const [saved, setSaved] = useState(false)
  const p = s.provider

  function update(patch: Partial<AppSettings>): void {
    setS((cur) => ({ ...cur, ...patch }))
    setSaved(false)
  }
  function updateProvider(patch: Partial<AppSettings['provider']>): void {
    setS((cur) => ({ ...cur, provider: { ...cur.provider, ...patch } }))
    setSaved(false)
  }

  async function save(): Promise<void> {
    const next = await api.saveSettings(s)
    onSettings(next)
    setSaved(true)
  }

  async function pick(): Promise<void> {
    const dir = await api.pickDirectory()
    if (dir) update({ defaultCwd: dir })
  }

  return (
    <PanelShell title="Settings" sub="DeepSeek provider, permissions, and default behavior.">
      <div className="card">
        <h3>DeepSeek provider</h3>
        <p>Any OpenAI-compatible endpoint works. Set your model id (e.g. deepseek-chat, deepseek-reasoner, or your "v4 PRO" id).</p>
        <div className="field" style={{ marginTop: 14 }}>
          <label>API key</label>
          <input
            type="password"
            value={p.apiKey}
            placeholder="sk-…"
            onChange={(e) => updateProvider({ apiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input value={p.baseUrl} onChange={(e) => updateProvider({ baseUrl: e.target.value })} />
        </div>
        <div className="field">
          <label>Lokale Modelle — Endpoint (Ollama / LM Studio, OpenAI-kompatibel)</label>
          <input
            value={p.localBaseUrl ?? 'http://localhost:11434/v1'}
            onChange={(e) => updateProvider({ localBaseUrl: e.target.value })}
            placeholder="http://localhost:11434/v1"
          />
        </div>
        <div className="field">
          <label>🔓 Uncensored-Modell (für den Topbar-Schalter — lokal, ungefiltert)</label>
          <input
            value={p.uncensoredModel ?? 'local:dolphin3'}
            onChange={(e) => updateProvider({ uncensoredModel: e.target.value })}
            placeholder="local:dolphin3"
          />
        </div>
        <div className="field">
          <label>👁 Vision-Modell (automatisch genutzt, wenn du ein Bild anhängst)</label>
          <input
            value={p.visionModel ?? 'local:qwen2.5vl:7b'}
            onChange={(e) => updateProvider({ visionModel: e.target.value })}
            placeholder="local:qwen2.5vl:7b"
          />
        </div>
        <div className="row">
          <div className="field">
            <label>Model</label>
            <input value={p.model} onChange={(e) => updateProvider({ model: e.target.value })} />
          </div>
          <div className="field">
            <label>Reasoner model (for subagents)</label>
            <input
              value={p.reasonerModel}
              onChange={(e) => updateProvider({ reasonerModel: e.target.value })}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Temperature</label>
            <input
              type="number"
              step="0.1"
              value={p.temperature}
              onChange={(e) => updateProvider({ temperature: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Max tokens</label>
            <input
              type="number"
              value={p.maxTokens}
              onChange={(e) => updateProvider({ maxTokens: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Price / 1M input tokens ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.pricePerMillionInput}
              onChange={(e) => updateProvider({ pricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Price / 1M output tokens ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.pricePerMillionOutput}
              onChange={(e) => updateProvider({ pricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Reasoner-Preis / 1M Input ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.reasonerPricePerMillionInput ?? 0.55}
              onChange={(e) => updateProvider({ reasonerPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Reasoner-Preis / 1M Output ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.reasonerPricePerMillionOutput ?? 2.19}
              onChange={(e) => updateProvider({ reasonerPricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Permissions (auto-approve)</h3>
        <p>When off, DeepCode asks before each action of that type.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <label className="toggle">
            <Switch on={s.autoApprove.read} onClick={() => update({ autoApprove: { ...s.autoApprove, read: !s.autoApprove.read } })} />
            Auto-approve <b>reads</b> (read_file, grep, glob, list_dir)
          </label>
          <label className="toggle">
            <Switch on={s.autoApprove.write} onClick={() => update({ autoApprove: { ...s.autoApprove, write: !s.autoApprove.write } })} />
            Auto-approve <b>file changes</b> (write_file, edit_file)
          </label>
          <label className="toggle">
            <Switch on={s.autoApprove.bash} onClick={() => update({ autoApprove: { ...s.autoApprove, bash: !s.autoApprove.bash } })} />
            Auto-approve <b>shell commands</b> (run_command)
          </label>
        </div>
      </div>

      <div className="card">
        <h3>Safety</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <label className="toggle">
            <Switch on={s.confineToCwd} onClick={() => update({ confineToCwd: !s.confineToCwd })} />
            Confine file tools to the working directory (block <code style={{ fontFamily: 'var(--mono)' }}>../</code> escapes)
          </label>
          <label className="toggle">
            <Switch on={s.watcherEnabled} onClick={() => update({ watcherEnabled: !s.watcherEnabled })} />
            👀 Live-Wächter — melden, wenn Projektdateien extern geändert werden (Editor, Git)
          </label>
          <label className="toggle">
            <Switch on={s.selfReview} onClick={() => update({ selfReview: !s.selfReview })} />
            🔍 Selbst-Review — nach jeder Änderung prüft der Agent seinen eigenen Code (≈ doppelte Tokens, deutlich weniger Bugs)
          </label>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label>Auto-compact threshold (tokens, 0 = off)</label>
          <input
            type="number"
            value={s.compactThreshold}
            onChange={(e) => update({ compactThreshold: Number(e.target.value) })}
            placeholder="e.g. 80000"
          />
        </div>
        <div className="field">
          <label>Monatsbudget in $ (0 = aus) — Warnung im Kosten-Panel bei Überschreitung</label>
          <input
            type="number"
            step="0.5"
            value={s.monthlyBudget ?? 0}
            onChange={(e) => update({ monthlyBudget: Number(e.target.value) })}
            placeholder="z.B. 5"
          />
        </div>
      </div>

      <div className="card">
        <h3>Defaults</h3>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Default working directory</label>
          <div className="row">
            <input value={s.defaultCwd} onChange={(e) => update({ defaultCwd: e.target.value })} />
            <button className="btn ghost" style={{ flex: '0 0 auto' }} onClick={pick}>
              Browse…
            </button>
          </div>
        </div>
        <div className="field">
          <label>Custom instructions (added to every system prompt)</label>
          <textarea
            value={s.customInstructions}
            onChange={(e) => update({ customInstructions: e.target.value })}
            placeholder="e.g. Always use TypeScript. Prefer functional components. Run npm test after changes."
          />
        </div>
      </div>

      <button className="btn" onClick={save}>
        {saved ? 'Saved ✓' : 'Save settings'}
      </button>

      <AboutCard />
    </PanelShell>
  )
}

function AboutCard(): JSX.Element {
  const [info, setInfo] = useState<{ version: string; electron: string } | null>(null)
  const [checkMsg, setCheckMsg] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    api.getAppInfo().then(setInfo)
  }, [])
  async function check(): Promise<void> {
    setChecking(true)
    setCheckMsg(null)
    try {
      const r = await api.checkUpdates()
      setCheckMsg(
        (r.status === 'available' ? '⬇ ' : r.status === 'uptodate' ? '✅ ' : r.status === 'dev' ? 'ℹ ' : '⚠ ') +
          (r.message ?? r.status)
      )
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h3>🐋 Über DeepCode</h3>
      <p className="meta">
        Version {info?.version ?? '…'} · Electron {info?.electron ?? '…'} · DeepSeek-powered
      </p>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn ghost sm" onClick={check} disabled={checking}>
          {checking ? 'Prüfe…' : 'Auf Updates prüfen'}
        </button>
      </div>
      {checkMsg && <p style={{ marginTop: 10 }}>{checkMsg}</p>}
    </div>
  )
}

// ---- generic list panel for file-based systems ----
function FileSystemHint({ dir }: { dir: string }): JSX.Element {
  return (
    <p className="sub" style={{ marginTop: 16 }}>
      Add your own under <code style={{ fontFamily: 'var(--mono)' }}>~/.deepcode/{dir}</code> (global) or{' '}
      <code style={{ fontFamily: 'var(--mono)' }}>&lt;project&gt;/.deepcode/{dir}</code> (per project).
      Use “Open config folder” above.
    </p>
  )
}

export function SkillsPanel({ cwd }: { cwd?: string }): JSX.Element {
  const [items, setItems] = useState<SkillDef[]>([])
  useEffect(() => {
    api.listSkills(cwd).then(setItems)
  }, [cwd])
  return (
    <PanelShell
      title="Skills"
      sub="Step-by-step instructions for specific tasks. DeepCode loads a skill (use_skill) when it matches your request."
    >
      {items.length === 0 && <div className="empty">No skills installed yet.</div>}
      {items.map((sk) => (
        <div className="card" key={sk.path}>
          <div className="flex-between">
            <h3>
              {sk.name}
              <span className={'badge ' + sk.source}>{sk.source}</span>
            </h3>
          </div>
          <p>{sk.description}</p>
        </div>
      ))}
      <FileSystemHint dir="skills" />
    </PanelShell>
  )
}

export function CommandsPanel({ cwd }: { cwd?: string }): JSX.Element {
  const [items, setItems] = useState<SlashCommandDef[]>([])
  useEffect(() => {
    api.listCommands(cwd).then(setItems)
  }, [cwd])
  return (
    <PanelShell title="Slash Commands" sub="Reusable prompt templates triggered by typing /name in the chat.">
      {items.length === 0 && <div className="empty">No custom commands yet. Built-ins: /help, /init.</div>}
      {items.map((c) => (
        <div className="card" key={c.path}>
          <h3>
            /{c.name}
            <span className={'badge ' + c.source}>{c.source}</span>
          </h3>
          <p>{c.description}</p>
        </div>
      ))}
      <FileSystemHint dir="commands" />
    </PanelShell>
  )
}

export function SubagentsPanel({ cwd }: { cwd?: string }): JSX.Element {
  const [items, setItems] = useState<SubagentDef[]>([])
  useEffect(() => {
    api.listSubagents(cwd).then(setItems)
  }, [cwd])
  return (
    <PanelShell
      title="Subagents"
      sub="Specialized assistants DeepCode can delegate to (the task tool). Each has its own prompt and tool set."
    >
      {items.length === 0 && <div className="empty">No subagents defined yet.</div>}
      {items.map((a) => (
        <div className="card" key={a.name + a.source}>
          <h3>
            {a.name}
            <span className={'badge ' + a.source}>{a.source}</span>
          </h3>
          <p>{a.description}</p>
          <div className="meta" style={{ marginTop: 6 }}>
            tools: {a.tools.join(', ')}
            {a.model ? ` · model: ${a.model}` : ''}
          </div>
        </div>
      ))}
      <FileSystemHint dir="agents" />
    </PanelShell>
  )
}

export function HooksPanel({ cwd }: { cwd?: string }): JSX.Element {
  const [items, setItems] = useState<HookDef[]>([])
  useEffect(() => {
    api.listHooks(cwd).then(setItems)
  }, [cwd])
  return (
    <PanelShell
      title="Hooks"
      sub="Shell commands that run automatically on events: UserPromptSubmit, PreToolUse, PostToolUse, Stop."
    >
      {items.length === 0 && <div className="empty">No hooks configured.</div>}
      {items.map((h, i) => (
        <div className="card" key={i}>
          <h3>
            {h.event}
            {h.matcher ? <span className="badge">{h.matcher}</span> : null}
            <span className={'badge ' + h.source}>{h.source}</span>
          </h3>
          <p className="meta">{h.command}</p>
        </div>
      ))}
      <p className="sub" style={{ marginTop: 16 }}>
        Configure in <code style={{ fontFamily: 'var(--mono)' }}>~/.deepcode/hooks.json</code>.
      </p>
    </PanelShell>
  )
}

// ---- Memory ----
export function MemoryPanel(): JSX.Element {
  const [items, setItems] = useState<MemoryEntry[]>([])
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [body, setBody] = useState('')
  const [type, setType] = useState<MemoryEntry['type']>('project')

  async function load(): Promise<void> {
    setItems(await api.listMemory())
  }
  useEffect(() => {
    load()
  }, [])

  async function add(): Promise<void> {
    if (!name.trim() || !body.trim()) return
    await api.saveMemory({ name, description: desc, body, type })
    setName('')
    setDesc('')
    setBody('')
    load()
  }

  return (
    <PanelShell title="Memory" sub="Durable knowledge, rules and preferences kept across sessions and injected into context.">
      <div className="card">
        <h3>Add a memory</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. test-command" />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as MemoryEntry['type'])}>
              <option value="project">project</option>
              <option value="user">user</option>
              <option value="feedback">feedback</option>
              <option value="reference">reference</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Description</label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="one-line summary" />
        </div>
        <div className="field">
          <label>Content</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="The fact to remember…" />
        </div>
        <button className="btn" onClick={add}>
          Save memory
        </button>
      </div>

      {items.length === 0 && <div className="empty">No memories yet.</div>}
      {items.map((m) => (
        <div className="card" key={m.path}>
          <div className="flex-between">
            <h3>
              {m.name}
              <span className="badge">{m.type}</span>
            </h3>
            <button
              className="btn danger sm"
              onClick={async () => {
                await api.deleteMemory(m.name)
                load()
              }}
            >
              Delete
            </button>
          </div>
          <p>{m.description}</p>
          <p className="meta" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{m.body}</p>
        </div>
      ))}
    </PanelShell>
  )
}

// ---- MCP ----
export function McpPanel(): JSX.Element {
  const [items, setItems] = useState<McpServerDef[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsStr, setArgsStr] = useState('')

  async function load(): Promise<void> {
    setItems(await api.listMcp())
  }
  useEffect(() => {
    load()
  }, [])

  async function add(): Promise<void> {
    if (!name.trim() || !command.trim()) return
    const next: McpServerDef[] = [
      ...items.map((i) => ({ ...i })),
      {
        name,
        transport: 'stdio',
        command,
        args: argsStr.trim() ? argsStr.trim().split(/\s+/) : [],
        enabled: true
      }
    ]
    setItems(await api.saveMcp(next))
    setName('')
    setCommand('')
    setArgsStr('')
  }

  return (
    <PanelShell
      title="MCP / Connectors"
      sub="Connect external tools and data via the Model Context Protocol. Their tools become available to the agent."
    >
      <div className="card">
        <h3>Add a connector (stdio)</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" />
          </div>
          <div className="field">
            <label>Command</label>
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </div>
        </div>
        <div className="field">
          <label>Arguments (space-separated)</label>
          <input value={argsStr} onChange={(e) => setArgsStr(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ." />
        </div>
        <button className="btn" onClick={add}>
          Add connector
        </button>
      </div>

      {items.length === 0 && <div className="empty">No connectors configured.</div>}
      {items.map((m) => (
        <div className="card" key={m.name}>
          <div className="flex-between">
            <h3>
              {m.name}
              <span className="badge">{m.transport}</span>
              <span className="badge" style={{ color: m.status === 'connected' ? 'var(--green)' : m.status === 'error' ? 'var(--red)' : undefined }}>
                {m.status ?? 'disconnected'}
              </span>
            </h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {m.status === 'connected' ? (
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    await api.disconnectMcp(m.name)
                    load()
                  }}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api.connectMcp(m.name)
                    load()
                  }}
                >
                  Connect
                </button>
              )}
            </div>
          </div>
          <p className="meta">
            {m.command} {(m.args ?? []).join(' ')} {m.url ?? ''}
          </p>
          {m.tools?.length ? <p>tools: {m.tools.join(', ')}</p> : null}
          {m.error ? <p style={{ color: 'var(--red)' }}>{m.error}</p> : null}
        </div>
      ))}
    </PanelShell>
  )
}

// ---- Plugins ----
export function PluginsPanel(): JSX.Element {
  const [items, setItems] = useState<PluginDef[]>([])
  async function load(): Promise<void> {
    setItems(await api.listPlugins())
  }
  useEffect(() => {
    load()
  }, [])
  return (
    <PanelShell title="Plugins" sub="Installable bundles that package skills, commands, subagents, hooks and connectors.">
      {items.length === 0 && <div className="empty">No plugins installed.</div>}
      {items.map((p) => (
        <div className="card" key={p.name}>
          <div className="flex-between">
            <h3>
              {p.name} <span className="badge">v{p.version}</span>
            </h3>
            <Switch
              on={p.enabled}
              onClick={async () => {
                await api.togglePlugin(p.name, !p.enabled)
                load()
              }}
            />
          </div>
          <p>{p.description}</p>
          <p className="meta">
            {p.provides.skills} skills · {p.provides.commands} commands · {p.provides.agents} agents ·{' '}
            {p.provides.hooks} hooks · {p.provides.mcp} connectors
          </p>
        </div>
      ))}
      <p className="sub" style={{ marginTop: 16 }}>
        Drop plugin folders into <code style={{ fontFamily: 'var(--mono)' }}>~/.deepcode/plugins/</code>.
      </p>
    </PanelShell>
  )
}

// ---- Automations ----
export function AutomationsPanel({
  cwd,
  initialPrompt,
  onPrefillUsed
}: {
  cwd?: string
  initialPrompt?: string
  onPrefillUsed?: () => void
}): JSX.Element {
  const [items, setItems] = useState<AutomationDef[]>([])
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [autonomy, setAutonomy] = useState<'safe' | 'full'>('safe')

  // "Als Automation speichern" from a chat message pre-fills the form
  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt)
      setName(initialPrompt.replace(/\s+/g, ' ').slice(0, 40))
      onPrefillUsed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt])

  async function load(): Promise<void> {
    setItems(await api.listAutomations())
  }
  useEffect(() => {
    load()
  }, [])

  async function add(): Promise<void> {
    if (!name.trim() || !prompt.trim()) return
    const a: AutomationDef = {
      id: 'auto-' + Date.now(),
      name,
      schedule,
      prompt,
      cwd: cwd || '',
      enabled: true,
      autonomy
    }
    await api.saveAutomation(a)
    setName('')
    setPrompt('')
    load()
  }

  return (
    <PanelShell
      title="Automations"
      sub="Routines that run a prompt on a cron schedule (minute hour day month weekday)."
    >
      <div className="card">
        <h3>New automation</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily test run" />
          </div>
          <div className="field">
            <label>Schedule (cron)</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 9 * * *" />
          </div>
        </div>
        <div className="field">
          <label>Prompt</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Run the test suite and summarize failures." />
        </div>
        <div className="field">
          <label>Autonomy (unattended runs)</label>
          <select value={autonomy} onChange={(e) => setAutonomy(e.target.value as 'safe' | 'full')}>
            <option value="safe">Safe — only read-only tools run unattended</option>
            <option value="full">Full — allow file changes and shell commands</option>
          </select>
        </div>
        <button className="btn" onClick={add}>
          Create automation
        </button>
      </div>

      {items.length === 0 && <div className="empty">No automations yet.</div>}
      {items.map((a) => (
        <div className="card" key={a.id}>
          <div className="flex-between">
            <h3>
              {a.name} <span className="badge">{a.schedule}</span>
              <span className="badge" style={{ color: a.autonomy === 'full' ? 'var(--yellow)' : undefined }}>
                {a.autonomy === 'full' ? 'full access' : 'safe'}
              </span>
            </h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Switch
                on={a.enabled}
                onClick={async () => {
                  await api.saveAutomation({ ...a, enabled: !a.enabled })
                  load()
                }}
              />
              <button className="btn ghost sm" onClick={() => api.runAutomation(a.id)}>
                Run now
              </button>
              <button
                className="btn danger sm"
                onClick={async () => {
                  await api.deleteAutomation(a.id)
                  load()
                }}
              >
                Delete
              </button>
            </div>
          </div>
          <p>{a.prompt}</p>
          <p className="meta">{a.cwd || '(no working dir)'}</p>
        </div>
      ))}
    </PanelShell>
  )
}
