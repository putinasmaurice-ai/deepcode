// Re-capture the Mission Control screenshot with a NEUTRAL working-folder path (no real username),
// writing straight into the public repo's docs/screenshots. Run: node scripts/neutral-shot.mjs
import { _electron } from 'playwright'

const DEST = 'C:/Users/Maurice/Desktop/deepcode-public/docs/screenshots/02-mission-control.png'

const app = await _electron.launch({ args: ['out/main/index.js'] })
const win = await app.firstWindow()
await app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setSize(1600, 1000)
  w.center()
})
await win.waitForSelector('.brand', { timeout: 20000 })
await win.waitForTimeout(1000)

const later = win.locator('button:has-text("Später")')
if (await later.count()) await later.first().click()
await win.waitForTimeout(400)

// expand "Erweitert" so the Missionen nav button exists
const probe = win.locator('.nav button:has-text("Missionen")')
for (let i = 0; i < 2 && (await probe.count()) === 0; i++) {
  await win.locator('.nav button:has-text("Erweitert")').first().click()
  await win.waitForTimeout(250)
}
await win.locator('.nav button:has-text("Missionen")').first().click()
await win.waitForTimeout(800)

// neutralize any input whose value is a real Windows user path
const inputs = win.locator('input')
const n = await inputs.count()
for (let i = 0; i < n; i++) {
  const v = await inputs.nth(i).inputValue().catch(() => '')
  if (/[A-Za-z]:\\Users\\/i.test(v) || v.includes('/Users/')) {
    await inputs.nth(i).fill('C:\\Projekte\\demo-app')
    console.log('neutralized folder field:', v, '→ C:\\Projekte\\demo-app')
  }
}
await win.waitForTimeout(500)
await win.screenshot({ path: DEST })
console.log('saved:', DEST)
await app.close()
