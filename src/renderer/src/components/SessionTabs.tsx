import type { Session } from '../../../shared/types'

// Browser-style tab strip for the chats you have open at once. The backend already runs each
// session independently by id (background turns keep streaming + clear their own `running`),
// so this is purely the UI that lets you keep several open and switch between them. A pulsing
// dot marks a tab whose agent is mid-turn — including background tabs.
export function SessionTabs({
  tabs,
  activeId,
  running,
  onSelect,
  onClose,
  onNew
}: {
  tabs: Session[]
  activeId: string | null
  running: ReadonlySet<string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}): JSX.Element {
  return (
    <div className="session-tabs" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={'session-tab' + (t.id === activeId ? ' active' : '')}
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
