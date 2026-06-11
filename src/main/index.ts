import { app, shell, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { ensureConfigDirs } from './paths'
import { seedStarterContent } from './seed'
import { registerIpc, bootstrapMcp } from './ipc'

const __dirname = dirname(fileURLToPath(import.meta.url))

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'DeepCode',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

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
