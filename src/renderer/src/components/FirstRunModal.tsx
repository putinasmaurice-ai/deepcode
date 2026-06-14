import { useState } from 'react'
import type { AppSettings } from '../../../shared/types'

const api = window.deepcode

// Friendly first-run gate: without an API key nothing works, so greet the user
// with a focused modal instead of a passive banner.
export function FirstRunModal({
  settings,
  onSaved,
  onDismiss
}: {
  settings: AppSettings
  onSaved: (s: AppSettings) => void
  onDismiss: () => void
}): JSX.Element {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save(): Promise<void> {
    if (!key.trim()) return
    setSaving(true)
    setError('')
    try {
      const next = await api.saveSettings({
        ...settings,
        provider: { ...settings.provider, apiKey: key.trim() }
      })
      onSaved(next)
    } catch (err) {
      // A rejected save must not leave the modal stuck on 'Speichere…'
      setSaving(false)
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.')
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>🐋 Willkommen bei DeepCode!</h2>
        <p>
          Damit dein Coding-Agent loslegen kann, braucht er einen <b>DeepSeek-API-Key</b>. Den bekommst
          du in 2 Minuten auf{' '}
          <a href="https://platform.deepseek.com" target="_blank" rel="noopener">
            platform.deepseek.com
          </a>{' '}
          — ein paar Euro Guthaben reichen für Wochen.
        </p>
        <input
          type="password"
          autoFocus
          placeholder="sk-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <p className="modal-hint">
          Der Key wird <b>verschlüsselt</b> auf deinem Rechner gespeichert (Windows-Schlüsselbund) und
          verlässt ihn nur Richtung DeepSeek. Alternativ kannst du komplett <b>lokal & kostenlos</b>{' '}
          arbeiten: Ollama starten und oben rechts ein <code>local:</code>-Modell wählen.
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={save} disabled={!key.trim() || saving}>
            {saving ? 'Speichere…' : 'Los geht’s'}
          </button>
          <button className="btn ghost" onClick={onDismiss}>
            Später (nur lokale Modelle)
          </button>
        </div>
      </div>
    </div>
  )
}
