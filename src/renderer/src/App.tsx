import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  AppSettings,
  ChatMessage,
  Session,
  ToolResult
} from '../../shared/types'
import { Composer } from './components/Composer'
import { MessageView } from './components/MessageView'
import {
  SettingsPanel,
  SkillsPanel,
  CommandsPanel,
  SubagentsPanel,
  HooksPanel,
  MemoryPanel,
  McpPanel,
  PluginsPanel,
  AutomationsPanel
} from './components/Panels'

const api = window.deepcode

export type View =
  | 'chat'
  | 'settings'
  | 'skills'
  | 'commands'
  | 'subagents'
  | 'hooks'
  | 'memory'
  | 'mcp'
  | 'plugins'
  | 'automations'

export interface ToolState {
  result?: ToolResult
  pending?: boolean
  args?: string
  name?: string
}

const NAV: { view: View; icon: string; label: string }[] = [
  { view: 'chat', icon: '💬', label: 'Chat' },
  { view: 'skills', icon: '📘', label: 'Skills' },
  { view: 'commands', icon: '/', label: 'Slash Commands' },
  { view: 'subagents', icon: '🤖', label: 'Subagents' },
  { view: 'mcp', icon: '🔌', label: 'MCP / Connectors' },
  { view: 'hooks', icon: '🪝', label: 'Hooks' },
  { view: 'memory', icon: '🧠', label: 'Memory' },
  { view: 'automations', icon: '⏰', label: 'Automations' },
  { view: 'plugins', icon: '🧩', label: 'Plugins' },
  { view: 'settings', icon: '⚙️', label: 'Settings' }
]

