import { app } from 'electron'

// Auto-update via electron-updater + GitHub Releases. Active only in the
// packaged app AND once build.publish in package.json points to a real repo
// (PUBLISH.bat fills that in). In dev it reports honestly instead of erroring.

export interface UpdateCheckResult {
  status: 'dev' | 'uptodate' | 'available' | 'downloaded' | 'error'
  version?: string
  message?: string
}

let wired = false

async function getUpdater(): Promise<typeof import('electron-updater').autoUpdater | null> {
  try {
    const { autoUpdater } = await import('electron-updater')
    if (!wired) {
      wired = true
      autoUpdater.autoDownload = true
      autoUpdater.on('error', (e) => console.error('Updater:', e.message))
    }
    return autoUpdater
  } catch {
    return null
  }
}

// Silent startup check (notifies via OS notification when an update landed).
export async function autoCheckOnStartup(): Promise<void> {
  if (!app.isPackaged) return
  const updater = await getUpdater()
  if (!updater) return
  setTimeout(() => {
    updater.checkForUpdatesAndNotify().catch((e) => console.error('Update check:', e.message))
  }, 10_000)
}

// Manual check from the Settings panel.
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return {
      status: 'dev',
      message: 'Dev-Modus (Quellcode-Start) — Updates kommen hier direkt per git/Neustart.'
    }
  }
  const updater = await getUpdater()
  if (!updater) return { status: 'error', message: 'electron-updater nicht verfügbar.' }
  try {
    const result = await updater.checkForUpdates()
    const remote = result?.updateInfo?.version
    if (remote && remote !== app.getVersion()) {
      return {
        status: 'available',
        version: remote,
        message: `Version ${remote} verfügbar — wird im Hintergrund geladen und beim nächsten Beenden installiert.`
      }
    }
    return { status: 'uptodate', message: `Du bist aktuell (v${app.getVersion()}).` }
  } catch (e) {
    const msg = (e as Error).message
    if (/404|ENOTFOUND|Unable to find latest/i.test(msg)) {
      return {
        status: 'error',
        message:
          'Kein Release-Kanal erreichbar. Einmal PUBLISH.bat ausführen (legt GitHub-Repo + Release an), dann funktioniert Auto-Update.'
      }
    }
    return { status: 'error', message: `Update-Check fehlgeschlagen: ${msg.slice(0, 160)}` }
  }
}
