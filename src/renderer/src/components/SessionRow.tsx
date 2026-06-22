import type { Session } from '../../../shared/types'
import { basename, relTime } from './ChatExtras'

export interface SessionRowProps {
  session: Session
  active: boolean
  renaming: boolean
  renameText: string
  onRenameText: (t: string) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onStartRename: (id: string, title: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
}

// One chat row in the sidebar list. Renaming is inline (double-click, F2, or the ✎ button), with
// commit on Enter/blur and cancel on Escape. The ✎/✕ buttons live in a hover-revealed action group.
export function SessionRow(p: SessionRowProps): JSX.Element {
  const s = p.session
  const label = s.title || 'Untitled'
  return (
    <div
      className={'session-item' + (p.active ? ' active' : '')}
      role="button"
      tabIndex={p.renaming ? -1 : 0}
      onClick={() => p.onOpen(s.id)}
      onDoubleClick={() => p.onStartRename(s.id, s.title || '')}
      onKeyDown={(e) => {
        if (p.renaming) return // the rename input handles its own keys
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          p.onOpen(s.id)
        } else if (e.key === 'F2') {
          e.preventDefault()
          p.onStartRename(s.id, s.title || '')
        } else if (e.key === 'Delete') {
          e.preventDefault()
          p.onDelete(s.id)
        }
      }}
      title={s.cwd + ' (Doppelklick / F2: umbenennen)'}
    >
      {p.renaming ? (
        <input
          className="rename-input"
          value={p.renameText}
          autoFocus
          onChange={(e) => p.onRenameText(e.target.value)}
          onBlur={p.onCommitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') p.onCommitRename()
            if (e.key === 'Escape') p.onCancelRename()
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
          <div className="session-meta">
            {basename(s.cwd)} · {relTime(s.updatedAt)}
          </div>
        </div>
      )}
      <div className="session-actions">
        {!p.renaming && (
          <button
            type="button"
            className="edit"
            aria-label={`Chat „${label}" umbenennen`}
            title="Umbenennen (F2)"
            onClick={(ev) => {
              ev.stopPropagation()
              p.onStartRename(s.id, s.title || '')
            }}
            onKeyDown={(ev) => ev.stopPropagation()}
          >
            ✎
          </button>
        )}
        <button
          type="button"
          className="x"
          aria-label={`Chat „${label}" löschen`}
          title="Löschen (Entf)"
          onClick={(ev) => {
            ev.stopPropagation()
            p.onDelete(s.id)
          }}
          onKeyDown={(ev) => ev.stopPropagation()}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
