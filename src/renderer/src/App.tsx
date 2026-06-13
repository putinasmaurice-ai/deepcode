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
import { Welcome, TodoStrip, ContextPill, WorkingIndicator, basename, relTime } from './components/ChatExtras'
import { contextLimit } from '../../shared/models'
import { FirstRunModal } from './components/FirstRunModal'
import { MarketPanel } from './components/MarketPanel'
import { Sidebar, NAV } from './components/Sidebar'
import { CommandPalette, PaletteItem } from './components/CommandPalette'
import { FindBar } from './components/FindBar'
import { PreviewPane } from './components/PreviewPane'
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
  | 'market'
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



export function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [toolState, setToolState] = useState<Record<string, ToolState>>({})
  // Mirror of toolState read by the global keydown handler (avoids a stale closure
  // without re-subscribing the listener on every tool update).
  const toolStateRef = useRef(toolState)
  toolStateRef.current = toolState
  // Active session id, read by the (deps:[]) agent-event handler to drop events
  // from background sessions (night shift / automations) without a stale closure.
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = session?.id ?? null
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('chat')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
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
  const [queue, setQueue] = useState<{ sessionId: string; text: string; attachments?: string[] }[]>([])
  const [contentHits, setContentHits] = useState<{ sessionId: string; title: string; snippet: string }[]>([])
  const [moreOpen, setMoreOpen] = useState(() => localStorage.getItem('nav-more') === '1')
  const [firstRunDismissed, setFirstRunDismissed] = useState(() => localStorage.getItem('firstrun-dismissed') === '1')
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

  // streaming-delta batching: accumulate chunks and flush once per frame
  // instead of one O(n) setMessages pass per token chunk
  const deltaBufRef = useRef<Map<string, { content: string; reasoning: string }>>(new Map())
  const flushScheduledRef = useRef(false)
  const queueDelta = useCallback((messageId: string, kind: 'content' | 'reasoning', delta: string): void => {
    const buf = deltaBufRef.current
    const entry = buf.get(messageId) ?? { content: '', reasoning: '' }
    entry[kind] += delta
    buf.set(messageId, entry)
    if (flushScheduledRef.current) return
    flushScheduledRef.current = true
    requestAnimationFrame(() => {
      flushScheduledRef.current = false
      const pending = deltaBufRef.current
      deltaBufRef.current = new Map()
      if (!pending.size) return
      setMessages((m) =>
        m.map((x) => {
          const d = pending.get(x.id)
          if (!d) return x
          return {
            ...x,
            content: x.content + d.content,
            reasoning: d.reasoning ? (x.reasoning ?? '') + d.reasoning : x.reasoning
          }
        })
      )
      scrollDown()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // queued messages (mid-turn steering): auto-send the next one for the
  // ACTIVE session when idle — items for other sessions wait until you return
  useEffect(() => {
    if (busy || !session) return
    const idx = queue.findIndex((q) => q.sessionId === session.id)
    if (idx === -1) return
    const next = queue[idx]
    setQueue((q) => q.filter((_, i) => i !== idx))
    send(next.text, next.attachments)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue, session?.id])

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
      if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setView('chat') // FindBar only renders in the chat view
        setFindOpen(true)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newSession()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setView('chat')
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50)
      } else if (e.key === 'Escape' && busy && session) {
        api.cancelTurn(session.id)
        setBusy(false)
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // y / n / a approve the pending tool call(s) — but only when not typing,
        // so a "y" in a message never silently approves a shell command.
        const el = document.activeElement as HTMLElement | null
        const tag = (el?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
        const ts = toolStateRef.current
        const pendingIds = Object.keys(ts).filter((id) => ts[id]?.pending)
        if (!pendingIds.length) return
        const k = e.key.toLowerCase()
        if (k === 'y') {
          e.preventDefault()
          approve(pendingIds[0], true)
        } else if (k === 'n') {
          e.preventDefault()
          approve(pendingIds[0], false)
        } else if (k === 'a') {
          e.preventDefault()
          pendingIds.forEach((id) => approve(id, true))
        }
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
  const markArenaVoted = useCallback((sessionId: string, pairKey: string): void => {
    setVotedArena((s) => {
      const next = new Set([...s, pairKey])
      localStorage.setItem('arena-voted:' + sessionId, JSON.stringify([...next]))
      return next
    })
  }, [])
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
    if (session) markArenaVoted(session.id, pairKey)
    addToast(`Gemerkt: ${winner} bevorzugt. Fließt in die Modell-Präferenzen ein.`)
  }

  // ---- agent event stream ----
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => handleEvent(e))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleEvent = useCallback((e: AgentEvent) => {
    // Drop events from a background session (night shift / automations) so they
    // don't bleed into the open chat. Still refresh the sidebar when one finishes.
    const sid = 'sessionId' in e ? (e as { sessionId?: string }).sessionId : undefined
    if (sid && sessionIdRef.current && sid !== sessionIdRef.current) {
      if (e.type === 'turn_done') refreshSessions()
      return
    }
    switch (e.type) {
      case 'session':
        // pushed after /compact: replace the transcript with the updated session
        setMessages(e.session.messages.filter((m) => m.role !== 'tool'))
        setToolState(deriveToolState(e.session.messages))
        break
      case 'user_message': {
        // reconcile the optimistic 'local-' user id with the persisted server id
        setMessages((m) => {
          for (let i = m.length - 1; i >= 0; i--) {
            if (m[i].role === 'user' && m[i].id.startsWith('local-')) {
              const copy = m.slice()
              copy[i] = { ...copy[i], id: e.id }
              return copy
            }
          }
          return m
        })
        break
      }
      case 'message_start':
        setMessages((m) => [...m, e.message])
        break
      case 'content_delta':
        queueDelta(e.messageId, 'content', e.delta)
        break
      case 'reasoning_delta':
        queueDelta(e.messageId, 'reasoning', e.delta)
        break
      case 'message_done':
        // the server copy is authoritative — drop any unflushed deltas for it
        deltaBufRef.current.delete(e.message.id)
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
    try {
      setVotedArena(new Set(JSON.parse(localStorage.getItem('arena-voted:' + s.id) ?? '[]')))
    } catch {
      setVotedArena(new Set())
    }
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

  // 🔓 Uncensored toggle: swap to the configured local unaligned model and back.
  const uncensoredModel = settings?.provider.uncensoredModel || 'local:dolphin3'
  const uncensoredActive = !!session && session.model === uncensoredModel
  async function toggleUncensored(): Promise<void> {
    if (!session) return
    if (uncensoredActive) {
      await changeModel(settings!.provider.model)
    } else {
      if (!localModels.length) {
        addToast(
          'Kein lokales Modell gefunden. Läuft Ollama? Modell laden: ollama pull dolphin3',
          'error'
        )
        return
      }
      await changeModel(uncensoredModel)
      addToast('🔓 Uncensored-Modus: lokales, ungefiltertes Modell — Antworten ohne Schutzschienen.')
    }
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
      setQueue((q) => [...q, { sessionId: session.id, text, attachments }])
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
    const isImg = (p: string): boolean => /\.(png|jpe?g|gif|webp|bmp)$/i.test(p)
    const imgPaths = (attachments ?? []).filter(isImg)
    const otherPaths = (attachments ?? []).filter((p) => !isImg(p))
    const note = otherPaths.length
      ? `\n\n📎 ${otherPaths.length} ${otherPaths.length === 1 ? 'Anhang' : 'Anhänge'}: ${otherPaths
          .map((p) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop())
          .join(', ')}`
      : ''
    const userMsg: ChatMessage = {
      id: 'local-' + Date.now(),
      role: 'user',
      content: text + note,
      createdAt: Date.now()
    }
    // resolve image thumbnails for an instant preview
    if (imgPaths.length) {
      const uris = (await Promise.all(imgPaths.map((p) => api.imageDataUri(p)))).filter(
        (u): u is string => !!u
      )
      if (uris.length) userMsg.images = uris
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

  async function removeSession(id: string): Promise<void> {
    const s = sessions.find((x) => x.id === id)
    if (!window.confirm(`Chat „${s?.title || 'Untitled'}" wirklich löschen?`)) return
    await api.deleteSession(id)
    const list = await api.listSessions()
    setSessions(list)
    if (session?.id === id) {
      if (list.length) openSession(list[0].id)
      else newSession()
    }
  }

  const approve = useCallback((callId: string, approved: boolean, remember?: boolean): void => {
    api.approveTool(callId, approved, remember)
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

  // Command palette (Ctrl+P): every view, the common actions, and the recent
  // chats — all fuzzy-searchable from one place.
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: 'act:new', icon: '✨', label: 'Neuer Chat', hint: 'Ctrl+N', run: () => newSession() },
      {
        id: 'act:focus',
        icon: '⌨️',
        label: 'Eingabe fokussieren',
        hint: 'Ctrl+K',
        run: () => {
          setView('chat')
          setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50)
        }
      },
      {
        id: 'act:find',
        icon: '🔎',
        label: 'Im Chat suchen',
        hint: 'Ctrl+F',
        run: () => {
          setView('chat')
          setFindOpen(true)
        }
      },
      {
        id: 'act:preview',
        icon: '👁',
        label: 'Projekt-Vorschau umschalten',
        run: () => {
          setView('chat')
          setPreviewOpen((o) => !o)
        }
      },
      { id: 'act:export', icon: '⬇️', label: 'Chat exportieren (Markdown)', run: () => void exportChat() },
      { id: 'act:compact', icon: '🗜️', label: 'Kontext komprimieren (/compact)', run: () => void compact() },
      { id: 'act:uncensored', icon: '🔓', label: 'Uncensored-Modus umschalten', run: () => void toggleUncensored() },
      { id: 'act:theme', icon: '🌓', label: 'Theme wechseln', run: () => toggleTheme() }
    ]
    const views: PaletteItem[] = NAV.map((n) => ({
      id: 'view:' + n.view,
      icon: n.icon,
      label: 'Öffnen: ' + n.label,
      run: () => setView(n.view)
    }))
    const chats: PaletteItem[] = sessions.slice(0, 25).map((s) => ({
      id: 'chat:' + s.id,
      icon: '💬',
      label: s.title || 'Untitled',
      hint: relTime(s.updatedAt),
      run: () => {
        setView('chat')
        void openSession(s.id)
      }
    }))
    return [...actions, ...views, ...chats]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  if (!settings) return <div className="spinner" />


  return (
    <div className="app">
      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      <Sidebar
        settings={settings}
        view={view}
        onView={setView}
        moreOpen={moreOpen}
        onToggleMore={() => {
          const next = !moreOpen
          setMoreOpen(next)
          localStorage.setItem('nav-more', next ? '1' : '0')
        }}
        onToggleTheme={toggleTheme}
        projects={projects}
        activeProject={activeProject}
        activeProjectId={activeProjectId}
        onSelectProject={(id) => {
          setActiveProjectId(id)
          if (id) setView('chat')
        }}
        sessions={sessions}
        activeSessionId={session?.id ?? null}
        onOpenSession={openSession}
        onDeleteSession={removeSession}
        onNewSession={() => newSession()}
        sessionFilter={sessionFilter}
        onFilter={setSessionFilter}
        contentHits={contentHits}
        renamingId={renamingId}
        renameText={renameText}
        onRenameText={setRenameText}
        onStartRename={(id, title) => {
          setRenamingId(id)
          setRenameText(title)
        }}
        onCommitRename={commitRename}
        onCancelRename={() => setRenamingId(null)}
      />

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
              <ContextPill
                messages={messages}
                maxTokens={contextLimit(session.model || settings.provider.model)}
              />
              <button className="btn ghost sm" onClick={exportChat} title="Chat als Markdown exportieren">
                Export
              </button>
              <button
                className={'btn ghost sm' + (previewOpen ? ' on' : '')}
                onClick={() => setPreviewOpen((o) => !o)}
                title="Live-Vorschau des Projekts (HTML / Dev-Server) neben dem Chat"
              >
                👁 Vorschau
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
              <button
                className={'btn ghost sm uncensored-btn' + (uncensoredActive ? ' on' : '')}
                onClick={toggleUncensored}
                title={
                  uncensoredActive
                    ? 'Uncensored aktiv — klicken für zurück zum Standardmodell'
                    : `Auf lokales, ungefiltertes Modell umschalten (${uncensoredModel})`
                }
              >
                {uncensoredActive ? '🔓 Uncensored' : '🔒'}
              </button>
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
          <div className={'chat-split' + (previewOpen ? ' with-preview' : '')}>
           <div className="chat-col">
            {findOpen && <FindBar onClose={() => setFindOpen(false)} />}
            <div className="chat" ref={chatRef} onScroll={onChatScroll}>
              <div className="chat-inner">
                {apiKeyMissing && (
                  <div className="banner">
                    No DeepSeek API key set. Open <b>Settings</b> to add your key and model.
                  </div>
                )}
                {uncensoredActive && (
                  <div className="banner uncensored-banner">
                    🔓 <b>Uncensored-Modus</b> — lokales Modell ({uncensoredModel.replace('local:', '')}),
                    offline & ohne Filter. Du trägst die Verantwortung für die Nutzung.
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
                    cwd={session?.cwd}
                  />
                ))}
                {busy && <WorkingIndicator status={status} />}
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
                          onClick={() => session && markArenaVoted(session.id, pairKey)}
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
            {queue.filter((q) => q.sessionId === session?.id).length > 0 && (
              <div className="queue-strip">
                {queue.filter((q) => q.sessionId === session?.id).map((q, i) => (
                  <span key={i} className="chip" title={q.text}>
                    ⏭ {q.text.slice(0, 50)}
                    {q.text.length > 50 ? '…' : ''}
                    <span className="chip-x" onClick={() => setQueue((list) => list.filter((x) => x !== q))}>
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
           </div>
           {previewOpen && session && (
             <PreviewPane cwd={session.cwd} onClose={() => setPreviewOpen(false)} />
           )}
          </div>
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
        ) : view === 'market' ? (
          <MarketPanel />
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
      {settings && !settings.provider.apiKey && !firstRunDismissed && (
        <FirstRunModal
          settings={settings}
          onSaved={(s) => setSettings(s)}
          onDismiss={() => {
            localStorage.setItem('firstrun-dismissed', '1')
            setFirstRunDismissed(true)
          }}
        />
      )}
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
