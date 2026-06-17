import { memo, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../shared/types'
import type { ToolState } from '../App'
import hljs from '../highlight'
import { renderMarkdown } from '../markdown'

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
  onEdit,
  onAutomate,
  cwd,
  live
}: {
  message: ChatMessage
  toolState: Record<string, ToolState>
  onApprove: (callId: string, approved: boolean, remember?: boolean) => void
  onEdit?: (messageId: string, content: string) => void
  onAutomate?: (content: string) => void
  cwd?: string
  // is a turn for THIS session currently in flight? A tool call with no result is only "running"
  // while live — after a turn ends/an interrupted turn reloads, it's shown as "abgebrochen".
  live?: boolean
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
          {onAutomate && (
            <span
              className="copy-btn"
              title="Diesen Prompt als Automation (Routine) speichern"
              onClick={() => onAutomate(visible)}
            >
              ⏰
            </span>
          )}
        </div>
        {m && <div className="attach-note">📎 Anhänge im Kontext</div>}
        {message.images?.length ? (
          <div className="msg-images">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt={`Anhang ${i + 1}`} />
            ))}
          </div>
        ) : null}
        <div className="bubble">{visible || (message.images?.length ? '👁 Bild analysieren' : '(nur Anhänge)')}</div>
      </div>
    )
  }
  if (message.role !== 'assistant') return null

  return (
    <div className={'msg assistant' + (message.variant ? ' second-opinion' : '')}>
      <div className="role">
        {message.variant === 'second-opinion' ? (
          <>
            🧠 Zweitmeinung <span className="badge">{message.variantModel}</span>
          </>
        ) : message.variant === 'arena' ? (
          <>
            🥊 Arena <span className="badge">{message.variantModel}</span>
          </>
        ) : (
          'DeepCode'
        )}
        {message.content && <CopyButton text={message.content} label="Antwort kopieren" />}
      </div>
      {message.reasoning && <Reasoning text={message.reasoning} />}
      {message.content && (
        <div
          className="bubble"
          ref={bubbleRef}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
      )}
      {message.toolCalls?.map((tc) => (
        <ToolBlock
          key={tc.id}
          name={tc.name}
          args={tc.arguments}
          state={toolState[tc.id]}
          cwd={cwd}
          live={live}
          onApprove={(ok, remember) => onApprove(tc.id, ok, remember)}
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
  if (prev.onApprove !== next.onApprove || prev.onEdit !== next.onEdit || prev.onAutomate !== next.onAutomate || prev.cwd !== next.cwd)
    return false
  if (prev.live !== next.live) return false // busy→idle must flip a resultless tool from running→abgebrochen
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

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      className="copy-btn"
      title={label}
      aria-label={label}
      onClick={() => {
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  )
}

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

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch'])

function ToolBlock({
  name,
  args,
  state,
  cwd,
  live,
  onApprove
}: {
  name: string
  args: string
  state?: ToolState
  cwd?: string
  live?: boolean
  onApprove: (ok: boolean, remember?: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pendingDiff, setPendingDiff] = useState<string | null>(null)
  // pre-approval diff: show exactly what this call would change
  useEffect(() => {
    if (state?.pending && cwd && FILE_TOOLS.has(name)) {
      window.deepcode.previewDiff(name, args, cwd).then((d) => setPendingDiff(d || null))
    }
  }, [state?.pending, name, args, cwd])
  const result = state?.result
  const pending = state?.pending
  const summary = summarizeArgs(name, args)
  const diff = (result?.meta?.diff as string | undefined) || undefined
  // No result + not pending: only "running" while a turn is actually in flight (live). Otherwise
  // this is a tool call from an interrupted/reloaded turn (toolState is in-memory, empty after a
  // restart) — show "abgebrochen" instead of a forever-spinning "running".
  const statusLabel = pending
    ? '● awaiting approval'
    : result
      ? result.ok
        ? '● done'
        : '● failed'
      : live
        ? '● running'
        : '● abgebrochen'
  const statusClass = pending ? 'run' : result ? (result.ok ? 'ok' : 'err') : live ? 'run' : 'err'

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
            {pendingDiff ? (
              <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 8 }}>
                <DiffView diff={pendingDiff} />
              </div>
            ) : (
              <Preview name={name} args={args} />
            )}
          </div>
          <div className="approve-actions">
            <button className="btn sm" onClick={() => onApprove(true)}>
              Allow <kbd>Y</kbd>
            </button>
            <button className="btn ghost sm" onClick={() => onApprove(false)}>
              Deny <kbd>N</kbd>
            </button>
            {name === 'run_command' && (
              <button
                className="btn ghost sm"
                onClick={() => onApprove(true, true)}
                title="Diesen exakten Befehl künftig automatisch erlauben (in Settings verwaltbar)"
              >
                Immer erlauben
              </button>
            )}
            <span className="approve-hint">
              <kbd>A</kbd> erlaubt alle offenen
            </span>
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
