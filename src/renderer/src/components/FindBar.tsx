import { useEffect, useRef, useState } from 'react'

const api = window.deepcode

// In-chat find bar (Ctrl+F). Drives Electron's native findInPage, which
// highlights every match in the window and reports the active match + total.
export function FindBar({ onClose }: { onClose: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<{ matches: number; activeMatchOrdinal: number }>({
    matches: 0,
    activeMatchOrdinal: 0
  })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    const off = api.onFindResult((r) => setRes(r))
    return () => {
      off()
      api.stopFindInPage()
    }
  }, [])

  useEffect(() => {
    if (!q) {
      api.stopFindInPage()
      setRes({ matches: 0, activeMatchOrdinal: 0 })
      return
    }
    api.findInPage(q, true, false) // new search starts from the top
  }, [q])

  function step(forward: boolean): void {
    if (q) api.findInPage(q, forward, true)
  }

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(!e.shiftKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        className="findbar-input"
        placeholder="Im Chat suchen…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
      />
      <span className="findbar-count">{q ? `${res.activeMatchOrdinal}/${res.matches}` : ''}</span>
      <button className="btn ghost sm" onClick={() => step(false)} title="Vorheriger (Shift+Enter)">
        ↑
      </button>
      <button className="btn ghost sm" onClick={() => step(true)} title="Nächster (Enter)">
        ↓
      </button>
      <button className="btn ghost sm" onClick={onClose} title="Schließen (Esc)">
        ✕
      </button>
    </div>
  )
}
