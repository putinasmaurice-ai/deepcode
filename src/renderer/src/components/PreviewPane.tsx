import { createElement, useEffect, useRef, useState } from 'react'
import type { PreviewInfo } from '../../../shared/api'

const api = window.deepcode

// Live preview of the project being built — like Claude Code's preview pane.
// Renders the project's static index.html (file://) or its dev-server URL in an
// isolated <webview>. The agent can start the dev server via run_command; the
// user hits ⟳ once it's up.
export function PreviewPane({ cwd, onClose }: { cwd: string; onClose: () => void }): JSX.Element {
  const [input, setInput] = useState('')
  const [url, setUrl] = useState('')
  const [info, setInfo] = useState<PreviewInfo | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewRef = useRef<any>(null)

  async function detect(load: boolean): Promise<void> {
    const pi = await api.detectPreview(cwd)
    setInfo(pi)
    if (pi.url) {
      setInput(pi.url)
      if (load) setUrl(pi.url)
    }
  }

  useEffect(() => {
    void detect(true)
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
      <div className="preview-frame">
        {url ? (
          createElement('webview', {
            ref: viewRef,
            src: url,
            className: 'preview-webview',
            // string attribute: disallow the guest from opening child windows itself
            allowpopups: undefined
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
