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
  cwd
}: {
  busy: boolean
  onSend: (text: string) => void
  onStop: () => void
  cwd?: string
}): JSX.Element {
  const [text, setText] = useState('')
  const [commands, setCommands] = useState<SlashCommandDef[]>([])
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

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

  // keep the highlight in range as the match list shrinks
  useEffect(() => {
    setSel(0)
  }, [query])

  function submit(): void {
    const t = text.trim()
    if (!t || busy) return
    onSend(t)
    setText('')
  }

  function pickCommand(c: SlashCommandDef): void {
    setText('/' + c.name + ' ')
    ref.current?.focus()
  }

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'Escape' && showSlash) {
      e.preventDefault()
      setDismissed(true)
      return
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

  return (
    <div className="composer">
      <div className="composer-inner">
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
        <textarea
          ref={ref}
          value={text}
          placeholder="Ask DeepCode to build, fix, explain, or refactor…  (/ for commands, Enter to send, Shift+Enter for newline)"
          onChange={(e) => {
            const v = e.target.value
            setText(v)
            if (!v.startsWith('/')) setDismissed(false)
          }}
          onKeyDown={onKey}
          rows={1}
        />
        {busy ? (
          <button className="stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!text.trim()}>
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
