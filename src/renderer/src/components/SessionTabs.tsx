import { useEffect, useRef, useState } from 'react'
import type { Session } from '../../../shared/types'

// Browser-style tab strip for the chats you have open at once. The backend already runs each
// session independently by id (background turns keep streaming + clear their own `running`),
// so this is purely the UI that lets you keep several open and switch between them. A pulsing
// dot marks a tab whose agent is mid-turn — including background tabs. The strip scrolls
// horizontally when there are many tabs (the active one is auto-revealed), and tabs can be
// reordered by drag — the order is the parent's `openTabs` array, which it persists for free.
export function SessionTabs({
  tabs,
  activeId,
  running,
  onSelect,
  onClose,
  onNew,
  onReorder
}: {
  tabs: Session[]
  activeId: string | null
  running: ReadonlySet<string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onReorder?: (from: number, to: number) => void
}): JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  // keep the active tab visible when switching (incl. via Ctrl+Tab keyboard cycling)
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId])

  // Translate a plain vertical wheel into horizontal scroll when the strip overflows — otherwise a
  // mouse-only user (no trackpad / no Shift+wheel) can't reach off-screen tabs now that the
  // scrollbar is hidden. Native listener with { passive: false } because React's onWheel is passive,
  // so preventDefault() would be ignored there. A horizontal swipe (deltaX≠0) already scrolls — leave it.
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth || e.deltaY === 0 || e.deltaX !== 0) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div className="session-tabs" role="tablist" ref={stripRef}>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={
            'session-tab' +
            (t.id === activeId ? ' active' : '') +
            (dragIndex === i ? ' dragging' : '') +
            (overIndex === i ? ' drag-over' : '')
          }
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragOver={(e) => {
            e.preventDefault()
            if (overIndex !== i) setOverIndex(i)
          }}
          onDrop={() => {
            if (dragIndex != null && dragIndex !== i) onReorder?.(dragIndex, i)
            setDragIndex(null)
            setOverIndex(null)
          }}
          onDragEnd={() => {
            setDragIndex(null)
            setOverIndex(null)
          }}
          onClick={() => onSelect(t.id)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(t.id) // middle-click closes, like a browser tab
            }
          }}
          title={t.title || 'New session'}
        >
          {running.has(t.id) && <span className="tab-pulse" aria-label="läuft" />}
          <span className="tab-title">{t.title || 'New session'}</span>
          <button
            className="tab-close"
            title="Tab schließen"
            aria-label="Tab schließen"
            draggable={false}
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.id)
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button className="tab-new" title="Neuer Chat (Strg+N)" aria-label="Neuer Chat" onClick={onNew}>
        ＋
      </button>
    </div>
  )
}
