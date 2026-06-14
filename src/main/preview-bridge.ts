import type { WebContents } from 'electron'
import { AgentEvent } from '@shared/types'

// Bridges the live preview <webview>'s guest WebContents (captured in index.ts at
// did-attach-webview) to the main process so the preview_probe tool can screenshot / read the
// console / click / type, and so a runtime ERROR surfaces a one-click "Fix this" in the UI.
// The guest is hardened (no node, isolated) — but capturePage/executeJavaScript/sendInputEvent
// are MAIN-process APIs on the handle, unaffected by the guest's own isolation.

let guest: WebContents | null = null
let loaded = false
let sink: ((e: AgentEvent) => void) | null = null

const MAX_CONSOLE = 100
const consoleBuf: string[] = []

// the renderer-facing emitter (set once by ipc.ts registerIpc to its `emit`)
export function setPreviewSink(fn: (e: AgentEvent) => void): void {
  sink = fn
}

function shortSrc(s: string): string {
  return (s || '').split(/[?#]/)[0].split('/').pop() || s
}

export function attachPreviewGuest(g: WebContents): void {
  guest = g
  loaded = false
  consoleBuf.length = 0
  // Every listener guards on `guest === g`: when a NEW preview guest replaces this one (pane
  // closed+reopened), the OLD guest's listeners stay attached to its (possibly still-alive)
  // webContents but become inert — they must not write the shared buffer or fire a chip for the
  // live preview.
  g.on('did-finish-load', () => {
    if (guest === g) loaded = true
  })
  g.on('did-start-loading', () => {
    if (guest === g) loaded = false
  })
  // console-message is push-only — buffer continuously so the tool can read PAST logs.
  // level: 0 verbose · 1 info · 2 warning · 3 error (Electron positional form).
  g.on('console-message', (_e, level: number, message: string, line: number, sourceId: string) => {
    if (guest !== g) return
    const tag = level >= 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG'
    const loc = sourceId ? ` (${shortSrc(sourceId)}:${line})` : ''
    consoleBuf.push(`[${tag}] ${String(message).slice(0, 500)}${loc}`)
    if (consoleBuf.length > MAX_CONSOLE) consoleBuf.shift()
    if (level >= 3) sink?.({ type: 'preview_error', message: `${String(message).slice(0, 300)}${loc}` })
  })
  g.on('did-fail-load', (_e, code: number, desc: string, url: string) => {
    if (guest !== g || code === -3) return // ERR_ABORTED — normal during navigations
    consoleBuf.push(`[LOAD-FAIL] ${desc} (${url})`)
    sink?.({ type: 'preview_error', message: `Laden fehlgeschlagen: ${desc} (${url})`, url })
  })
  // a renderer crash leaves a blank pane with no console error — surface it explicitly.
  g.on('render-process-gone', (_e, details: { reason?: string }) => {
    if (guest !== g) return
    sink?.({ type: 'preview_error', message: `Vorschau abgestürzt: ${details?.reason ?? 'unbekannt'}` })
  })
  g.once('destroyed', () => {
    if (guest === g) {
      guest = null
      loaded = false
      consoleBuf.length = 0
    }
  })
}

export function getPreviewGuest(): WebContents | null {
  return guest && !guest.isDestroyed() ? guest : null
}

export function previewReady(): boolean {
  const g = getPreviewGuest()
  return !!g && loaded && !g.isLoading()
}

export function recentConsole(n = 60): string[] {
  return consoleBuf.slice(-Math.max(1, n))
}
