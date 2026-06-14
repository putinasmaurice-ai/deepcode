import { Tool, ToolContext } from './types'
import { getPreviewGuest, previewReady, recentConsole } from '../../preview-bridge'

// Lets the agent interact with the LIVE preview webview — see, click, type, read the console —
// so it can verify a web UI actually RENDERS and RUNS (not just compiles) and fix runtime errors
// itself. Hard-blocked under unattended runs (screenUnattendedCall): it needs the open preview.
//
// SECURITY: the preview renders UNTRUSTED project output. So every probe runs in an ISOLATED
// world (page-overridden prototypes/getters can't apply), returns a CAPPED PRIMITIVE coerced
// inside the guest, and is RACED against a timeout + the turn's abort signal — so a hostile page
// can neither OOM-clone a huge value into main nor wedge the turn with an endless getter.

const OUT_CAP = 8000
const WORLD = 31337 // isolated world id — distinct from the page's main world (0)
const EVAL_TIMEOUT_MS = 5000

// Snippets run in the ISOLATED world (real String/slice/DOM prototypes) and ALWAYS return a
// short string, so the value cloned back to main is bounded regardless of the page.
const readBodyJs = 'String(document.body && document.body.innerText || "").slice(0, 6000)'
const clickJs = (sel: string): string =>
  `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return "notfound";` +
  `if(el.disabled)return "disabled";el.scrollIntoView({block:"center"});` +
  `const r=el.getBoundingClientRect();const h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);` +
  `if(h&&h!==el&&!el.contains(h)&&!h.contains(el))return "covered";el.click();return "ok";})()`
const typeJs = (sel: string, text: string): string =>
  `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return "notfound";if(el.disabled)return "disabled";el.focus();` +
  `const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;` +
  `const d=Object.getOwnPropertyDescriptor(proto,"value");const set=d&&d.set;` +
  `if(set)set.call(el,${JSON.stringify(text)});else el.value=${JSON.stringify(text)};` +
  `el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return "ok";})()`
const inspectJs = (sel: string): string =>
  `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return "notfound";const cs=getComputedStyle(el);` +
  `return String(el.outerHTML).slice(0,2000)+"\\n\\n[computed] display:"+cs.display+" visibility:"+cs.visibility+" opacity:"+cs.opacity+" color:"+cs.color+" background:"+cs.backgroundColor;})()`

