import type { AppSettings, ProjectDef, Session } from '../../../shared/types'
import type { View } from '../App'
import { basename, relTime } from './ChatExtras'

// Primary destinations stay visible; management panels collapse under
// "Erweitert" so the chat list keeps breathing room.
export const NAV_MAIN: { view: View; icon: string; label: string }[] = [
  { view: 'chat', icon: '💬', label: 'Chat' },
  { view: 'projects', icon: '📂', label: 'Projekte' },
  { view: 'usage', icon: '💰', label: 'Kosten' },
  { view: 'night', icon: '🌙', label: 'Nachtschicht' },
  { view: 'settings', icon: '⚙️', label: 'Settings' }
]
export const NAV_MORE: { view: View; icon: string; label: string }[] = [
  { view: 'missions', icon: '🎯', label: 'Missionen' },
  { view: 'market', icon: '🛒', label: 'Marketplace' },
  { view: 'skills', icon: '📘', label: 'Skills' },
  { view: 'commands', icon: '/', label: 'Slash Commands' },
  { view: 'subagents', icon: '🤖', label: 'Subagents' },
  { view: 'mcp', icon: '🔌', label: 'MCP / Connectors' },
  { view: 'hooks', icon: '🪝', label: 'Hooks' },
  { view: 'memory', icon: '🧠', label: 'Memory' },
  { view: 'automations', icon: '⏰', label: 'Automations' },
  { view: 'workflows', icon: '🕸️', label: 'Workflows' },
  { view: 'plugins', icon: '🧩', label: 'Plugins' },
  { view: 'audit', icon: '🧾', label: 'Audit-Log' },
  { view: 'traces', icon: '🔬', label: 'Traces' },
  { view: 'swarm', icon: '🐝', label: 'Schwarm' },
  { view: 'timemachine', icon: '⏳', label: 'Zeitmaschine' }
]
export const NAV = [...NAV_MAIN, ...NAV_MORE]

