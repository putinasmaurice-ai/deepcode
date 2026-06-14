import { app, shell, dialog, BrowserWindow, Menu, clipboard } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { ensureConfigDirs, PATHS } from './paths'
import { seedStarterContent } from './seed'
import { registerIpc, bootstrapMcp } from './ipc'
import { shutdownJobs } from './jobs'
import { maybeRunE2E } from './e2e'
import { autoCheckOnStartup } from './updater'
import { attachPreviewGuest } from './preview-bridge'

// Window bounds persistence (~/.deepcode/window.json)
interface WinState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}
const WIN_FILE = (): string => join(PATHS.root, 'window.json')
function loadWinState(): WinState {
  try {
    if (existsSync(WIN_FILE())) return JSON.parse(readFileSync(WIN_FILE(), 'utf8'))
  } catch {
    /* ignore */
  }
  return { width: 1320, height: 860 }
}
function saveWinState(win: BrowserWindow): void {
  try {
    const b = win.getBounds()
    const state: WinState = { ...b, maximized: win.isMaximized() }
    writeFileSync(WIN_FILE(), JSON.stringify(state), 'utf8')
  } catch {
    /* ignore */
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

function createWindow(): void {
  const state = loadWinState()
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'DeepCode',
    icon: join(__dirname, '../../resources/icon.png'),
    backgroundColor: '#0a0f1a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // enables the <webview> tag used by the project preview pane
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => {
    if (state.maximized) win.maximize()
    win.show()
  })
  win.on('close', () => saveWinState(win))

  // Right-click context menu with Cut/Copy/Paste/Select-all — Electron has none
  // by default, which is why copy/paste felt broken.
  win.webContents.on('context-menu', (_e, params) => {
    const editable = params.isEditable
    const hasSelection = params.selectionText.trim().length > 0
    const template: Electron.MenuItemConstructorOptions[] = []
    if (editable) {
      template.push(
        { role: 'cut', enabled: hasSelection },
        { role: 'copy', enabled: hasSelection },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      )
    } else if (hasSelection) {
      template.push({ role: 'copy' })
    } else {
      template.push({ role: 'selectAll' })
    }
    if (params.linkURL) {
      template.unshift(
        { label: 'Link kopieren', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    Menu.buildFromTemplate(template).popup({ window: win })
  })

  // Only ever hand http(s)/mailto to the OS shell. The preview <webview> can render
  // untrusted project output, so a page there must not be able to open file:// or a
  // dangerous custom scheme (ms-…:, etc.) via window.open.
  const openExternalSafe = (url: string): void => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url)
  }
  win.webContents.setWindowOpenHandler((details) => {
    openExternalSafe(details.url)
    return { action: 'deny' }
  })
  // Never let the app's own window navigate away from its origin.
  win.webContents.on('will-navigate', (e, url) => {
    const here = process.env['ELECTRON_RENDERER_URL']
    if (!(here && url.startsWith(here)) && !url.startsWith('file://')) {
      e.preventDefault()
      openExternalSafe(url)
    }
  })

  // Lock down the preview <webview>: no node access, no preload, popups go to the
  // OS browser. The pane only ever renders the user's own project output.
  win.webContents.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler((details) => {
      openExternalSafe(details.url)
      return { action: 'deny' }
    })
    // expose the preview guest to the main process so the preview_probe tool can
    // screenshot/click/read-console, and surface runtime errors as a "Fix this" chip.
    attachPreviewGuest(guest)
  })

  registerIpc(win)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Single-instance: a second launch must not spawn a rival process that races on shared
// ~/.deepcode state (settings/sessions/ledger). Only enforced in the packaged app so dev,
// E2E and Playwright smoke launches are unaffected. A second launch focuses the open window.
const gotSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0]
  if (w) {
    if (w.isMinimized()) w.restore()
    w.focus()
  }
})

app
  .whenReady()
  .then(async () => {
    if (!gotSingleInstanceLock) return // a rival instance owns the lock — we are quitting
    // required for HTML5 Notification toasts on Windows
    app.setAppUserModelId('com.maurice.deepcode')
    ensureConfigDirs()
    // clear orphan swarm worktree checkouts left by a hard crash/power-loss mid-run (normal
    // teardown removes them; this only catches the crash case). Safe: no swarm runs at startup.
    // Stale .git/worktrees registrations in the affected repo are reaped by the next swarm's prune.
    try {
      rmSync(PATHS.swarm, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    // headless smoke-test mode (DEEPCODE_E2E_PROMPT) — runs one turn and quits
    if (await maybeRunE2E()) return
    seedStarterContent()
    createWindow()
    bootstrapMcp()
    autoCheckOnStartup()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((err) => {
    console.error('App initialization failed:', err)
    try {
      dialog.showErrorBox('DeepCode failed to start', String(err?.message ?? err))
    } catch {
      /* ignore */
    }
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // stop any still-running background jobs so we don't orphan processes
  // (synchronous — before-quit does not wait for promises)
  try {
    shutdownJobs()
  } catch {
    /* ignore */
  }
})
