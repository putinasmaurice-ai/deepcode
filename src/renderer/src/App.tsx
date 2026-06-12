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
import { AuditPanel } from './components/AuditPanel'
import { NightShiftPanel } from './components/NightShiftPanel'
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
  | 'night'
  | 'audit'
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
  { view: 'night', icon: '🌙', label: 'Nachtschicht' },
  { view: 'skills', icon: '📘', label: 'Skills' },
  { view: 'commands', icon: '/', label: 'Slash Commands' },
  { view: 'subagents', icon: '🤖', label: 'Subagents' },
  { view: 'mcp', icon: '🔌', label: 'MCP / Connectors' },
  { view: 'hooks', icon: '🪝', label: 'Hooks' },
  { view: 'memory', icon: '🧠', label: 'Memory' },
  { view: 'automations', icon: '⏰', label: 'Automations' },
  { view: 'plugins', icon: '🧩', label: 'Plugins' },
  { view: 'audit', icon: '🧾', label: 'Audit-Log' },
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
  const [toasts, setToasts] = useState<
    { id: number; text: string; kind: 'info' | 'error'; action?: { label: string; run: () => void } }[]
  >([])
  const [queue, setQueue] = useState<{ text: string; attachments?: string[] }[]>([])
  const [contentHits, setContentHits] = useState<{ sessionId: string; title: string; snippet: string }[]>([])
  const editTargetRef = useRef<string | null>(null)
  const toastIdRef = useRef(0)
  // stable handle to send() for callbacks created inside the event handler
  const sendRef = useRef<(text: string, attachments?: string[]) => void>(() => {})
  const chatRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  const addToast = useCallback(
    (text: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void => {
      const id = ++toastIdRef.current
      setToasts((t) => [...t, { id, text, kind, action }])
      setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== id)),
        action ? 12000 : kind === 'error' ? 8000 : 4000
      )
    },
    []
  )

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

  // queued messages (mid-turn steering): auto-send the next one when idle
  useEffect(() => {
    if (busy || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    send(next.text, next.attachments)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue])

  // full-text history search (debounced) when the sidebar filter has 3+ chars
  useEffect(() => {
    if (sessionFilter.trim().length < 3) {
      setContentHits([])
      return
    }
    const t = setTimeout(() => {
      api.searchSessions(sessionFilter.trim()).then((hits: typeof contentHits) => setContentHits(hits ?? []))
    }, 300)
    return () => clearTimeout(t)
  }, [sessionFilter])

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

  // apply the theme to the document root
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'dark'
  }, [settings?.theme])

  // live watcher: follow the active session's working dir (when enabled)
  useEffect(() => {
    if (settings?.watcherEnabled && session?.cwd) {
      api.watchStart(session.cwd)
      return () => {
        api.watchStop()
      }
    }
    api.watchStop()
    return undefined
  }, [settings?.watcherEnabled, session?.cwd])

  async function toggleTheme(): Promise<void> {
    if (!settings) return
    const next = { ...settings, theme: settings.theme === 'light' ? ('dark' as const) : ('light' as const) }
    setSettings(next)
    await api.saveSettings(next)
  }

  async function secondOpinion(): Promise<void> {
    if (!session || busy) return
    setBusy(true)
    try {
      await api.secondOpinion(session.id)
    } catch (err) {
      addToast((err as Error).message, 'error')
      setBusy(false)
    }
  }

  const [automationPrefill, setAutomationPrefill] = useState<string | null>(null)
  const automateFromChat = useCallback((content: string): void => {
    setAutomationPrefill(content)
    setView('automations')
  }, [])

  // local models (Ollama / LM Studio), refreshed on mount
  const [localModels, setLocalModels] = useState<string[]>([])
  useEffect(() => {
    api.listLocalModels().then((m: string[]) => setLocalModels(m ?? []))
  }, [])

  const [votedArena, setVotedArena] = useState<Set<string>>(new Set())
  async function arena(): Promise<void> {
    if (!session || busy) return
    setBusy(true)
    try {
      await api.arena(session.id)
    } catch (err) {
      addToast((err as Error).message, 'error')
      setBusy(false)
    }
  }
  async function voteArena(winner: string, loser: string, pairKey: string): Promise<void> {
    await api.arenaVote(winner, loser)
    setVotedArena((s) => new Set([...s, pairKey]))
    addToast(`Gemerkt: ${winner} bevorzugt. Fließt in die Modell-Präferenzen ein.`)
  }

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
      case 'fs_change':
        addToast(
          `👀 Extern geändert: ${e.files.slice(0, 3).join(', ')}${e.files.length > 3 ? ` +${e.files.length - 3}` : ''}`,
          'info',
          {
            label: 'Analysieren',
            run: () =>
              sendRef.current(
                `Diese Dateien wurden gerade außerhalb von dir geändert: ${e.files.join(', ')}. Lies die Änderungen und prüfe kurz, ob etwas inkonsistent oder kaputt ist.`
              )
          }
        )
        break
      case 'status':
        setStatus(e.message)
        break
      case 'error':
        setError(e.message)
        addToast(e.message, 'error')
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
      addToast(`Exportiert: ${path}`)
    } catch (err) {
      addToast((err as Error).message, 'error')
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
    if (!session) return
    // mid-turn steering: queue messages typed while the agent is working
    if (busy) {
      setQueue((q) => [...q, { text, attachments }])
      addToast('In Warteschlange — wird nach diesem Turn gesendet.')
      return
    }
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

  // keep sendRef pointing at the freshest send closure
  useEffect(() => {
    sendRef.current = send
  })

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
          <span className="spacer" />
          <span
            className="theme-toggle"
            onClick={toggleTheme}
            title={settings?.theme === 'light' ? 'Dark Mode' : 'Light Mode'}
          >
            {settings?.theme === 'light' ? '🌙' : '☀️'}
          </span>
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
            placeholder="Suchen (auch im Verlauf)…"
            value={sessionFilter}
            onChange={(e) => setSessionFilter(e.target.value)}
          />
          {contentHits.length > 0 && (
            <>
              <h4>Treffer im Verlauf</h4>
              {contentHits.map((h) => (
                <div key={h.sessionId} className="session-item" onClick={() => openSession(h.sessionId)}>
                  <div style={{ minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.title}</div>
                    <div className="session-meta">{h.snippet.slice(0, 60)}</div>
                  </div>
                </div>
              ))}
            </>
          )}
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
                title="Modell für diese Session (local: = Ollama/LM Studio, kostenlos & offline)"
              >
                {Array.from(
                  new Set([
                    settings.provider.model,
                    settings.provider.reasonerModel,
                    session.model || settings.provider.model,
                    ...localModels.map((m) => 'local:' + m)
                  ])
                ).map((m) => (
                  <option key={m} value={m}>
                    {m.startsWith('local:') ? '💻 ' + m : m}
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
                  <Welcome
                    onPick={(t) => send(t)}
                    settings={settings}
                    projectCount={projects.length}
                    onNavigate={setView}
                  />
                )}
                {transcript.map((m) => (
                  <MessageView
                    key={m.id}
                    message={m}
                    toolState={toolState}
                    onApprove={approve}
                    onEdit={startEdit}
                    onAutomate={automateFromChat}
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
                {!busy &&
                  (() => {
                    // arena vote bar: last two messages are an unvoted arena pair
                    const n = transcript.length
                    if (n < 2) return null
                    const a = transcript[n - 2]
                    const b = transcript[n - 1]
                    const pairKey = a.id + ':' + b.id
                    if (a.variant !== 'arena' || b.variant !== 'arena' || votedArena.has(pairKey)) return null
                    return (
                      <div className="vote-bar">
                        <span>🥊 Welche Antwort war besser?</span>
                        <button
                          className="btn ghost sm"
                          onClick={() => voteArena(a.variantModel!, b.variantModel!, pairKey)}
                        >
                          A: {a.variantModel}
                        </button>
                        <button
                          className="btn ghost sm"
                          onClick={() => voteArena(b.variantModel!, a.variantModel!, pairKey)}
                        >
                          B: {b.variantModel}
                        </button>
                        <button
                          className="attach-btn"
                          onClick={() => setVotedArena((s) => new Set([...s, pairKey]))}
                        >
                          Unentschieden
                        </button>
                      </div>
                    )
                  })()}
                {!busy && transcript.some((m) => m.role === 'assistant') && (
                  <div className="msg-actions-row">
                    <button className="attach-btn" onClick={regenerate} title="Letzte Antwort neu generieren">
                      🔄 Neu generieren
                    </button>
                    <button
                      className="attach-btn"
                      onClick={secondOpinion}
                      title="Das Reasoner-Modell prüft die letzte Antwort unabhängig und gibt eine eigene Einschätzung"
                    >
                      🧠 Zweitmeinung
                    </button>
                    <button
                      className="attach-btn"
                      onClick={arena}
                      title="Beide Modelle beantworten die letzte Frage parallel — du wählst den Gewinner, die App merkt sich deine Präferenz"
                    >
                      🥊 Arena
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
            {queue.length > 0 && (
              <div className="queue-strip">
                {queue.map((q, i) => (
                  <span key={i} className="chip" title={q.text}>
                    ⏭ {q.text.slice(0, 50)}
                    {q.text.length > 50 ? '…' : ''}
                    <span className="chip-x" onClick={() => setQueue((list) => list.filter((_, j) => j !== i))}>
                      ✕
                    </span>
                  </span>
                ))}
              </div>
            )}
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
        ) : view === 'night' ? (
          <NightShiftPanel />
        ) : view === 'audit' ? (
          <AuditPanel />
        ) : (
          <Panel
            view={view}
            settings={settings}
            onSettings={setSettings}
            cwd={session?.cwd}
            automationPrefill={automationPrefill}
            onAutomationPrefillUsed={() => setAutomationPrefill(null)}
          />
        )}
      </main>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.kind}>
            {t.text}
            {t.action && (
              <button
                className="btn sm"
                style={{ marginLeft: 10 }}
                onClick={() => {
                  t.action!.run()
                  setToasts((list) => list.filter((x) => x.id !== t.id))
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
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

function Welcome({
  onPick,
  settings,
  projectCount,
  onNavigate
}: {
  onPick: (t: string) => void
  settings: AppSettings
  projectCount: number
  onNavigate: (v: View) => void
}): JSX.Element {
  const [skillCount, setSkillCount] = useState<number | null>(null)
  const [mcpConnected, setMcpConnected] = useState<number | null>(null)
  useEffect(() => {
    api.listSkills().then((s: unknown[]) => setSkillCount(s?.length ?? 0))
    api
      .listMcp()
      .then((m: { status?: string }[]) => setMcpConnected(m?.filter((x) => x.status === 'connected').length ?? 0))
  }, [])

  const keyOk = !!settings.provider.apiKey
  const examples = [
    'Erkläre mir die Struktur dieses Projekts und die wichtigsten Dateien.',
    'Finde und behebe Bugs in dieser Codebasis. Führe danach die Tests aus.',
    'Implementiere ein neues Feature: …',
    '/plan Refactoring des Moduls …'
  ]
  return (
    <div className="welcome">
      <h2>🐋 DeepCode</h2>
      <p>Dein agentischer Coding-Assistent — powered by DeepSeek.</p>
      <div className="checklist">
        <div className={'check ' + (keyOk ? 'ok' : 'todo')} onClick={() => !keyOk && onNavigate('settings')}>
          {keyOk ? '✓ API-Key eingerichtet' : '○ API-Key fehlt — hier einrichten'}
        </div>
        <div
          className={'check ' + (projectCount > 0 ? 'ok' : 'todo')}
          onClick={() => projectCount === 0 && onNavigate('projects')}
        >
          {projectCount > 0 ? `✓ ${projectCount} Projekt(e)` : '○ Erstes Projekt anlegen'}
        </div>
        <div className="check ok">{skillCount === null ? '… Skills' : `✓ ${skillCount} Skills geladen`}</div>
        <div className={'check ' + ((mcpConnected ?? 0) > 0 ? 'ok' : 'dim')} onClick={() => onNavigate('mcp')}>
          {mcpConnected === null ? '… MCP' : mcpConnected > 0 ? `✓ ${mcpConnected} MCP verbunden` : '○ MCP-Connectors (optional)'}
        </div>
      </div>
      <div className="examples">
        {examples.map((e) => (
          <div className="ex" key={e} onClick={() => onPick(e)}>
            {e}
          </div>
        ))}
      </div>
      <p style={{ marginTop: 18, fontSize: 12, color: 'var(--text-faint)' }}>
        Tipp: <b>/help</b> zeigt alle Befehle · <b>Strg+N</b> neuer Chat · <b>@datei</b> hängt Dateien an
      </p>
    </div>
  )
}

function Panel({
  view,
  settings,
  onSettings,
  cwd,
  automationPrefill,
  onAutomationPrefillUsed
}: {
  view: View
  settings: AppSettings
  onSettings: (s: AppSettings) => void
  cwd?: string
  automationPrefill?: string | null
  onAutomationPrefillUsed?: () => void
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
      return (
        <AutomationsPanel
          cwd={cwd}
          initialPrompt={automationPrefill ?? undefined}
          onPrefillUsed={onAutomationPrefillUsed}
        />
      )
    default:
      return <div className="panel" />
  }
}
