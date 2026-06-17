import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type {
  AgentEvent,
  AppSettings,
  ChatMessage,
  ProjectDef,
  Session,
  TodoItem,
  ToolResult
} from '../../shared/types'
import { MIN_SECRET_LEN } from '../../shared/types'

export type AgentMode = 'interactive' | 'plan' | 'full'
import { Composer } from './components/Composer'
import { MessageView } from './components/MessageView'
import { ProjectsPanel } from './components/ProjectsPanel'
import { Welcome, TodoStrip, ContextPill, WorkingIndicator, basename, relTime } from './components/ChatExtras'
import { contextLimit } from '../../shared/models'
import { FirstRunModal } from './components/FirstRunModal'
import { Sidebar, NAV } from './components/Sidebar'
import { CommandPalette, PaletteItem } from './components/CommandPalette'
import { FindBar } from './components/FindBar'
import { PreviewPane } from './components/PreviewPane'
import { CrystalBall } from './components/CrystalBall'
import { NewFolderDialog } from './components/NewFolderDialog'
import { NewChatDialog } from './components/NewChatDialog'
import { SessionTabs } from './components/SessionTabs'
// Heavy, view-gated panels are code-split (lazy) so the cold-start bundle stays small — the big
// one is the workflow editor (React Flow). Each loads its chunk on first open.
const WorkflowsPanel = lazy(() => import('./components/workflow/WorkflowsPanel').then((m) => ({ default: m.WorkflowsPanel })))
const MarketPanel = lazy(() => import('./components/MarketPanel').then((m) => ({ default: m.MarketPanel })))
const AuditPanel = lazy(() => import('./components/AuditPanel').then((m) => ({ default: m.AuditPanel })))
const TracePanel = lazy(() => import('./components/TracePanel').then((m) => ({ default: m.TracePanel })))
const SwarmPanel = lazy(() => import('./components/SwarmPanel').then((m) => ({ default: m.SwarmPanel })))
const NightShiftPanel = lazy(() => import('./components/NightShiftPanel').then((m) => ({ default: m.NightShiftPanel })))
const MissionPanel = lazy(() => import('./components/MissionPanel').then((m) => ({ default: m.MissionPanel })))
const UsagePanel = lazy(() => import('./components/UsagePanel').then((m) => ({ default: m.UsagePanel })))
const TimeMachinePanel = lazy(() => import('./components/timemachine/TimeMachinePanel').then((m) => ({ default: m.TimeMachinePanel })))
import { inOffPeak } from '../../shared/offpeak'
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
  | 'missions'
  | 'market'
  | 'audit'
  | 'traces'
  | 'swarm'
  | 'settings'
  | 'skills'
  | 'commands'
  | 'subagents'
  | 'hooks'
  | 'memory'
  | 'mcp'
  | 'plugins'
  | 'automations'
  | 'workflows'
  | 'timemachine'

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
  // Per-session run tracking: which sessions have an in-flight turn/op. `busy` is DERIVED for the
  // OPEN session, so switching chats reflects each chat's real state. A single global boolean
  // stranded the UI 'working' and locked the user out after switching away from a running chat.
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set())
  const startRun = useCallback((id: string) => setRunning((r) => {
    const n = new Set(r)
    n.add(id)
    return n
  }), [])
  const endRun = useCallback((id?: string) => {
    if (!id) return
    setRunning((r) => {
      if (!r.has(id)) return r
      const n = new Set(r)
      n.delete(id)
      return n
    })
  }, [])
  const busy = !!session && running.has(session.id)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  // 🔐 Secure secret prompt: a single open request. The typed value lives ONLY in
  // the inline prompt's local state and goes straight to api.submitSecret — it is
  // never put into `messages`, logged, or echoed back through the LLM/transcript.
  const [pendingSecret, setPendingSecret] = useState<{ callId: string; name: string; reason?: string } | null>(null)
  const [view, setView] = useState<View>('chat')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  // 🔮 Crystal Ball: defer the next send until the DeepSeek off-peak window opens
  const [deferOffPeak, setDeferOffPeak] = useState(false)
  const [deferred, setDeferred] = useState<{
    text: string
    attachments?: string[]
    sessionId: string
    // snapshot of the edit target at defer time, so a later normal send can't reuse a stale one (H8)
    editId?: string | null
  } | null>(null)
  // toggling the switch either way cancels any pending wait (predictable "never mind")
  const toggleDefer = useCallback(() => {
    setDeferOffPeak((v) => !v)
    setDeferred(null)
  }, [])
  const [sessionUsage, setSessionUsage] = useState<{ tokens: number; cost: number }>({
    tokens: 0,
    cost: 0
  })
  const [projects, setProjects] = useState<ProjectDef[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  // ids of the chats currently open as tabs (a subset of `sessions`); the active tab is `session`
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [mode, setMode] = useState<AgentMode>('interactive')
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [sessionFilter, setSessionFilter] = useState('')
  const [showJump, setShowJump] = useState(false)
  const [gitDirty, setGitDirty] = useState(0)
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  const [toasts, setToasts] = useState<
    { id: number; text: string; kind: 'info' | 'error'; action?: { label: string; run: () => void } }[]
  >([])
  const [queue, setQueue] = useState<{ sessionId: string; text: string; attachments?: string[]; editId?: string | null }[]>([])
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
    // restore the edit target snapshotted when this item was queued, so an edit-and-resend
    // typed mid-turn still truncates from the right point (H8)
    editTargetRef.current = next.editId ?? null
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
        requestNewChat()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setView('chat')
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50)
      } else if (e.ctrlKey && e.key === 'Tab') {
        // Ctrl+Tab / Ctrl+Shift+Tab cycle through the open chat tabs (browser-style)
        e.preventDefault()
        if (openTabs.length >= 2) {
          const cur = session?.id ? openTabs.indexOf(session.id) : -1
          const dir = e.shiftKey ? -1 : 1
          void openSession(openTabs[(cur + dir + openTabs.length) % openTabs.length])
        }
      } else if (
        e.key === 'Escape' &&
        busy &&
        session &&
        // an open overlay (palette / find) owns Escape itself; and a focused <input> is a
        // rename/search/settings field whose Escape should not cancel the running turn. The
        // composer is a <textarea>, so Escape-to-cancel from the composer still works.
        !paletteOpen &&
        !findOpen &&
        (document.activeElement?.tagName || '').toLowerCase() !== 'input'
      ) {
        api.cancelTurn(session.id).catch(() => {})
        // #36: keep busy until the backend releases the lock + emits turn_done (see stop()).
        setStatus('Stoppe…')
        // cancelling means "stop" — don't let the queue-drain effect fire the next
        // queued steering message as a brand-new turn.
        setQueue((q) => q.filter((x) => x.sessionId !== session.id))
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
  }, [activeProjectId, settings, busy, session, paletteOpen, findOpen, openTabs])

  // ---- bootstrap ----
  useEffect(() => {
    ;(async () => {
      const s = await api.getSettings()
      setSettings(s)
      setProjects(await api.listProjects())
      const list = await api.listSessions()
      setSessions(list)
      // restore the previously open tabs (multi-session workspace); drop any that no longer
      // exist, then re-open the last active one.
      let saved: string[] = []
      try {
        saved = JSON.parse(localStorage.getItem('open-tabs') || '[]')
      } catch {
        saved = []
      }
      const validTabs = saved.filter((id) => list.some((x) => x.id === id))
      const active = localStorage.getItem('active-tab')
      if (validTabs.length) {
        setOpenTabs(validTabs)
        await openSession(validTabs.includes(active ?? '') ? (active as string) : validTabs[0])
      } else if (list.length) {
        await openSession(list[0].id)
      } else {
        await newSession(s)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // persist the open tabs + active tab so a restart restores your workspace of chats
  useEffect(() => {
    localStorage.setItem('open-tabs', JSON.stringify(openTabs))
  }, [openTabs])
  useEffect(() => {
    if (session?.id) localStorage.setItem('active-tab', session.id)
  }, [session?.id])
  // mirror openTabs into a ref so the stable event handler can tell a finished BACKGROUND chat
  // (an open tab you switched away from) apart from an automation/night-shift session
  const openTabsRef = useRef<string[]>([])
  useEffect(() => {
    openTabsRef.current = openTabs
  }, [openTabs])

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
    await api.saveSettings(next).catch((e) => addToast(String(e), 'error'))
  }

  // 👁 ONLINE/LOKAL: which model understands attached images (Gemini vs local Ollama).
  async function toggleVisionMode(): Promise<void> {
    if (!settings) return
    const mode = settings.visionMode === 'online' ? ('local' as const) : ('online' as const)
    const next = { ...settings, visionMode: mode }
    setSettings(next)
    await api.saveSettings(next).catch((e) => addToast(String(e), 'error'))
    if (mode === 'online' && !settings.provider.googleApiKey?.trim()) {
      addToast('👁 Online-Bildanalyse (Gemini) aktiv — aber kein Google-Key gesetzt. Trage ihn in den Settings ein.', 'error')
    } else {
      addToast(mode === 'online' ? '👁 Bildanalyse ONLINE (Gemini 2.5 Flash-Lite).' : '👁 Bildanalyse LOKAL (Ollama).')
    }
  }

  async function secondOpinion(): Promise<void> {
    if (!session || busy) return
    const sid = session.id
    startRun(sid)
    try {
      await api.secondOpinion(sid)
    } catch (err) {
      addToast((err as Error).message, 'error')
      endRun(sid)
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
    const sid = session.id
    startRun(sid)
    try {
      await api.arena(sid)
    } catch (err) {
      addToast((err as Error).message, 'error')
      endRun(sid)
    }
  }
  async function voteArena(winner: string, loser: string, pairKey: string): Promise<void> {
    try {
      await api.arenaVote(winner, loser)
      if (session) markArenaVoted(session.id, pairKey)
      addToast(`Gemerkt: ${winner} bevorzugt. Fließt in die Modell-Präferenzen ein.`)
    } catch (e) {
      addToast(String(e), 'error')
    }
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
    // Drop any event whose session doesn't match the open chat — even when no chat is
    // open (sessionIdRef.current === null), a stamped background event must not bleed in.
    if (sid && sid !== sessionIdRef.current) {
      // a background turn finishing must still clear ITS running entry (so switching back to that
      // chat shows it idle), even though we don't render its events here.
      if (e.type === 'turn_done') {
        endRun(sid)
        refreshSessions()
        // if it's a chat you have open in another tab (not an automation), let you know it's done
        if (openTabsRef.current.includes(sid)) {
          api
            .getSession(sid)
            .then((bs) => {
              if (bs) {
                addToast(`✓ „${bs.title || 'Chat'}" fertig`, 'info', {
                  label: 'Öffnen',
                  run: () => void openSession(sid)
                })
              }
            })
            .catch(() => {})
        }
      }
      return
    }
    switch (e.type) {
      case 'session':
        // pushed after /compact: replace the transcript with the updated session. Guard on the
        // session's OWN id (not just the scoped envelope) so a /compact that resolves after the
        // user switched chats can never overwrite the wrong transcript.
        if (e.session.id !== sessionIdRef.current) break
        setMessages(e.session.messages.filter((m) => m.role !== 'tool'))
        setToolState(deriveToolState(e.session.messages))
        break
      case 'user_message': {
        // Reconcile the renderer's user-message id with the persisted server id.
        // On a fresh send there's an optimistic 'local-' message; on regenerate the
        // server re-mints the id with NO local- message, so fall back to the LAST
        // user message — otherwise a 2nd regenerate would resend a stale id and fail.
        setMessages((m) => {
          let localIdx = -1
          let lastUserIdx = -1
          for (let i = m.length - 1; i >= 0; i--) {
            if (m[i].role === 'user') {
              if (lastUserIdx < 0) lastUserIdx = i
              if (m[i].id.startsWith('local-')) {
                localIdx = i
                break
              }
            }
          }
          const idx = localIdx >= 0 ? localIdx : lastUserIdx
          if (idx < 0 || m[idx].id === e.id) return m
          const copy = m.slice()
          copy[idx] = { ...copy[idx], id: e.id }
          return copy
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
      case 'secret_request':
        // Open the secure prompt. If one is already open, auto-cancel it (submit null)
        // before replacing, so the previous waiting promise settles.
        setPendingSecret((prev) => {
          if (prev && prev.callId !== e.callId) {
            api.submitSecret(prev.callId, null).catch(() => {})
          }
          return { callId: e.callId, name: e.name, reason: e.reason }
        })
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
        endRun(sid ?? sessionIdRef.current ?? undefined)
        setStatus('')
        // Tear down any open secret prompt — its backing turn just ended, so the main-side
        // promise is already dead and a late Save would be a silent no-op. Settle main
        // deterministically (submit null) before dropping it so nothing leaks.
        setPendingSecret((prev) => {
          if (prev) api.submitSecret(prev.callId, null).catch(() => {})
          return null
        })
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
    setDeferred(null) // a pending off-peak send belongs to the session it was queued in
    // a secret prompt belongs to the session that opened it — drop it (and settle main) on
    // switch so session A's prompt can't render under session B's composer (cross-session bleed).
    setPendingSecret((prev) => {
      if (prev) api.submitSecret(prev.callId, null).catch(() => {})
      return null
    })
    setSession(s)
    setOpenTabs((t) => (t.includes(id) ? t : [...t, id]))
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
    setStatus('') // status is global text; clear it on switch (the opened session repopulates it)
    nearBottomRef.current = true
    scrollDown()
  }

  async function newSession(
    s?: AppSettings | null,
    projectId?: string | null,
    cwdOverride?: string
  ): Promise<void> {
    const pid = projectId !== undefined ? projectId : activeProjectId
    // a workspace explicitly chosen in the New-Chat dialog wins over the project/default cwd
    const cwd = cwdOverride || (pid ? undefined : (s ?? settings)?.defaultCwd)
    const created = await api.createSession(cwd || undefined, pid || undefined)
    setSessions((list) => [created, ...list])
    setOpenTabs((t) => (t.includes(created.id) ? t : [...t, created.id]))
    setDeferred(null) // drop any pending off-peak send from the previous chat
    // drop (and settle main on) any secret prompt from the previous chat — it belongs there
    setPendingSecret((prev) => {
      if (prev) api.submitSecret(prev.callId, null).catch(() => {})
      return null
    })
    setSession(created)
    setMessages([])
    setToolState({})
    setSessionUsage({ tokens: 0, cost: 0 })
    setView('chat')
    setError('')
    setStatus('')
  }

  // User-initiated "new chat" (Ctrl+N, palette, sidebar +): ask for the workspace up front —
  // pick an existing folder or create a fresh one — then start the chat there. Auto-creates
  // (boot, last-chat-deleted) and project chats keep starting directly without the prompt.
  function requestNewChat(): void {
    setShowNewChat(true)
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
    try {
      await api.updateSessionModel(session.id, model)
      setSession({ ...session, model })
      setSessions((list) => list.map((x) => (x.id === session.id ? { ...x, model } : x)))
    } catch (e) {
      addToast(String(e), 'error')
    }
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
    const sid = session.id
    startRun(sid)
    try {
      const updated = (await api.compactSession(sid)) as Session
      if (updated) {
        setMessages(updated.messages.filter((m) => m.role !== 'tool'))
        setToolState(deriveToolState(updated.messages))
      }
    } finally {
      endRun(sid)
    }
  }

  async function send(text: string, attachments?: string[]): Promise<void> {
    if (!session) return
    // mid-turn steering: queue messages typed while the agent is working.
    // Snapshot + clear the edit target NOW (H8): leaving it set would make the next
    // normal send wrongly truncate from this stale edit point. The queued item carries it.
    if (busy) {
      const editId = editTargetRef.current
      editTargetRef.current = null
      setQueue((q) => [...q, { sessionId: session.id, text, attachments, editId }])
      addToast('In Warteschlange — wird nach diesem Turn gesendet.')
      return
    }
    // 🔮 off-peak defer: hold a fresh send until the discount window opens. Same H8
    // snapshot-and-clear so the held edit target can't leak into a later normal send.
    if (deferOffPeak && !inOffPeak()) {
      const editId = editTargetRef.current
      editTargetRef.current = null
      setDeferred({ text, attachments, sessionId: session.id, editId })
      addToast('⏳ Wird im günstigen Off-Peak-Fenster gesendet.')
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
    startRun(session.id) // cleared by the scoped turn_done event (or here on a send-IPC rejection)
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
      endRun(session.id)
    }
  }

  // keep sendRef pointing at the freshest send closure
  useEffect(() => {
    sendRef.current = send
  })

  // 🔮 off-peak defer: once a message is held, fire it as soon as the discount
  // window opens (checked now + every 30s while the app stays open).
  useEffect(() => {
    if (!deferred) return
    const fire = (): void => {
      // only fire into the session the message was queued in, and only in off-peak
      if (inOffPeak() && deferred.sessionId === sessionIdRef.current) {
        const d = deferred
        setDeferred(null)
        // restore the edit target snapshotted at defer time so the resend truncates correctly (H8)
        editTargetRef.current = d.editId ?? null
        sendRef.current(d.text, d.attachments)
      }
    }
    fire()
    const t = setInterval(fire, 30_000)
    return () => clearInterval(t)
  }, [deferred])

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
    startRun(session.id)
    try {
      await api.resendMessage(session.id, lastUser.id, undefined, mode)
    } catch (err) {
      setError((err as Error).message)
      endRun(session.id)
    }
  }

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  async function commitRename(): Promise<void> {
    if (renamingId && renameText.trim()) {
      try {
        await api.renameSession(renamingId, renameText.trim())
        setSessions((list) => list.map((x) => (x.id === renamingId ? { ...x, title: renameText.trim() } : x)))
        if (session?.id === renamingId) setSession({ ...session, title: renameText.trim() })
      } catch (e) {
        addToast(String(e), 'error')
      }
    }
    setRenamingId(null)
  }

  async function removeSession(id: string): Promise<void> {
    const s = sessions.find((x) => x.id === id)
    if (!window.confirm(`Chat „${s?.title || 'Untitled'}" wirklich löschen?`)) return
    try {
      await api.deleteSession(id)
    } catch (e) {
      addToast(String(e), 'error')
      return
    }
    const list = await api.listSessions()
    setSessions(list)
    const remainingTabs = openTabs.filter((t) => t !== id)
    setOpenTabs(remainingTabs)
    if (session?.id === id) {
      // prefer another still-open tab, else the most recent session, else a fresh chat
      const fallback = remainingTabs[0] ?? list[0]?.id
      if (fallback) openSession(fallback)
      else newSession()
    }
  }

  // Close a tab WITHOUT deleting the chat (it stays in the sidebar). If it was the active tab,
  // switch to a neighbour; closing the last open tab falls back to the most recent session (or a
  // fresh chat) so an agent is never left without a working session.
  function closeTab(id: string): void {
    const idx = openTabs.indexOf(id)
    const next = openTabs.filter((t) => t !== id)
    setOpenTabs(next)
    if (id === session?.id) {
      const fallback = next[idx] ?? next[idx - 1] ?? next[next.length - 1] ?? sessions.find((s) => s.id !== id)?.id
      if (fallback) void openSession(fallback)
      else void newSession()
    }
  }

  // Drag-reorder the tab strip. `openTabs` is the single ordered source of truth — `tabSessions`
  // renders in this order and the localStorage effect persists it, so reordering it is all we do.
  function reorderTabs(from: number, to: number): void {
    setOpenTabs((t) => {
      if (from < 0 || to < 0 || from >= t.length || to >= t.length || from === to) return t
      const next = t.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const approve = useCallback((callId: string, approved: boolean, remember?: boolean): void => {
    api.approveTool(callId, approved, remember).catch((e) => addToast(String(e), 'error'))
    setToolState((t) => ({ ...t, [callId]: { ...t[callId], pending: false } }))
  }, [])

  // 🔐 Resolve the open secret prompt. The value (or null on cancel) goes ONLY to
  // api.submitSecret → main → setSecret; it is never stored in messages or logged.
  const resolveSecret = useCallback((callId: string, value: string | null): void => {
    // Cancel (null) always closes immediately. A submitted value waits for the store outcome:
    // if main REJECTS it (too short / no OS encryption — error is a static constraint message,
    // never the value), keep the prompt open and surface why so the user can correct it instead
    // of silently believing it was saved.
    if (value === null) {
      api.submitSecret(callId, null).catch(() => {})
      setPendingSecret((p) => (p && p.callId === callId ? null : p))
      return
    }
    api
      .submitSecret(callId, value)
      .then((r) => {
        if (r?.set) {
          setPendingSecret((p) => (p && p.callId === callId ? null : p))
        } else {
          addToast(r?.error || 'Secret konnte nicht gespeichert werden.', 'error')
          // leave the prompt open so the user can fix the value (or cancel)
        }
      })
      .catch((e) => addToast(String(e), 'error'))
  }, [addToast])

  function stop(): void {
    if (session) {
      api.cancelTurn(session.id).catch(() => {})
      // stop means stop — clear queued steering messages so none auto-fires
      setQueue((q) => q.filter((x) => x.sessionId !== session.id))
      // #36: do NOT clear `running` optimistically. The backend session lock releases only when
      // the in-flight tool/stream unwinds and emits turn_done (which clears it). Flipping busy off
      // now would let an immediate follow-up send fail to acquire the still-held lock and orphan
      // the message. Show a transitional "Stoppe…" until turn_done arrives.
      setStatus('Stoppe…')
    }
  }

  // Change the current session's working directory in place (keeps the chat). Shared by the
  // "pick existing folder" and "create new folder" paths in the topbar.
  async function applyCwd(dir: string): Promise<void> {
    if (!session) return
    try {
      const updated = (await api.changeCwd(session.id, dir)) as Session
      setSession(updated)
      setSessions((list) => list.map((x) => (x.id === updated.id ? { ...x, cwd: dir } : x)))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function pickCwd(): Promise<void> {
    if (!session) return
    const dir = await api.pickDirectory()
    if (dir) await applyCwd(dir)
  }

  const apiKeyMissing = settings && !settings.provider.apiKey

  const transcript = useMemo(() => messages.filter((m) => !m.hidden), [messages])

  // resolve the open-tab ids to their sessions for the tab strip (active one uses the freshest
  // `session` object so an in-flight rename/title shows immediately)
  const tabSessions = useMemo(
    () =>
      openTabs
        .map((id) => (id === session?.id ? session : sessions.find((s) => s.id === id)))
        .filter((s): s is Session => !!s),
    [openTabs, sessions, session]
  )

  // Command palette (Ctrl+P): every view, the common actions, and the recent
  // chats — all fuzzy-searchable from one place.
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: 'act:new', icon: '✨', label: 'Neuer Chat', hint: 'Ctrl+N', run: () => requestNewChat() },
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
    // Must include session/settings/busy: the action closures (export/compact/
    // uncensored) capture them, and switching chats changes `session` but NOT
    // `sessions` — without these deps the palette would act on the previous chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, session, settings, busy])

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
        onNewSession={requestNewChat}
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
        {tabSessions.length > 0 && (
          <SessionTabs
            tabs={tabSessions}
            activeId={session?.id ?? null}
            running={running}
            onSelect={(id) => void openSession(id)}
            onClose={closeTab}
            onNew={requestNewChat}
            onReorder={reorderTabs}
          />
        )}
        <div className="topbar">
          {view === 'chat' && session && (
            <>
              <div
                className="cwd"
                role="button"
                tabIndex={0}
                onClick={pickCwd}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void pickCwd()
                  }
                }}
                title="Click to change the working directory"
              >
                📁 {session.cwd}
              </div>
              <button
                className="pill"
                style={{ cursor: 'pointer' }}
                onClick={() => setShowNewFolder(true)}
                title="Neuen, leeren Projektordner anlegen und als Arbeitsplatz öffnen"
              >
                ＋ Ordner
              </button>
              {gitBranch && (
                <span className="pill branch-pill" title={gitDirty ? `${gitDirty} unkommittierte Änderung(en)` : 'Working tree sauber'}>
                  ⎇ {gitBranch}
                  {gitDirty > 0 && <span style={{ color: 'var(--yellow)' }}> ·{gitDirty}Δ</span>}
                </span>
              )}
              {(activeProject?.goal || session.goal) && (
                <span
                  className="pill goal-pill"
                  role="button"
                  tabIndex={0}
                  title={activeProject?.goal || session.goal}
                  onClick={() => setView('projects')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setView('projects')
                    }
                  }}
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
                    ...(settings.provider.extraModels ?? []),
                    ...localModels.map((m) => 'local:' + m)
                  ])
                ).map((m) => (
                  <option key={m} value={m}>
                    {m.startsWith('local:')
                      ? '💻 ' + m.slice('local:'.length)
                      : m.startsWith('deepinfra:')
                        ? '☁️ ' + m.slice('deepinfra:'.length)
                        : m.startsWith('together:')
                          ? '🧩 ' + m.slice('together:'.length)
                          : m}
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
              <button
                className={'btn ghost sm vision-btn' + (settings?.visionMode === 'online' ? ' on' : '')}
                onClick={toggleVisionMode}
                title={
                  settings?.visionMode === 'online'
                    ? `Bild-Analyse ONLINE (Gemini ${settings?.provider.onlineVisionModel || '2.5 Flash-Lite'}) — klicken für LOKAL`
                    : `Bild-Analyse LOKAL (${(settings?.provider.visionModel || 'lokal').replace('local:', '')}) — klicken für ONLINE (Gemini)`
                }
              >
                {settings?.visionMode === 'online' ? '👁 Online' : '👁 Lokal'}
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

        <Suspense fallback={<div className="panel"><div className="panel-inner" style={{ color: 'var(--text-faint)' }}>Lädt…</div></div>}>
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
                    live={busy}
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
            {deferred && (
              <div className="queue-strip">
                <span className="chip" title={deferred.text}>
                  ⏳ Wartet auf Off-Peak: {deferred.text.slice(0, 50)}
                  {deferred.text.length > 50 ? '…' : ''}
                  <span className="chip-x" onClick={() => setDeferred(null)}>
                    ✕
                  </span>
                </span>
              </div>
            )}
            {pendingSecret && (
              <SecretPrompt
                key={pendingSecret.callId}
                name={pendingSecret.name}
                reason={pendingSecret.reason}
                onSave={(value) => resolveSecret(pendingSecret.callId, value)}
                onCancel={() => resolveSecret(pendingSecret.callId, null)}
              />
            )}
            <CrystalBall
              sessionId={session?.id ?? null}
              busy={busy}
              deferOffPeak={deferOffPeak}
              onToggleDefer={toggleDefer}
            />
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
             <PreviewPane cwd={session.cwd} onClose={() => setPreviewOpen(false)} onFix={(p) => void send(p)} />
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
        ) : view === 'missions' ? (
          <MissionPanel />
        ) : view === 'market' ? (
          <MarketPanel />
        ) : view === 'workflows' ? (
          <WorkflowsPanel />
        ) : view === 'audit' ? (
          <AuditPanel />
        ) : view === 'traces' ? (
          <TracePanel />
        ) : view === 'swarm' ? (
          <SwarmPanel />
        ) : view === 'timemachine' ? (
          <TimeMachinePanel />
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
        </Suspense>
      </main>
      {showNewFolder && (
        <NewFolderDialog
          onClose={() => setShowNewFolder(false)}
          onCreated={(path) => {
            setShowNewFolder(false)
            void applyCwd(path)
          }}
        />
      )}
      {showNewChat && (
        <NewChatDialog
          defaultCwd={session?.cwd || settings?.defaultCwd || ''}
          onClose={() => setShowNewChat(false)}
          onStart={(cwd) => {
            setShowNewChat(false)
            // projectId undefined → keep the existing active-project behavior; the chosen
            // workspace still wins for the chat's working directory via cwdOverride.
            void newSession(undefined, undefined, cwd || undefined)
          }}
        />
      )}
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

// 🔐 Secure inline secret prompt. The typed value lives ONLY in this component's
// local state and is handed straight to onSave (→ api.submitSecret → main →
// setSecret). It is never logged, added to messages, or echoed to the LLM.
function SecretPrompt({
  name,
  reason,
  onSave,
  onCancel
}: {
  name: string
  reason?: string
  onSave: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  // mirror the main-side minimum so a too-short value can't even be submitted (a shorter secret
  // can't be reliably masked out of logs/runs, so setSecret would reject it server-side anyway).
  const tooShort = value.length < MIN_SECRET_LEN
  const save = (): void => {
    if (tooShort) return
    onSave(value)
    // NOTE: don't clear `value` here — a successful save unmounts this component (which discards
    // its state), and on a server-side rejection the prompt stays open so the user keeps the value.
  }
  return (
    <div
      className="secret-prompt"
      role="dialog"
      aria-label={`Secret ${name} eingeben`}
      style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-2)',
        padding: '10px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6
      }}
    >
      <div style={{ fontSize: 13 }}>
        🔐 <b>{name}</b> sicher eingeben
      </div>
      {reason && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{reason}</div>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          ref={inputRef}
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder={`Wert für ${name}…`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
          style={{
            flex: 1,
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '7px 10px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)'
          }}
        />
        <button className="btn sm" disabled={tooShort} onClick={save}>
          Speichern
        </button>
        <button className="btn ghost sm" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
      <div style={{ fontSize: 11, color: tooShort && value.length > 0 ? 'var(--yellow)' : 'var(--text-faint)' }}>
        {tooShort && value.length > 0
          ? `Mindestens ${MIN_SECRET_LEN} Zeichen.`
          : `Mind. ${MIN_SECRET_LEN} Zeichen. Wird verschlüsselt gespeichert und nie an das Modell oder den Chatverlauf gesendet.`}
      </div>
    </div>
  )
}