// run page JS in the isolated world, coerced to a capped string, raced against a timeout + abort
async function evalGuest(
  guest: import('electron').WebContents,
  code: string,
  signal: AbortSignal,
  gesture = false
): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    const work = Promise.resolve(guest.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], gesture)).then((v) =>
      String(v ?? '').slice(0, OUT_CAP)
    )
    const guard = new Promise<string>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('preview_probe: Skript-Timeout (5s) — die Seite reagiert nicht.')), EVAL_TIMEOUT_MS)
      onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([work, guard])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export const previewProbeTool: Tool = {
  name: 'preview_probe',
  description:
    'Interagiere mit der LIVE-Vorschau der laufenden App (das Vorschau-Pane), um zu prüfen, ob deine UI wirklich rendert und LÄUFT — nicht nur kompiliert. Aktionen: ' +
    'screenshot (Bild → Beschreibung + sichtbarer Text), text (sichtbarer Text), console (letzte Konsolen-/Fehlerausgaben der Seite), ' +
    'click (CSS-Selektor klicken), type (Text in ein Feld tippen — braucht selector+text), inspect (HTML+Styles eines Elements). ' +
    'Nutze es IMMER nach dem Bauen/Ändern einer Web-UI: screenshot/console zeigen dir Laufzeitfehler, die der Compiler nicht sieht — behebe sie und prüfe erneut.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['screenshot', 'text', 'console', 'click', 'type', 'inspect'] },
      selector: { type: 'string', description: 'CSS-Selektor (für click/type/inspect)' },
      text: { type: 'string', description: 'Text zum Eintippen (für type)' }
    },
    required: ['action']
  },
  permission: 'read',
  summarize: (a) => `Vorschau: ${a.action}${a.selector ? ' ' + String(a.selector).slice(0, 40) : ''}`,
  async execute(args, ctx: ToolContext) {
    if (ctx.unattended) return { ok: false, content: 'preview_probe ist in unbeaufsichtigten Läufen deaktiviert.' }
    const guest = getPreviewGuest()
    if (!guest) {
      return {
        ok: false,
        content: 'Keine Live-Vorschau geöffnet. Öffne das Vorschau-Pane (👁 oben), lade die App (URL eingeben/⟳ oder Dev-Server starten), dann erneut versuchen.'
      }
    }
    const action = String(args.action || '')
    const sel = String(args.selector || '')
    // console reads a buffer and works regardless; everything else touches the DOM → needs a loaded page
    if (action !== 'console' && !previewReady()) {
      return { ok: false, content: 'Die Vorschau lädt noch (oder ist nicht fertig geladen) — gleich erneut versuchen.' }
    }
    try {
      switch (action) {
        case 'screenshot': {
          const img = await Promise.race([
            guest.capturePage(),
            new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('Screenshot-Timeout')), EVAL_TIMEOUT_MS))
          ])
          if (img.isEmpty()) return { ok: false, content: 'Screenshot war leer — die Vorschau zeigt noch nichts an.' }
          // the data URL is consumed by the vision model in-memory; NOT returned in meta (a
          // multi-MB PNG would bloat every persisted session + IPC event for no UI benefit).
          let desc = '(keine Vision verfügbar — beschreibe anhand des Texts unten)'
          if (ctx.describeImage) desc = (await ctx.describeImage(img.toDataURL())) || '(Screenshot konnte nicht analysiert werden)'
          const text = await evalGuest(guest, readBodyJs, ctx.signal)
          return { ok: true, content: `Screenshot-Beschreibung:\n${desc}\n\nSichtbarer Text:\n${text}`.slice(0, OUT_CAP) }
        }
        case 'text': {
          const t = await evalGuest(guest, readBodyJs, ctx.signal)
          return { ok: true, content: t || '(leer)' }
        }
        case 'console': {
          const lines = recentConsole(60)
          return { ok: true, content: lines.length ? lines.join('\n').slice(0, OUT_CAP) : '(keine Konsolenausgaben)' }
        }
        case 'click': {
          if (!sel) return { ok: false, content: 'click braucht einen selector.' }
          const r = await evalGuest(guest, clickJs(sel), ctx.signal, true)
          if (r === 'ok') return { ok: true, content: `Geklickt: ${sel}` }
          if (r === 'disabled') return { ok: false, content: `Element ist deaktiviert: ${sel}` }
          if (r === 'covered') return { ok: false, content: `Element ist verdeckt (ein anderes Element liegt darüber): ${sel}` }
          return { ok: false, content: `Element nicht gefunden: ${sel}` }
        }
        case 'type': {
          if (!sel) return { ok: false, content: 'type braucht einen selector.' }
          const r = await evalGuest(guest, typeJs(sel, String(args.text ?? '')), ctx.signal, true)
          if (r === 'ok') return { ok: true, content: `Getippt in ${sel}.` }
          if (r === 'disabled') return { ok: false, content: `Feld ist deaktiviert: ${sel}` }
          return { ok: false, content: `Eingabefeld nicht gefunden: ${sel}` }
        }
        case 'inspect': {
          if (!sel) return { ok: false, content: 'inspect braucht einen selector.' }
          const r = await evalGuest(guest, inspectJs(sel), ctx.signal)
          return r && r !== 'notfound' ? { ok: true, content: r } : { ok: false, content: `Element nicht gefunden: ${sel}` }
        }
        default:
          return { ok: false, content: `Unbekannte Aktion: ${action}` }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      return { ok: false, content: `preview_probe Fehler: ${(e as Error).message}` }
    }
  }
}
