// Headless UI smoke test: launches the built app, drives the main flows, and
// collects renderer console errors + uncaught page exceptions. Run:
//   node scripts/ui-smoke.mjs
// Exits non-zero if any uncaught page error occurred.
import { _electron } from 'playwright'

const OUT = process.env.SHOT_DIR || 'C:/Users/Maurice/AppData/Local/Temp/dc-uismoke'
const consoleErrors = []
const pageErrors = []
const failures = []

const app = await _electron.launch({ args: ['out/main/index.js'] })
const win = await app.firstWindow()

win.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
win.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)))

const step = async (name, fn) => {
  try {
    await fn()
    await win.waitForTimeout(250)
  } catch (e) {
    failures.push(`${name}: ${e.message}`)
  }
}
const shot = async (name) => {
  try {
    await win.screenshot({ path: `${OUT}/${name}.png` })
  } catch {
    /* ignore */
  }
}

await win.waitForSelector('.brand', { timeout: 20000 })
await win.waitForTimeout(1200)
await shot('00-boot')

// dismiss first-run modal if it appears
await step('dismiss-firstrun', async () => {
  const later = win.locator('button:has-text("Später")')
  if (await later.count()) await later.first().click()
})

// command palette: open, filter, escape
await step('palette-open', async () => {
  await win.keyboard.press('Control+P')
  await win.waitForSelector('.palette-input', { timeout: 4000 })
  await win.fill('.palette-input', 'kosten')
  await win.waitForTimeout(300)
  await win.keyboard.press('Escape')
})
await shot('01-after-palette')

// in-chat find: open, type, escape
await step('find-open', async () => {
  await win.keyboard.press('Control+F')
  await win.waitForSelector('.findbar-input', { timeout: 4000 })
  await win.fill('.findbar-input', 'a')
  await win.waitForTimeout(300)
  await win.keyboard.press('Escape')
})

// composer: slash menu + @ mention (no real send → no API cost)
await step('composer-slash', async () => {
  const ta = win.locator('.composer textarea')
  if (await ta.count()) {
    await ta.first().fill('/')
    await win.waitForTimeout(400)
    await ta.first().fill('')
  }
})

// preview pane toggle
await step('preview-toggle', async () => {
  const btn = win.locator('button:has-text("Vorschau")')
  if (await btn.count()) {
    await btn.first().click()
    await win.waitForTimeout(600)
    await shot('02-preview-open')
    await btn.first().click()
  }
})

// walk every nav destination — ensure "Erweitert" (NAV_MORE) is EXPANDED, not just
// toggled (it persists in localStorage, so a blind toggle could collapse it).
await step('expand-more', async () => {
  const probe = win.locator('.nav button:has-text("Memory")')
  for (let i = 0; i < 2 && (await probe.count()) === 0; i++) {
    await win.locator('.nav button:has-text("Erweitert")').first().click()
    await win.waitForTimeout(200)
  }
})
const views = [
  'Projekte', 'Kosten', 'Nachtschicht', 'Settings',
  'Marketplace', 'Skills', 'Slash', 'Subagents', 'MCP', 'Hooks', 'Memory', 'Automations', 'Plugins', 'Audit-Log'
]
for (const label of views) {
  await step(`view:${label}`, async () => {
    const b = win.locator(`.nav button:has-text("${label}")`)
    if (await b.count()) {
      await b.first().click()
      await win.waitForTimeout(350)
    } else {
      failures.push(`view:${label}: nav button not found`)
    }
  })
}
await shot('03-settings')

// settings: confirm the new cards render
await step('settings-cards', async () => {
  await win.locator('.nav button:has-text("Settings")').first().click()
  await win.waitForTimeout(400)
  for (const h of ['Claude Code', 'Auto-erlaubte Befehle', 'DeepSeek provider']) {
    const c = win.locator(`text=${h}`)
    if (!(await c.count())) failures.push(`settings card missing: ${h}`)
  }
})

// theme toggle round-trip
await step('theme-toggle', async () => {
  await win.click('.theme-toggle')
  await win.waitForTimeout(300)
  await shot('04-light')
  await win.click('.theme-toggle')
})

// back to chat
await step('back-to-chat', async () => {
  await win.locator('.nav button:has-text("Chat")').first().click()
})

await win.waitForTimeout(500)
await app.close()

const benign = /Autofill|DevTools|Electron Security Warning|Insecure Content|net::ERR/i
const realConsole = consoleErrors.filter((e) => !benign.test(e))
console.log(JSON.stringify({
  pageErrors,
  consoleErrorsAll: consoleErrors.length,
  consoleErrorsReal: realConsole,
  interactionFailures: failures
}, null, 2))
if (pageErrors.length) process.exit(2)