export function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [toolState, setToolState] = useState<Record<string, ToolState>>({})
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('chat')
  const [sessionUsage, setSessionUsage] = useState<{ tokens: number; cost: number }>({
    tokens: 0,
    cost: 0
  })
  const chatRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  // ---- bootstrap ----
  useEffect(() => {
    ;(async () => {
      const s = await api.getSettings()
      setSettings(s)
      const list = await api.listSessions()
      setSessions(list)
      if (list.length) await openSession(list[0].id)
      else await newSession(s)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- agent event stream ----
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => handleEvent(e))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleEvent = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case 'message_start':
        setMessages((m) => [...m, e.message])
        break
      case 'content_delta':
        setMessages((m) =>
          m.map((x) => (x.id === e.messageId ? { ...x, content: x.content + e.delta } : x))
        )
        scrollDown()
        break
      case 'reasoning_delta':
        setMessages((m) =>
          m.map((x) =>
            x.id === e.messageId ? { ...x, reasoning: (x.reasoning ?? '') + e.delta } : x
          )
        )
        scrollDown()
        break
      case 'message_done':
        setMessages((m) => m.map((x) => (x.id === e.message.id ? e.message : x)))
        scrollDown()
        break
      case 'tool_pending':
        setToolState((t) => ({
          ...t,
          [e.callId]: { ...t[e.callId], pending: true, name: e.name, args: e.args }
        }))
        scrollDown()
        break
      case 'tool_result':
        setToolState((t) => ({
          ...t,
          [e.callId]: { ...t[e.callId], pending: false, result: e.result, name: e.name }
        }))
        scrollDown()
        break
      case 'usage':
        setSessionUsage((u) => ({
          tokens: u.tokens + e.usage.totalTokens,
          cost: u.cost + e.usage.cost
        }))
        break
      case 'status':
        setStatus(e.message)
        break
      case 'error':
        setError(e.message)
        break
      case 'turn_done':
        setBusy(false)
        setStatus('')
        refreshSessions()
        break
    }
  }, [])

  // Only autoscroll when the user is already near the bottom, so we don't yank
  // the view while they're reading earlier output.
  const scrollDown = (): void => {
    if (!nearBottomRef.current) return
    requestAnimationFrame(() => {
      const el = chatRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  function onChatScroll(): void {
    const el = chatRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  async function refreshSessions(): Promise<void> {
    setSessions(await api.listSessions())
  }

  function deriveToolState(msgs: ChatMessage[]): Record<string, ToolState> {
    const ts: Record<string, ToolState> = {}
    for (const m of msgs) {
      if (m.role === 'tool' && m.toolCallId) {
        ts[m.toolCallId] = {
          result: { ok: !m.error, content: m.content, meta: m.meta },
          name: m.toolName,
          pending: false
        }
      }
    }
    return ts
  }

  function computeUsage(msgs: ChatMessage[]): { tokens: number; cost: number } {
    let tokens = 0
    let cost = 0
    for (const m of msgs) {
      if (m.usage) {
        tokens += m.usage.totalTokens
        cost += m.usage.cost
      }
    }
    return { tokens, cost }
  }

  async function openSession(id: string): Promise<void> {
    const s = (await api.getSession(id)) as Session | null
    if (!s) return
    setSession(s)
    setMessages(s.messages.filter((m) => m.role !== 'tool'))
    setToolState(deriveToolState(s.messages))
    setSessionUsage(computeUsage(s.messages))
    setView('chat')
    setError('')
    nearBottomRef.current = true
    scrollDown()
  }

  async function newSession(s?: AppSettings | null): Promise<void> {
    const cwd = (s ?? settings)?.defaultCwd
    const created = await api.createSession(cwd || undefined)
    setSessions((list) => [created, ...list])
    setSession(created)
    setMessages([])
    setToolState({})
    setSessionUsage({ tokens: 0, cost: 0 })
    setView('chat')
    setError('')
  }

  async function changeModel(model: string): Promise<void> {
    if (!session) return
    await api.updateSessionModel(session.id, model)
    setSession({ ...session, model })
    setSessions((list) => list.map((x) => (x.id === session.id ? { ...x, model } : x)))
  }

  async function compact(): Promise<void> {
    if (!session || busy) return
    setBusy(true)
    try {
      const updated = (await api.compactSession(session.id)) as Session
      if (updated) {
        setMessages(updated.messages.filter((m) => m.role !== 'tool'))
        setToolState(deriveToolState(updated.messages))
      }
    } finally {
      setBusy(false)
    }
  }

  async function send(text: string): Promise<void> {
    if (!session || busy) return
    setError('')
    const userMsg: ChatMessage = {
      id: 'local-' + Date.now(),
      role: 'user',
      content: text,
      createdAt: Date.now()
    }
    setMessages((m) => [...m, userMsg])
    setBusy(true)
    scrollDown()
    try {
      await api.sendMessage(session.id, text)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const approve = useCallback((callId: string, approved: boolean): void => {
    api.approveTool(callId, approved)
    setToolState((t) => ({ ...t, [callId]: { ...t[callId], pending: false } }))
  }, [])

  function stop(): void {
    if (session) api.cancelTurn(session.id)
    setBusy(false)
  }

  async function pickCwd(): Promise<void> {
    if (!session) return
    const dir = await api.pickDirectory()
    if (!dir) return
    // Change the current session's working directory in place (keeps the chat).
    try {
      const updated = (await api.changeCwd(session.id, dir)) as Session
      setSession(updated)
      setSessions((list) => list.map((x) => (x.id === updated.id ? { ...x, cwd: dir } : x)))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const apiKeyMissing = settings && !settings.provider.apiKey

  const transcript = useMemo(() => messages.filter((m) => !m.hidden), [messages])

  if (!settings) return <div className="spinner" />


  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          DeepCode <small>· DeepSeek</small>
        </div>
        <div className="nav">
          {NAV.map((n) => (
            <button
              key={n.view}
              className={view === n.view ? 'active' : ''}
              onClick={() => setView(n.view)}
            >
              <span className="ic">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </div>
        <div className="nav-sep" />
        <div className="nav">
          <button onClick={() => newSession()}>
            <span className="ic">＋</span> New session
          </button>
        </div>
        <div className="sessions">
          <h4>Sessions</h4>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={'session-item' + (session?.id === s.id ? ' active' : '')}
              onClick={() => openSession(s.id)}
              title={s.cwd}
            >
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.title || 'Untitled'}
                </div>
                <div className="session-meta">
                  {basename(s.cwd)} · {relTime(s.updatedAt)}
                </div>
              </div>
              <span
                className="x"
                onClick={async (ev) => {
                  ev.stopPropagation()
                  await api.deleteSession(s.id)
                  const list = await api.listSessions()
                  setSessions(list)
                  if (session?.id === s.id) {
                    if (list.length) openSession(list[0].id)
                    else newSession()
                  }
                }}
              >
                ✕
              </span>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          {view === 'chat' && session && (
            <>
              <div className="cwd" onClick={pickCwd} title="Click to change the working directory">
                📁 {session.cwd}
              </div>
              <div className="spacer" />
              {sessionUsage.tokens > 0 && (
                <span className="pill" title="Tokens / estimated cost this session">
                  {sessionUsage.tokens.toLocaleString()} tok
                  {sessionUsage.cost > 0 ? ` · $${sessionUsage.cost.toFixed(4)}` : ''}
                </span>
              )}
              <button
                className="btn ghost sm"
                onClick={compact}
                disabled={busy}
                title="Summarize older turns to free up context"
              >
                Compact
              </button>
              <select
                className="model-select"
                value={session.model || settings.provider.model}
                onChange={(e) => changeModel(e.target.value)}
                title="Model for this session"
              >
                {Array.from(
                  new Set([
                    settings.provider.model,
                    settings.provider.reasonerModel,
                    session.model || settings.provider.model
                  ])
                ).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </>
          )}
          {view !== 'chat' && (
            <>
              <strong style={{ fontSize: 14 }}>{NAV.find((n) => n.view === view)?.label}</strong>
              <div className="spacer" />
              <button className="btn ghost sm" onClick={() => api.openConfigDir()}>
                Open config folder
              </button>
            </>
          )}
        </div>

        {view === 'chat' ? (
          <>
            <div className="chat" ref={chatRef} onScroll={onChatScroll}>
              <div className="chat-inner">
                {apiKeyMissing && (
                  <div className="banner">
                    No DeepSeek API key set. Open <b>Settings</b> to add your key and model.
                  </div>
                )}
                {error && <div className="banner">{error}</div>}
                {transcript.length === 0 && (
                  <Welcome onPick={(t) => send(t)} />
                )}
                {transcript.map((m) => (
                  <MessageView
                    key={m.id}
                    message={m}
                    toolState={toolState}
                    onApprove={approve}
                  />
                ))}
                {busy && status && <div className="msg"><div className="role">working</div><div style={{ color: 'var(--text-faint)', fontSize: 13 }}>{status}</div></div>}
              </div>
            </div>
            <Composer busy={busy} onSend={send} onStop={stop} cwd={session?.cwd} />
          </>
        ) : (
          <Panel view={view} settings={settings} onSettings={setSettings} cwd={session?.cwd} />
        )}
      </main>
    </div>
  )
}

function basename(p: string): string {
  if (!p) return '~'
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function Welcome({ onPick }: { onPick: (t: string) => void }): JSX.Element {
  const examples = [
    'Erkläre mir die Struktur dieses Projekts und die wichtigsten Dateien.',
    'Finde und behebe Bugs in dieser Codebasis. Führe danach die Tests aus.',
    'Implementiere ein neues Feature: …',
    'Plane ein Refactoring des Moduls … und setze es um.'
  ]
  return (
    <div className="welcome">
      <h2>DeepCode</h2>
      <p>Dein agentischer Coding-Assistent — powered by DeepSeek.</p>
      <div className="examples">
        {examples.map((e) => (
          <div className="ex" key={e} onClick={() => onPick(e)}>
            {e}
          </div>
        ))}
      </div>
    </div>
  )
}

function Panel({
  view,
  settings,
  onSettings,
  cwd
}: {
  view: View
  settings: AppSettings
  onSettings: (s: AppSettings) => void
  cwd?: string
}): JSX.Element {
  switch (view) {
    case 'settings':
      return <SettingsPanel settings={settings} onSettings={onSettings} />
    case 'skills':
      return <SkillsPanel cwd={cwd} />
    case 'commands':
      return <CommandsPanel cwd={cwd} />
    case 'subagents':
      return <SubagentsPanel cwd={cwd} />
    case 'hooks':
      return <HooksPanel cwd={cwd} />
    case 'memory':
      return <MemoryPanel />
    case 'mcp':
      return <McpPanel />
    case 'plugins':
      return <PluginsPanel />
    case 'automations':
      return <AutomationsPanel cwd={cwd} />
    default:
      return <div className="panel" />
  }
}
