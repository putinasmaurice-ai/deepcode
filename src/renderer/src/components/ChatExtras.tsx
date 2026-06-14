import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { AppSettings, ChatMessage, TodoItem } from '../../../shared/types'
import type { View } from '../App'

const api = window.deepcode

export function basename(p: string): string {
  if (!p) return '~'
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

export function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Context-window usage (~4 chars/token), warns as the conversation grows.
export function ContextPill({
  messages,
  maxTokens
}: {
  messages: ChatMessage[]
  maxTokens: number
}): JSX.Element | null {
  // Memoize on a cheap signature so streaming deltas (App re-renders per frame)
  // don't re-sum every message on each render.
  const last = messages[messages.length - 1]
  const sig = `${messages.length}:${last?.id ?? ''}:${last?.content?.length ?? 0}`
  const tokens = useMemo(() => {
    let chars = 0
    for (const m of messages) chars += (m.content?.length ?? 0) + (m.reasoning?.length ?? 0)
    return Math.ceil(chars / 4)
  }, [sig])
  const pct = Math.min(100, Math.round((tokens / maxTokens) * 100))
  if (pct < 5) return null
  const color = pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--text-dim)'
  return (
    <span
      className="pill"
      style={{ color }}
      title={`~${tokens.toLocaleString()} Tokens Kontext (von ~${maxTokens.toLocaleString()}). Bei >80% lohnt sich Compact.`}
    >
      ⛁ {pct}%
    </span>
  )
}

// Live "working" indicator with an elapsed-seconds counter — reassures the
// user the agent is running, which matters a lot for slow local models.
export function WorkingIndicator({ status }: { status: string }): JSX.Element {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 500)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="working">
      <span className="working-dots">
        <i></i>
        <i></i>
        <i></i>
      </span>
      <span className="working-text">{status || 'DeepCode arbeitet'}</span>
      <span className="working-secs">{secs}s</span>
    </div>
  )
}

export function TodoStrip({ todos, onClear }: { todos: TodoItem[]; onClear: () => void }): JSX.Element {
  const done = todos.filter((t) => t.status === 'done').length
  return (
    <div className="todo-strip">
      <div className="todo-head">
        <span>
          📋 Aufgaben <b>{done}/{todos.length}</b>
        </span>
        <span
          className="todo-clear"
          role="button"
          tabIndex={0}
          onClick={onClear}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClear()}
        >
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

export function Welcome({
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
    api.listSkills().then((s) => setSkillCount(s?.length ?? 0))
    const checkMcp = (): void => {
      api.listMcp().then((m) => setMcpConnected(m?.filter((x) => x.status === 'connected').length ?? 0))
    }
    checkMcp()
    // auto-connect runs async after app start — re-check until it settled
    const t1 = setTimeout(checkMcp, 3000)
    const t2 = setTimeout(checkMcp, 8000)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])

  const keyOk = !!settings.provider.apiKey
  // Run a click action on Enter/Space so div/span controls are keyboard-usable.
  const onKey = (fn: () => void) => (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  }
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
        <div
          className={'check ' + (keyOk ? 'ok' : 'todo')}
          role="button"
          tabIndex={0}
          onClick={() => !keyOk && onNavigate('settings')}
          onKeyDown={onKey(() => !keyOk && onNavigate('settings'))}
        >
          {keyOk ? '✓ API-Key eingerichtet' : '○ API-Key fehlt — hier einrichten'}
        </div>
        <div
          className={'check ' + (projectCount > 0 ? 'ok' : 'todo')}
          role="button"
          tabIndex={0}
          onClick={() => projectCount === 0 && onNavigate('projects')}
          onKeyDown={onKey(() => projectCount === 0 && onNavigate('projects'))}
        >
          {projectCount > 0 ? `✓ ${projectCount} Projekt(e)` : '○ Erstes Projekt anlegen'}
        </div>
        <div className="check ok">{skillCount === null ? '… Skills' : `✓ ${skillCount} Skills geladen`}</div>
        <div
          className={'check ' + ((mcpConnected ?? 0) > 0 ? 'ok' : 'dim')}
          role="button"
          tabIndex={0}
          onClick={() => onNavigate('mcp')}
          onKeyDown={onKey(() => onNavigate('mcp'))}
        >
          {mcpConnected === null
            ? '… MCP'
            : mcpConnected > 0
              ? `✓ ${mcpConnected} MCP verbunden`
              : '○ MCP-Connectors (optional)'}
        </div>
      </div>
      <div className="examples">
        {examples.map((e) => (
          <div
            className="ex"
            key={e}
            role="button"
            tabIndex={0}
            onClick={() => onPick(e)}
            onKeyDown={onKey(() => onPick(e))}
          >
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
