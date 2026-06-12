import { memo, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../shared/types'
import type { ToolState } from '../App'
import hljs from '../highlight'

// Highlight code blocks + inject per-block copy buttons after the streamed
// content settles (debounced — re-highlighting on every delta would be wasteful).
function useCodeEnhancer(ref: React.RefObject<HTMLDivElement>, content: string): void {
  useEffect(() => {
    const timer = setTimeout(() => {
      const root = ref.current
      if (!root) return
      root.querySelectorAll<HTMLElement>('pre code').forEach((el) => {
        if (el.dataset.hl) return
        try {
          hljs.highlightElement(el)
        } catch {
          /* unknown language — leave plain */
        }
        el.dataset.hl = '1'
        const pre = el.parentElement
        if (pre && !pre.querySelector('.code-copy')) {
          const btn = document.createElement('button')
          btn.className = 'code-copy'
          btn.textContent = '⧉'
          btn.title = 'Code kopieren'
          btn.onclick = () => {
            navigator.clipboard.writeText(el.textContent ?? '')
            btn.textContent = '✓'
            setTimeout(() => (btn.textContent = '⧉'), 1200)
          }
          pre.appendChild(btn)
        }
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [ref, content])
}

function MessageViewImpl({
  message,
  toolState,
  onApprove,
  onEdit
}: {
  message: ChatMessage
  toolState: Record<string, ToolState>
  onApprove: (callId: string, approved: boolean) => void
  onEdit?: (messageId: string, content: string) => void
}): JSX.Element | null {
  const bubbleRef = useRef<HTMLDivElement>(null)
  useCodeEnhancer(bubbleRef, message.content)

  if (message.role === 'user') {
    // Collapse the verbose <attached-context> block (from attached files/folders).
    const m = message.content.match(/^<attached-context>[\s\S]*?<\/attached-context>\s*([\s\S]*)$/)
    const visible = m ? m[1] : message.content
    return (
      <div className="msg user">
        <div className="role">
          You
          {onEdit && !message.id.startsWith('local-') && (
            <span
              className="copy-btn"
              title="Bearbeiten & neu senden (Verlauf ab hier wird ersetzt)"
              onClick={() => onEdit(message.id, visible)}
            >
              ✏️
            </span>
          )}
        </div>
        {m && <div className="attach-note">📎 Anhänge im Kontext</div>}
        <div className="bubble">{visible || '(nur Anhänge)'}</div>
      </div>
    )
  }
  if (message.role !== 'assistant') return null

  return (
    <div className="msg assistant">
      <div className="role">
        DeepCode
        {message.content && (
          <span
            className="copy-btn"
            title="Antwort kopieren"
            onClick={() => navigator.clipboard.writeText(message.content)}
          >
            ⧉
          </span>
        )}
      </div>
      {message.reasoning && <Reasoning text={message.reasoning} />}
      {message.content && (
        <div
          className="bubble"
          ref={bubbleRef}
          dangerouslySetInnerHTML={{ __html: renderMd(message.content) }}
        />
      )}
      {message.toolCalls?.map((tc) => (
        <ToolBlock
          key={tc.id}
          name={tc.name}
          args={tc.arguments}
          state={toolState[tc.id]}
          onApprove={(ok) => onApprove(tc.id, ok)}
        />
      ))}
      {message.finishReason === 'length' && (
        <div className="trunc">⚠ Output was cut off at the max-tokens limit. Increase “Max tokens” in Settings.</div>
      )}
      {message.usage && (
        <div className="usage">
          {message.usage.totalTokens.toLocaleString()} tokens
          {message.usage.cost > 0 ? ` · $${message.usage.cost.toFixed(4)}` : ''}
          {` · ${message.usage.promptTokens.toLocaleString()} in / ${message.usage.completionTokens.toLocaleString()} out`}
        </div>
      )}
    </div>
  )
}

// Re-render only when this message or one of its own tool results changes.
export const MessageView = memo(MessageViewImpl, (prev, next) => {
  if (prev.onApprove !== next.onApprove || prev.onEdit !== next.onEdit) return false
  const a = prev.message
  const b = next.message
  if (
    a.id !== b.id ||
    a.content !== b.content ||
    a.reasoning !== b.reasoning ||
    a.finishReason !== b.finishReason ||
    a.usage?.totalTokens !== b.usage?.totalTokens ||
    a.usage?.cost !== b.usage?.cost ||
    a.usage?.promptTokens !== b.usage?.promptTokens ||
    a.usage?.completionTokens !== b.usage?.completionTokens ||
    (a.toolCalls?.length ?? 0) !== (b.toolCalls?.length ?? 0)
  )
    return false
  for (const tc of a.toolCalls ?? []) {
    if (prev.toolState[tc.id] !== next.toolState[tc.id]) return false
  }
  return true
})

function Reasoning({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="reasoning">
      <span className="tag" onClick={() => setOpen((o) => !o)}>
        {open ? '▾ reasoning' : `▸ reasoning (${text.length.toLocaleString()} chars)`}
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
  const diff = (result?.meta?.diff as string | undefined) || undefined
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
          <div className="approve-body">
            <div className="q">Allow DeepCode to run this {permissionWord(name)}?</div>
            <Preview name={name} args={args} />
          </div>
          <div className="approve-actions">
            <button className="btn sm" onClick={() => onApprove(true)}>
              Allow
            </button>
            <button className="btn ghost sm" onClick={() => onApprove(false)}>
              Deny
            </button>
          </div>
        </div>
      )}
      {diff && !pending && <DiffView diff={diff} />}
      {open && (
        <div className="tool-body">
          <div style={{ color: 'var(--text-faint)', marginBottom: 8 }}>args: {args}</div>
          {result ? result.content : pending ? '(waiting for approval)' : '(running…)'}
        </div>
      )}
    </div>
  )
}

function DiffView({ diff }: { diff: string }): JSX.Element {
  return (
    <div className="diff">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
        return (
          <div key={i} className={'diff-line ' + cls}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

function Preview({ name, args }: { name: string; args: string }): JSX.Element | null {
  let a: any = {}
  try {
    a = JSON.parse(args)
  } catch {
    return null
  }
  if (name === 'run_command') {
    return <pre className="preview cmd">$ {a.command}</pre>
  }
  if (name === 'write_file') {
    const head = String(a.content ?? '').split('\n').slice(0, 12).join('\n')
    return (
      <pre className="preview">
        {a.path}
        {'\n'}
        {head}
        {String(a.content ?? '').split('\n').length > 12 ? '\n…' : ''}
      </pre>
    )
  }
  if (name === 'edit_file') {
    return (
      <pre className="preview">
        {a.path}
        {'\n'}- {String(a.old_string ?? '').slice(0, 200)}
        {'\n'}+ {String(a.new_string ?? '').slice(0, 200)}
      </pre>
    )
  }
  if (name === 'apply_patch') {
    return <pre className="preview">{(a.ops ?? []).map((o: any) => `${o.type} ${o.path}`).join('\n')}</pre>
  }
  return null
}

function permissionWord(name: string): string {
  if (name === 'run_command') return 'shell command'
  if (name === 'write_file' || name === 'edit_file' || name === 'apply_patch') return 'file change'
  if (name.startsWith('mcp__')) return 'connector action'
  return 'action'
}

function summarizeArgs(name: string, raw: string): string {
  try {
    const a = JSON.parse(raw)
    if (name === 'run_command') return '$ ' + String(a.command ?? '').split('\n')[0].slice(0, 90)
    if (name === 'apply_patch') return `${(a.ops ?? []).length} file ops`
    if (a.path) return a.path
    if (a.pattern) return a.pattern
    if (a.prompt) return String(a.prompt).slice(0, 90)
    if (a.name) return a.name
    return Object.keys(a).length ? JSON.stringify(a).slice(0, 90) : ''
  } catch {
    return raw.slice(0, 90)
  }
}

// Minimal, safe markdown: escape HTML first, then headings, lists, code fences,
// inline code and bold. dangerouslySetInnerHTML is safe because all text is escaped.
function renderMd(text: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      // [text](https://url) → external link (window-open handler routes to the browser)
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>'
      )

  const out: string[] = []
  const segments = text.split(/```/)
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 1) {
      const langMatch = segments[i].match(/^([a-zA-Z0-9+-]*)\n/)
      const lang = langMatch?.[1] ?? ''
      const body = segments[i].replace(/^[a-zA-Z0-9+-]*\n/, '')
      out.push(
        `<pre class="codeblock">${lang ? `<span class="code-lang">${esc(lang)}</span>` : ''}<code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(body)}</code></pre>`
      )
      continue
    }
    const lines = segments[i].split('\n')
    let inList = false
    let tableBuf: string[] = []
    const flushTable = (): void => {
      if (!tableBuf.length) return
      const rows = tableBuf.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)) // drop separator row
      const html = rows
        .map((r, ri) => {
          const cells = r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
          const tag = ri === 0 ? 'th' : 'td'
          return `<tr>${cells.map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('')}</tr>`
        })
        .join('')
      out.push(`<table class="md-table">${html}</table>`)
      tableBuf = []
    }
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '')
      // markdown table rows: |…|…|
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (inList) {
          out.push('</ul>')
          inList = false
        }
        tableBuf.push(line)
        continue
      }
      flushTable()
      const h = line.match(/^(#{1,4})\s+(.*)$/)
      const li = line.match(/^\s*[-*]\s+(.*)$/)
      if (h) {
        if (inList) {
          out.push('</ul>')
          inList = false
        }
        const lvl = h[1].length + 2
        out.push(`<div class="md-h" style="font-size:${17 - lvl}px">${inline(h[2])}</div>`)
      } else if (li) {
        if (!inList) {
          out.push('<ul class="md-ul">')
          inList = true
        }
        out.push(`<li>${inline(li[1])}</li>`)
      } else {
        if (inList) {
          out.push('</ul>')
          inList = false
        }
        out.push(line ? `<div>${inline(line)}</div>` : '<div class="md-sp"></div>')
      }
    }
    flushTable()
    if (inList) out.push('</ul>')
  }
  return out.join('')
}
