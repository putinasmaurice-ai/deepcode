import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  AppSettings,
  ChatMessage,
  ProjectDef,
  Session,
  TodoItem,
  ToolResult
} from '../../shared/types'

export type AgentMode = 'interactive' | 'plan' | 'full'
import { Composer } from './components/Composer'
import { MessageView } from './components/MessageView'
import { ProjectsPanel } from './components/ProjectsPanel'
import { UsagePanel } from './components/UsagePanel'
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
  | 'projects'
  | 'usage'
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
  { view: 'projects', icon: '📂', label: 'Projekte' },
  { view: 'usage', icon: '💰', label: 'Kosten' },
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
  const [projects, setProjects] = useState<ProjectDef[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [mode, setMode] = useState<AgentMode>('interactive')
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [sessionFilter, setSessionFilter] = useState('')
  const [showJump, setShowJump] = useState(false)
  const [gitDirty, setGitDirty] = useState(0)
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  const editTargetRef = useRef<string | null>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  const activeProject = projects.find((p) => p.id === (session?.projectId ?? activeProjectId)) ?? null

  async function refreshProjects(): Promise<void> {
    setProjects(await api.listProjects())
  }

  // git branch + dirty count for the current working dir (refreshed after each turn)
  const refreshGit = useCallback((): void => {
    if (!session?.cwd) return
    api.getCwdInfo(session.cwd).then((info: { gitBranch?: string | null; gitDirty?: number }) => {
      setGitBranch(info?.gitBranch ?? null)
      setGitDirty(info?.gitDirty ?? 0)
    })
  }, [session?.cwd])
  useEffect(() => {
    refreshGit()
  }, [refreshGit])
  // refresh git state after each finished turn (the agent may have changed files)
  useEffect(() => {
    if (!busy) refreshGit()
  }, [busy, refreshGit])

  // global shortcuts: Ctrl+N new chat, Ctrl+K focus composer, Esc cancel turn
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newSession()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setView('chat')
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50)
      } else if (e.key === 'Escape' && busy && session) {
        api.cancelTurn(session.id)
        setBusy(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, settings, busy, session])

  // ---- bootstrap ----
  useEffect(() => {
    ;(async () => {
      const s = await api.getSettings()
      setSettings(s)
      setProjects(await api.listProjects())
      const list = await api.listSessions()
      setSessions(list)
      if (list.length) await openSession(list[0].id)
      else await newSession(s)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // refresh projects when returning to chat (panel edits may have changed them)
  useEffect(() => {
    if (view === 'chat') refreshProjects()
  }, [view])

  // ---- agent event stream ----
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => handleEvent(e))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleEvent = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case 'session':
        // pushed after /compact: replace the transcript with the updated session
        setMessages(e.session.messages.filter((m) => m.role !== 'tool'))
        setToolState(deriveToolState(e.session.messages))
        break
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
      case 'todos':
        setTodos(e.todos)
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
        // notify when the user is in another window/app
        if (document.hidden) {
          try {
            new Notification('DeepCode 🐋', { body: 'Aufgabe abgeschlossen.' })
          } catch {
            /* notifications unavailable */
          }
        }
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
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    nearBottomRef.current = near
    setShowJump(!near)
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
    setTodos(s.todos ?? [])
    setView('chat')
    setError('')
    nearBottomRef.current = true
    scrollDown()
  }

  async function newSession(s?: AppSettings | null, projectId?: string | null): Promise<void> {
    const pid = projectId !== undefined ? projectId : activeProjectId
    const cwd = pid ? undefined : (s ?? settings)?.defaultCwd
    const created = await api.createSession(cwd || undefined, pid || undefined)
    setSessions((list) => [created, ...list])
    setSession(created)
    setMessages([])
    setToolState({})
    setSessionUsage({ tokens: 0, cost: 0 })
    setView('chat')
    setError('')
  }

  async function exportChat(): Promise<void> {
    if (!session) return
    try {
      const path = (await api.exportSession(session.id)) as string
      setStatus(`Exportiert: ${path}`)
      setTimeout(() => setStatus(''), 5000)
    } catch (err) {
      setError((err as Error).message)
    }
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

  async function send(text: string, attachments?: string[]): Promise<void> {
    if (!session || busy) return
    setError('')
    // edit-and-resend: drop the edited message and everything after it locally
    // (the main process truncates its copy too)
    if (editTargetRef.current) {
      const editId = editTargetRef.current
      setMessages((m) => {
        const i = m.findIndex((x) => x.id === editId)
        return i >= 0 ? m.slice(0, i) : m
      })
    }
    const note =
      attachments && attachments.length
        ? `\n\n📎 ${attachments.length} ${attachments.length === 1 ? 'Anhang' : 'Anhänge'}: ${attachments
            .map((p) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop())
            .join(', ')}`
        : ''
    const userMsg: ChatMessage = {
      id: 'local-' + Date.now(),
      role: 'user',
      content: text + note,
      createdAt: Date.now()
    }
    setMessages((m) => [...m, userMsg])
    setBusy(true)
    nearBottomRef.current = true
    scrollDown()
    try {
      // edit-and-resend: replace history from the edited message onward
      const editId = editTargetRef.current
      editTargetRef.current = null
      if (editId) {
        await api.resendMessage(session.id, editId, text, mode, attachments)
      } else {
        await api.sendMessage(session.id, text, attachments, mode)
      }
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const startEdit = useCallback((messageId: string, content: string): void => {
    editTargetRef.current = messageId
    setComposerPrefill(content)
  }, [])

  async function regenerate(): Promise<void> {
    if (!session || busy) return
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !m.id.startsWith('local-'))
    if (!lastUser) return
    // drop the old answer locally; keep the user message visible
    setMessages((m) => {
      const i = m.findIndex((x) => x.id === lastUser.id)
      return i >= 0 ? m.slice(0, i + 1) : m
    })
    setBusy(true)
    try {
      await api.resendMessage(session.id, lastUser.id, undefined, mode)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  async function commitRename(): Promise<void> {
    if (renamingId && renameText.trim()) {
      await api.renameSession(renamingId, renameText.trim())
      setSessions((list) => list.map((x) => (x.id === renamingId ? { ...x, title: renameText.trim() } : x)))
      if (session?.id === renamingId) setSession({ ...session, title: renameText.trim() })
    }
    setRenamingId(null)
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
          <button onClick={() => newSession()} title="Strg+N">
            <span className="ic">＋</span> Neuer Chat {activeProject ? `in ${activeProject.name}` : ''}
          </button>
        </div>
        <div className="sessions">
          {projects.length > 0 && (
            <>
              <h4>Projekte</h4>
              <div
                className={'session-item' + (activeProjectId === null ? ' active' : '')}
                onClick={() => setActiveProjectId(null)}
              >
                <span>Alle Chats</span>
              </div>
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={'session-item' + (activeProjectId === p.id ? ' active' : '')}
                  onClick={() => {
                    setActiveProjectId(p.id)
                    setView('chat')
                  }}
                  title={p.cwd}
                >
                  <span>
                    <span className="proj-dot" style={{ background: p.color || 'var(--accent)' }} />
                    {p.name}
                  </span>
                </div>
              ))}
            </>
          )}
          <h4>Chats</h4>
          <input
            className="session-search"
            placeholder="Suchen…"
            value={sessionFilter}
            onChange={(e) => setSessionFilter(e.target.value)}
          />
          {sessions
            .filter((s) => !activeProjectId || s.projectId === activeProjectId)
            .filter(
              (s) =>
                !sessionFilter ||
                (s.title || '').toLowerCase().includes(sessionFilter.toLowerCase()) ||
                s.cwd.toLowerCase().includes(sessionFilter.toLowerCase())
            )
            .map((s) => (
            <div
              key={s.id}
              className={'session-item' + (session?.id === s.id ? ' active' : '')}
              onClick={() => openSession(s.id)}
              onDoubleClick={() => {
                setRenamingId(s.id)
                setRenameText(s.title || '')
              }}
              title={s.cwd + ' (Doppelklick: umbenennen)'}
            >
              {renamingId === s.id ? (
                <input
                  className="rename-input"
                  value={renameText}
                  autoFocus
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div style={{ minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.title || 'Untitled'}
                  </div>
                  <div className="session-meta">
                    {basename(s.cwd)} · {relTime(s.updatedAt)}
                  </div>
                </div>
              )}
              <span
                className="x"
                onClick={async (ev) => {
                  ev.stopPropagation()
                  if (!window.confirm(`Chat „${s.title || 'Untitled'}" wirklich löschen?`)) return
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
              {gitBranch && (
                <span className="pill branch-pill" title={gitDirty ? `${gitDirty} unkommittierte Änderung(en)` : 'Working tree sauber'}>
                  ⎇ {gitBranch}
                  {gitDirty > 0 && <span style={{ color: 'var(--yellow)' }}> ·{gitDirty}Δ</span>}
                </span>
              )}
              {(activeProject?.goal || session.goal) && (
                <span
                  className="pill goal-pill"
                  title={activeProject?.goal || session.goal}
                  onClick={() => setView('projects')}
                >
                  🎯 {(activeProject?.goal || session.goal || '').slice(0, 40)}
                  {(activeProject?.goal || session.goal || '').length > 40 ? '…' : ''}
                </span>
              )}
              <div className="spacer" />
              <select
                className={'model-select mode-' + mode}
                value={mode}
                onChange={(e) => setMode(e.target.value as AgentMode)}
                title="Arbeitsmodus: Interaktiv fragt bei Änderungen, Plan ist read-only, Auto genehmigt alles"
              >
                <option value="interactive">🔵 Interaktiv</option>
                <option value="plan">📋 Plan</option>
                <option value="full">⚡ Auto</option>
              </select>
              <ContextPill messages={messages} maxTokens={64000} />
              <button className="btn ghost sm" onClick={exportChat} title="Chat als Markdown exportieren">
                Export
              </button>
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
                    onEdit={startEdit}
                  />
                ))}
                {busy && status && <div className="msg"><div className="role">working</div><div style={{ color: 'var(--text-faint)', fontSize: 13 }}>{status}</div></div>}
                {!busy && status && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>{status}</div>}
                {!busy &&
                  transcript.length > 0 &&
                  transcript[transcript.length - 1].role === 'assistant' &&
                  transcript[transcript.length - 1].finishReason === 'length' && (
                    <button className="btn ghost sm" onClick={() => send('Bitte fahre genau dort fort, wo du aufgehört hast.')}>
                      ▸ Weiter generieren
                    </button>
                  )}
                {!busy && transcript.some((m) => m.role === 'assistant') && (
                  <div className="msg-actions-row">
                    <button className="attach-btn" onClick={regenerate} title="Letzte Antwort neu generieren">
                      🔄 Neu generieren
                    </button>
                  </div>
                )}
              </div>
              {showJump && (
                <button
                  className="jump-fab"
                  onClick={() => {
                    nearBottomRef.current = true
                    setShowJump(false)
                    scrollDown()
                  }}
                >
                  ↓
                </button>
              )}
            </div>
            {todos.length > 0 && <TodoStrip todos={todos} onClear={() => setTodos([])} />}
            <Composer
              busy={busy}
              onSend={send}
              onStop={stop}
              cwd={session?.cwd}
              prefill={composerPrefill}
              onPrefillConsumed={() => setComposerPrefill(null)}
            />
          </>
        ) : view === 'projects' ? (
          <ProjectsPanel
            onOpenProject={(pid) => {
              setActiveProjectId(pid)
              refreshProjects()
              newSession(undefined, pid)
            }}
          />
        ) : view === 'usage' ? (
          <UsagePanel />
        ) : (
          <Panel view={view} settings={settings} onSettings={setSettings} cwd={session?.cwd} />
        )}
      </main>
    </div>
  )
}

// Context-window usage (~4 chars/token), warns as the conversation grows.
function ContextPill({ messages, maxTokens }: { messages: ChatMessage[]; maxTokens: number }): JSX.Element | null {
  let chars = 0
  for (const m of messages) chars += (m.content?.length ?? 0) + (m.reasoning?.length ?? 0)
  const tokens = Math.ceil(chars / 4)
  const pct = Math.min(100, Math.round((tokens / maxTokens) * 100))
  if (pct < 5) return null
  const color = pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--text-dim)'
  return (
    <span className="pill" style={{ color }} title={`~${tokens.toLocaleString()} Tokens Kontext (von ~${maxTokens.toLocaleString()}). Bei >80% lohnt sich Compact.`}>
      ⛁ {pct}%
    </span>
  )
}

function TodoStrip({ todos, onClear }: { todos: TodoItem[]; onClear: () => void }): JSX.Element {
  const done = todos.filter((t) => t.status === 'done').length
  return (
    <div className="todo-strip">
      <div className="todo-head">
        <span>
          📋 Aufgaben <b>{done}/{todos.length}</b>
        </span>
        <span className="todo-clear" onClick={onClear}>
          ausblenden
        </span>
      </div>
      <div className="todo-items">
        {todos.map((t, i) => (
          <span key={i} className={'todo-item ' + t.status}>
            {t.status === 'done' ? '✓' : t.status === 'doing' ? '◐' : '○'} {t.text}
          </span>
        ))}
      </div>
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
