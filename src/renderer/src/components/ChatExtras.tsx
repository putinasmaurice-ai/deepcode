import { useEffect, useState } from 'react'
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
  let chars = 0
  for (const m of messages) chars += (m.content?.length ?? 0) + (m.reasoning?.length ?? 0)
  const tokens = Math.ceil(chars / 4)
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

export function TodoStrip({ todos, onClear }: { todos: TodoItem[]; onClear: () => void }): JSX.Element {
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
          {mcpConnected === null
            ? '… MCP'
            : mcpConnected > 0
              ? `✓ ${mcpConnected} MCP verbunden`
              : '○ MCP-Connectors (optional)'}
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
