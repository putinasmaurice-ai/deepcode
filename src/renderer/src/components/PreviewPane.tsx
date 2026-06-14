import { createElement, useEffect, useRef, useState } from 'react'
import type { PreviewInfo } from '../../../shared/api'
import type { AgentEvent } from '../../../shared/types'

const api = window.deepcode

// Live preview of the project being built — like Claude Code's preview pane.
// Renders the project's static index.html (file://) or its dev-server URL in an
// isolated <webview>. The agent can start the dev server via run_command; the
// user hits ⟳ once it's up.
export function PreviewPane({ cwd, onClose, onFix }: { cwd: string; onClose: () => void; onFix?: (prompt: string) => void }): JSX.Element {
  const [input, setInput] = useState('')
  const [url, setUrl] = useState('')
  const [info, setInfo] = useState<PreviewInfo | null>(null)
  const [err, setErr] = useState('') // latest runtime error from the live preview
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewRef = useRef<any>(null)

  // surface a runtime error (console error / failed load) from the preview as a "Fix this" chip
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'preview_error') setErr(e.message)
    })
    return off
  }, [])

  function fixIt(): void {
    if (!err) return
    onFix?.(
      `Die Live-Vorschau meldet einen Laufzeitfehler:\n\n${err}\n\n` +
        'Finde die Ursache im Code und behebe sie. Prüfe danach mit dem Tool preview_probe (action "console" bzw. "screenshot"), dass der Fehler weg ist.'
    )
    setErr('')
  }

  async function detect(load: boolean, alive: () => boolean = () => true): Promise<void> {
    const pi = await api.detectPreview(cwd)
    if (!alive()) return // a newer cwd (or unmount) superseded this call
    setInfo(pi)
    if (pi.url) {
      setInput(pi.url)
      if (load) setUrl(pi.url)
    }
  }

  useEffect(() => {
    // ignore a stale/in-flight detect if cwd changes again or the pane unmounts
    let alive = true
    void detect(true, () => alive)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  function load(): void {
    let u = input.trim()
    if (!u) return
    if (!/^(https?|file):\/\//i.test(u)) u = 'http://' + u
    setUrl(u)
  }

  function reload(): void {
    try {
      viewRef.current?.reload?.()
    } catch {
      /* webview not ready */
    }
  }

  return (
    <div className="preview-pane">
      <div className="preview-bar">
        <input
          className="preview-url"
          placeholder="http://localhost:5173 oder Datei…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
        <button className="btn sm" onClick={load} title="Laden">
          Laden
        </button>
        <button className="btn ghost sm" onClick={reload} title="Neu laden">
          ⟳
        </button>
        <button className="btn ghost sm" onClick={() => void detect(true)} title="Projekt erkennen">
          Erkennen
        </button>
        <button
          className="btn ghost sm"
          onClick={() => url && api.openExternal(url)}
          title="Im Browser öffnen"
        >
          ⧉
        </button>
        <button className="btn ghost sm" onClick={onClose} title="Vorschau schließen">
          ✕
        </button>
      </div>
      {info?.kind === 'dev' && info.devScript && (
        <div className="preview-hint">
          Dev-Server nötig: <code>{info.devScript}</code> starten lassen, dann ⟳ klicken.
        </div>
      )}
      {err && (
        <div className="preview-err">
          <span className="preview-err-msg" title={err}>⚠ {err}</span>
          <span className="preview-err-actions">
            {onFix && (
              <button className="btn sm" onClick={fixIt} title="Den Fehler an die KI geben und beheben lassen">
                🔧 Fix this
              </button>
            )}
            <button className="btn ghost sm" onClick={() => setErr('')} title="Ausblenden">
              ✕
            </button>
          </span>
        </div>
      )}
      <div className="preview-frame">
        {url ? (
          // popups are denied by default; the main process (will-attach-webview /
          // did-attach-webview) hardens the guest and routes window.open to the OS browser.
          createElement('webview', {
            ref: viewRef,
            src: url,
            className: 'preview-webview'
          })
        ) : (
          <div className="preview-empty">
            Keine Vorschau erkannt. URL eingeben oder <b>Erkennen</b> klicken.
            <br />
            Tipp: Lass die KI <code>npm run dev</code> starten und klicke dann ⟳.
          </div>
        )}
      </div>
    </div>
  )
}
