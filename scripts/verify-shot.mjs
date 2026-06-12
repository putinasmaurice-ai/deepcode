import { _electron } from 'playwright'
const app = await _electron.launch({ args: ['out/main/index.js'] })
const win = await app.firstWindow()
await win.waitForSelector('.brand', { timeout: 15000 })
await win.waitForTimeout(900)
// dismiss first-run modal if present
const dismiss = await win.$('.modal .btn.ghost')
if (dismiss) await dismiss.click()
await win.fill('.composer textarea', '/go')
await win.waitForTimeout(500)
await win.screenshot({ path: 'C:/Users/Maurice/AppData/Local/Temp/dc-shots/11-slash-goal.png' })
await app.close()
console.log('ok')
