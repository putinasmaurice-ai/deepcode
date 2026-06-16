import { useState } from 'react'

const api = window.deepcode

// Create a fresh project folder, then hand its absolute path back. This is the missing
// half of the workspace picker: pick a PARENT + type a NAME → a brand-new empty folder is
// created and becomes the chat/project working dir (like Claude Code Desktop).
export function NewFolderDialog({
  defaultName = '',
  onCreated,
  onClose
}: {
  defaultName?: string
  onCreated: (path: string) => void
  onClose: () => void
}): JSX.Element {
  const [parent, setParent] = useState('')
  const [name, setName] = useState(defaultName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const cleanName = name.trim()
  const sep = parent.includes('\\') || !parent.includes('/') ? '\\' : '/'
  const preview = parent && cleanName ? `${parent.replace(/[/\\]+$/, '')}${sep}${cleanName}` : ''

  async function pickParent(): Promise<void> {
    const dir = (await api.pickDirectory()) as string | null
    if (dir) setParent(dir)
  }

  async function create(): Promise<void> {
    if (!parent || !cleanName || busy) return
    setBusy(true)
    setError('')
    try {
      const path = await api.createDirectory(parent, cleanName)
      onCreated(path)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Ordner konnte nicht angelegt werden.')
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>📁 Neuen Projektordner anlegen</h2>
        <p>
          Wähle einen übergeordneten Ordner und einen Namen — DeepCode legt einen frischen,
          leeren Ordner an und macht ihn zum Arbeitsplatz des Chats.
        </p>

        <label className="modal-hint" style={{ display: 'block', marginTop: 6 }}>
          Übergeordneter Ordner
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            style={{ flex: 1 }}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            placeholder="C:\Users\…\Desktop"
          />
          <button className="btn ghost" style={{ flex: '0 0 auto' }} onClick={pickParent}>
            Wählen…
          </button>
        </div>

        <label className="modal-hint" style={{ display: 'block', marginTop: 6 }}>
          Ordnername
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="mein-neues-projekt"
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />

        {preview && <p className="modal-hint">Wird angelegt: {preview}</p>}
        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={create} disabled={!parent || !cleanName || busy}>
            {busy ? 'Lege an…' : 'Anlegen & öffnen'}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}
