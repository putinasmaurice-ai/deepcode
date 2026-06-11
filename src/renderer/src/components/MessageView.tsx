import { useState } from 'react'
import type { ChatMessage } from '../../../shared/types'
import type { ToolState } from '../App'

export function MessageView({
  message,
  toolState,
  onApprove
}: {
  message: ChatMessage
  toolState: Record<string, ToolState>
  onApprove: (callId: string, approved: boolean) => void
}): JSX.Element | null {
  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="role">You</div>
        <div className="bubble">{message.content}</div>
      </div>
    )
  }
  if (message.role !== 'assistant') return null

  return (
    <div className="msg assistant">
      <div className="role">DeepCode</div>
      {message.reasoning && <Reasoning text={message.reasoning} />}
      {message.content && <div className="bubble" dangerouslySetInnerHTML={{ __html: renderMd(message.content) }} />}
      {message.toolCalls?.map((tc) => (
        <ToolBlock
          key={tc.id}
          name={tc.name}
          args={tc.arguments}
          state={toolState[tc.id]}
          onApprove={(ok) => onApprove(tc.id, ok)}
        />
      ))}
    </div>
  )
}

function Reasoning({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="reasoning">
      <span className="tag" onClick={() => setOpen((o) => !o)}>
        {open ? '▾ reasoning' : '▸ reasoning'}
      </span>
      {open && <div style={{ marginTop: 6 }}>{text}</div>}
    </div>
  )
}

function ToolBlock({
  name,
  args,
  state,
  onApprove
}: {
  name: string
  args: string
  state?: ToolState
  onApprove: (ok: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const result = state?.result
  const pending = state?.pending
  const summary = summarizeArgs(name, args)
  const statusLabel = pending
    ? '● awaiting approval'
    : result
      ? result.ok
        ? '● done'
        : '● failed'
      : '● running'
  const statusClass = pending ? 'run' : result ? (result.ok ? 'ok' : 'err') : 'run'

  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tname">{name}</span>
        <span className="tsum">{summary}</span>
        <span className={'status ' + statusClass}>{statusLabel}</span>
      </div>
      {pending && (
        <div className="approve">
          <span className="q">Allow DeepCode to run this {permissionWord(name)}?</span>
          <button className="btn sm" onClick={() => onApprove(true)}>
            Allow
          </button>
          <button className="btn ghost sm" onClick={() => onApprove(false)}>
            Deny
          </button>
        </div>
      )}
      {open && (
        <div className="tool-body">
          <div style={{ color: 'var(--text-faint)', marginBottom: 8 }}>args: {args}</div>
          {result ? result.content : pending ? '(waiting for approval)' : '(running…)'}
        </div>
      )}
    </div>
  )
}

function permissionWord(name: string): string {
  if (name === 'run_command') return 'shell command'
  if (name === 'write_file' || name === 'edit_file') return 'file change'
  if (name.startsWith('mcp__')) return 'connector action'
  return 'action'
}

function summarizeArgs(name: string, raw: string): string {
  try {
    const a = JSON.parse(raw)
    if (name === 'run_command') return '$ ' + String(a.command ?? '').split('\n')[0].slice(0, 90)
    if (a.path) return a.path
    if (a.pattern) return a.pattern
    if (a.prompt) return String(a.prompt).slice(0, 90)
    if (a.name) return a.name
    return Object.keys(a).length ? JSON.stringify(a).slice(0, 90) : ''
  } catch {
    return raw.slice(0, 90)
  }
}

// Minimal, safe markdown: escape HTML, then apply code spans, bold, and code fences.
function renderMd(text: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const parts: string[] = []
  const segments = text.split(/```/)
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 1) {
      const body = segments[i].replace(/^[a-zA-Z0-9]*\n/, '')
      parts.push(
        `<pre style="background:var(--bg-3);border:1px solid var(--border);border-radius:8px;padding:11px;overflow:auto;font-family:var(--mono);font-size:12.5px;margin:8px 0"><code>${esc(body)}</code></pre>`
      )
    } else {
      let s = esc(segments[i])
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
      s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      parts.push(s)
    }
  }
  return parts.join('')
}
