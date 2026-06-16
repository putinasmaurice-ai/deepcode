import { useEffect, useMemo, useRef, useState } from 'react'
import { filterPalette, PaletteScorable } from './palette-fuzzy'

export interface PaletteItem extends PaletteScorable {
  id: string
  label: string
  hint?: string
  icon?: string
  run: () => void
}

export function CommandPalette({
  items,
  onClose
}: {
  items: PaletteItem[]
  onClose: () => void
}): JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => filterPalette(items, q), [q, items])

  useEffect(() => {
    setSel(0)
  }, [q])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.cmd-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function choose(it: PaletteItem | undefined): void {
    if (!it) return
    onClose()
    // run after close so view changes don't fight the unmount
    setTimeout(() => it.run(), 0)
  }

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(filtered.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(filtered[sel])
    }
  }

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Befehl, Ansicht oder Chat suchen…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="cmd-empty">Keine Treffer</div>}
          {filtered.map((it, i) => (
            <div
              key={it.id}
              className={'cmd-item' + (i === sel ? ' active' : '')}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(it)}
            >
              <span className="cmd-icon">{it.icon ?? '›'}</span>
              <span className="cmd-label">{it.label}</span>
              {it.hint && <span className="cmd-hint">{it.hint}</span>}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigieren</span>
          <span><kbd>↵</kbd> ausführen</span>
          <span><kbd>Esc</kbd> schließen</span>
        </div>
      </div>
    </div>
  )
}
