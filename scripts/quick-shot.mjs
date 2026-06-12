import { _electron } from 'playwright'
const app = await _electron.launch({ args: ['out/main/index.js'] })
const win = await app.firstWindow()
await win.waitForSelector('.brand', { timeout: 15000 })
await win.waitForTimeout(1000)
await win.screenshot({ path: 'C:/Users/Maurice/AppData/Local/Temp/dc-shots/09-sidebar-neu.png' })
await app.close()
console.log('ok')