export interface SidebarProps {
  settings: AppSettings
  view: View
  onView: (v: View) => void
  moreOpen: boolean
  onToggleMore: () => void
  onToggleTheme: () => void
  projects: ProjectDef[]
  activeProject: ProjectDef | null
  activeProjectId: string | null
  onSelectProject: (id: string | null) => void
  sessions: Session[]
  activeSessionId: string | null
  onOpenSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onNewSession: () => void
  sessionFilter: string
  onFilter: (q: string) => void
  contentHits: { sessionId: string; title: string; snippet: string }[]
  renamingId: string | null
  renameText: string
  onRenameText: (t: string) => void
  onStartRename: (id: string, title: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
}

export function Sidebar(p: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="dot" />
        DeepCode <small>· DeepSeek</small>
        <span className="spacer" />
        <span
          className="theme-toggle"
          onClick={p.onToggleTheme}
          title={p.settings.theme === 'light' ? 'Dark Mode' : 'Light Mode'}
        >
          {p.settings.theme === 'light' ? '🌙' : '☀️'}
        </span>
      </div>
      <div className="nav">
        {NAV_MAIN.map((n) => (
          <button key={n.view} className={p.view === n.view ? 'active' : ''} onClick={() => p.onView(n.view)}>
            <span className="ic">{n.icon}</span>
            {n.label}
          </button>
        ))}
        <button
          className={'nav-more' + (NAV_MORE.some((n) => n.view === p.view) ? ' active' : '')}
          onClick={p.onToggleMore}
        >
          <span className="ic">{p.moreOpen ? '▾' : '▸'}</span>
          Erweitert
        </button>
        {(p.moreOpen || NAV_MORE.some((n) => n.view === p.view)) &&
          NAV_MORE.map((n) => (
            <button
              key={n.view}
              className={'nav-sub' + (p.view === n.view ? ' active' : '')}
              onClick={() => p.onView(n.view)}
            >
              <span className="ic">{n.icon}</span>
              {n.label}
            </button>
          ))}
      </div>
      <div className="nav-sep" />
      <div className="nav">
        <button onClick={p.onNewSession} title="Strg+N">
          <span className="ic">＋</span> Neuer Chat {p.activeProject ? `in ${p.activeProject.name}` : ''}
        </button>
      </div>
      <div className="sessions">
        {p.projects.length > 0 && (
          <>
            <h4>Projekte</h4>
            <div
              className={'session-item' + (p.activeProjectId === null ? ' active' : '')}
              role="button"
              tabIndex={0}
              onClick={() => p.onSelectProject(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  p.onSelectProject(null)
                }
              }}
            >
              <span>Alle Chats</span>
            </div>
            {p.projects.map((proj) => (
              <div
                key={proj.id}
                className={'session-item' + (p.activeProjectId === proj.id ? ' active' : '')}
                role="button"
                tabIndex={0}
                onClick={() => p.onSelectProject(proj.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    p.onSelectProject(proj.id)
                  }
                }}
                title={proj.cwd}
              >
                <span>
                  <span className="proj-dot" style={{ background: proj.color || 'var(--accent)' }} />
                  {proj.name}
                </span>
              </div>
            ))}
          </>
        )}
        <h4>Chats</h4>
        <input
          className="session-search"
          placeholder="Suchen (auch im Verlauf)…"
          value={p.sessionFilter}
          onChange={(e) => p.onFilter(e.target.value)}
        />
        {p.contentHits.length > 0 && (
          <>
            <h4>Treffer im Verlauf</h4>
            {p.contentHits.map((h) => (
              <div
                key={h.sessionId}
                className="session-item"
                role="button"
                tabIndex={0}
                onClick={() => p.onOpenSession(h.sessionId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    p.onOpenSession(h.sessionId)
                  }
                }}
              >
                <div style={{ minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.title}</div>
                  <div className="session-meta">{h.snippet.slice(0, 60)}</div>
                </div>
              </div>
            ))}
          </>
        )}
        {p.sessions
          // hide the workflow editor's chat-dock sessions (titled "🔧 Workflow-Assistent: …" by
          // WorkflowChat) — they're an editor-internal assistant, not user chats.
          .filter((s) => !(s.title || '').startsWith('🔧 Workflow-Assistent:'))
          .filter((s) => !p.activeProjectId || s.projectId === p.activeProjectId)
          .filter(
            (s) =>
              !p.sessionFilter ||
              (s.title || '').toLowerCase().includes(p.sessionFilter.toLowerCase()) ||
              s.cwd.toLowerCase().includes(p.sessionFilter.toLowerCase())
          )
          .map((s) => (
            <div
              key={s.id}
              className={'session-item' + (p.activeSessionId === s.id ? ' active' : '')}
              role="button"
              tabIndex={p.renamingId === s.id ? -1 : 0}
              onClick={() => p.onOpenSession(s.id)}
              onDoubleClick={() => p.onStartRename(s.id, s.title || '')}
              onKeyDown={(e) => {
                if (p.renamingId === s.id) return // the rename input handles its own keys
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  p.onOpenSession(s.id)
                } else if (e.key === 'F2') {
                  e.preventDefault()
                  p.onStartRename(s.id, s.title || '')
                } else if (e.key === 'Delete') {
                  e.preventDefault()
                  p.onDeleteSession(s.id)
                }
              }}
              title={s.cwd + ' (Doppelklick / F2: umbenennen)'}
            >
              {p.renamingId === s.id ? (
                <input
                  className="rename-input"
                  value={p.renameText}
                  autoFocus
                  onChange={(e) => p.onRenameText(e.target.value)}
                  onBlur={p.onCommitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') p.onCommitRename()
                    if (e.key === 'Escape') p.onCancelRename()
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div style={{ minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title || 'Untitled'}</div>
                  <div className="session-meta">
                    {basename(s.cwd)} · {relTime(s.updatedAt)}
                  </div>
                </div>
              )}
              <button
                type="button"
                className="x"
                aria-label={`Chat „${s.title || 'Untitled'}" löschen`}
                onClick={(ev) => {
                  ev.stopPropagation()
                  p.onDeleteSession(s.id)
                }}
                onKeyDown={(ev) => ev.stopPropagation()}
              >
                ✕
              </button>
            </div>
          ))}
      </div>
    </aside>
  )
}
