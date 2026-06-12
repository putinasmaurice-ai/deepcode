import { useEffect, useRef, useState } from 'react'
import type { SlashCommandDef } from '../../../shared/types'

const api = window.deepcode

const BUILTIN: SlashCommandDef[] = [
  { name: 'help', description: 'Show what DeepCode can do', path: '', template: '', source: 'user' },
  { name: 'init', description: 'Analyze this project and write a DEEPCODE.md', path: '', template: '', source: 'user' }
]

export function Composer({
  busy,
  onSend,
  onStop,
  cwd,
  prefill,
  onPrefillConsumed
}: {
  busy: boolean
  onSend: (text: string, attachments?: string[]) => void
  onStop: () => void
  cwd?: string
  prefill?: string | null
  onPrefillConsumed?: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [commands, setCommands] = useState<SlashCommandDef[]>([])
  const [sel, setSel] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  // focus the input on mount and whenever the session/cwd changes
  useEffect(() => {
    ref.current?.focus()
  }, [cwd])

  // edit-and-resend: take over prefilled text from a user message
  useEffect(() => {
    if (prefill != null) {
      setText(prefill)
      onPrefillConsumed?.()
      ref.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill])

  // file list for @-mentions (lazy, refreshed per cwd)
  useEffect(() => {
    if (cwd) api.listFiles(cwd).then((f: string[]) => setFiles(f ?? []))
  }, [cwd])

  async function addFiles(): Promise<void> {
    const files = (await api.pickFiles()) as string[]
    if (files?.length) setAttachments((a) => Array.from(new Set([...a, ...files])))
  }
  async function addFolder(): Promise<void> {
    const dir = (await api.pickDirectory()) as string | null
    if (dir) setAttachments((a) => Array.from(new Set([...a, dir])))
  }
  function removeAttachment(p: string): void {
    setAttachments((a) => a.filter((x) => x !== p))
  }
  function baseName(p: string): string {
    return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p
  }

  useEffect(() => {
    api.listCommands(cwd).then((c: SlashCommandDef[]) => setCommands([...BUILTIN, ...c]))
  }, [cwd])

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 220) + 'px'
    }
  }, [text])

  const [dismissed, setDismissed] = useState(false)
  const showSlash = text.startsWith('/') && !text.includes('\n') && !dismissed
  const query = showSlash ? text.slice(1).split(' ')[0].toLowerCase() : ''
  const matches = showSlash
    ? commands.filter((c) => c.name.toLowerCase().startsWith(query))
    : []

  // @-file mention: active while the text ends in @<partial-path>
  const atMatch = !showSlash && !dismissed ? text.match(/@([\w./\\-]*)$/) : null
  const atQuery = atMatch ? atMatch[1].toLowerCase() : null
  const fileMatches =
    atQuery !== null
      ? files.filter((f) => f.toLowerCase().includes(atQuery)).slice(0, 12)
      : []

  function pickFileMention(rel: string): void {
    setText((t) => t.replace(/@([\w./\\-]*)$/, `@${rel} `))
    if (cwd) {
      const abs = cwd.replace(/[/\\]+$/, '') + '\\' + rel.replace(/\//g, '\\')
      setAttachments((a) => Array.from(new Set([...a, abs])))
    }
    ref.current?.focus()
  }

  // keep the highlight in range as the match list shrinks
  useEffect(() => {
    setSel(0)
  }, [query, atQuery])

  function submit(): void {
    const t = text.trim()
    if ((!t && attachments.length === 0) || busy) return
    onSend(t, attachments.length ? attachments : undefined)
    setText('')
    setAttachments([])
  }

  function pickCommand(c: SlashCommandDef): void {
    setText('/' + c.name + ' ')
    ref.current?.focus()
  }

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'Escape' && (showSlash || fileMatches.length)) {
      e.preventDefault()
      setDismissed(true)
      return
    }
    if (fileMatches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % fileMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + fileMatches.length) % fileMatches.length)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        pickFileMention(fileMatches[Math.min(sel, fileMatches.length - 1)])
        return
      }
    }
    if (matches.length && showSlash) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && text.trim() === '/' + query)) {
        e.preventDefault()
        pickCommand(matches[Math.min(sel, matches.length - 1)])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files)
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p)
    if (dropped.length) setAttachments((a) => Array.from(new Set([...a, ...dropped])))
  }

  return (
    <div
      className={'composer' + (dragOver ? ' drag-over' : '')}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="composer-inner">
        {fileMatches.length > 0 && (
          <div className="slash-menu">
            {fileMatches.map((f, i) => (
              <div
                key={f}
                className={'slash-item' + (i === sel ? ' sel' : '')}
                onClick={() => pickFileMention(f)}
                onMouseEnter={() => setSel(i)}
              >
                <span className="cmd">📄 {f}</span>
              </div>
            ))}
          </div>
        )}
        {showSlash && matches.length > 0 && (
          <div className="slash-menu">
            {matches.map((c, i) => (
              <div
                key={c.name}
                className={'slash-item' + (i === sel ? ' sel' : '')}
                onClick={() => pickCommand(c)}
                onMouseEnter={() => setSel(i)}
              >
                <span className="cmd">/{c.name}</span>
                <span className="desc">{c.description}</span>
                {c.source !== 'user' && <span className={'badge ' + c.source}>{c.source}</span>}
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((p) => (
              <span className="chip" key={p} title={p}>
                {p.match(/\.[a-z0-9]+$/i) ? '📄' : '📁'} {baseName(p)}
                <span className="chip-x" onClick={() => removeAttachment(p)}>
                  ✕
                </span>
              </span>
            ))}
          </div>
        )}
        <div className="attach-bar">
          <button className="attach-btn" onClick={addFiles} title="Dateien anhängen">
            📎 Datei
          </button>
          <button className="attach-btn" onClick={addFolder} title="Ordner anhängen">
            📁 Ordner
          </button>
        </div>
        <textarea
          ref={ref}
          value={text}
          placeholder="Ask DeepCode to build, fix, explain, or refactor…  (/ for commands, Enter to send, Shift+Enter for newline)"
          onChange={(e) => {
            setText(e.target.value)
            setDismissed(false)
          }}
          onKeyDown={onKey}
          rows={1}
        />
        {busy ? (
          <button className="stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!text.trim() && attachments.length === 0}>
            Send
          </button>
        )}
      </div>
      <div className="hint">
        <span>Enter to send · Shift+Enter newline</span>
        <span>/ for slash commands</span>
      </div>
    </div>
  )
}
