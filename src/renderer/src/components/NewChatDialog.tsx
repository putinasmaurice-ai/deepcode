import { useState } from 'react'
import { NewFolderDialog } from './NewFolderDialog'

const api = window.deepcode

// Asked up front when the user starts a NEW chat (Ctrl+N / palette / sidebar +): in which
// folder should the agent work? Pre-fills the current/default workspace so a quick Enter just
// starts there, while "Wählen…" adopts an existing folder and "Neuer Ordner…" creates a fresh
// one — so a new project can land in its own folder, like Claude Code Desktop.
export function NewChatDialog({
  defaultCwd,
  onStart,
  onClose
}: {
  defaultCwd: string
  onStart: (cwd: string) => void
  onClose: () => void
}): JSX.Element {
  const [cwd, setCwd] = useState(defaultCwd || '')
  const [creatingFolder, setCreatingFolder] = useState(false)

  async function pickExisting(): Promise<void> {
    const dir = (await api.pickDirectory()) as string | null
    if (dir) setCwd(dir)
  }

  // delegate the "fresh folder" path to the shared dialog; on success start the chat there
  if (creatingFolder) {
    return (
      <NewFolderDialog
        onClose={() => setCreatingFolder(false)}
        onCreated={(path) => {
          setCreatingFolder(false)
          onStart(path)
        }}
      />
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>✨ Neuer Chat</h2>
        <p>
          In welchem Ordner soll der Agent arbeiten? Wähle einen vorhandenen Ordner oder lege
          einen frischen an — leer lassen nutzt den Standard-Ordner.
        </p>

        <label className="modal-hint" style={{ display: 'block', marginTop: 6 }}>
          Arbeitsverzeichnis
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            style={{ flex: 1 }}
            autoFocus
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\… (leer = Standard-Ordner)"
            onKeyDown={(e) => e.key === 'Enter' && onStart(cwd.trim())}
          />
          <button className="btn ghost" style={{ flex: '0 0 auto' }} onClick={pickExisting}>
            Wählen…
          </button>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={() => onStart(cwd.trim())}>
            Chat starten
          </button>
          <button className="btn ghost" onClick={() => setCreatingFolder(true)}>
            ＋ Neuer Ordner…
          </button>
          <button className="btn ghost" onClick={onClose}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}
