import { app, shell, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { ensureConfigDirs, PATHS } from './paths'
import { seedStarterContent } from './seed'
import { registerIpc, bootstrapMcp } from './ipc'

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
    backgroundColor: '#0a0f1a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    if (state.maximized) win.maximize()
    win.show()
  })
  win.on('close', () => saveWinState(win))

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  registerIpc(win)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app
  .whenReady()
  .then(() => {
    // required for HTML5 Notification toasts on Windows
    app.setAppUserModelId('com.maurice.deepcode')
    ensureConfigDirs()
    seedStarterContent()
    createWindow()
    bootstrapMcp()

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
  import('./jobs').then((m) => m.shutdownJobs()).catch(() => {})
})
