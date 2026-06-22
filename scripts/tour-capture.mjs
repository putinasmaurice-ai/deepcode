// Capture a CLEAN feature-tour frame sequence (no username/file paths on screen).
//   node scripts/tour-capture.mjs   →   named frames in %TEMP%/dc-tour/
import { _electron } from 'playwright'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'

const OUT = join(tmpdir(), 'dc-tour')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const app = await _electron.launch({ args: ['out/main/index.js'] })
const win = await app.firstWindow()
await app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setSize(1280, 800)
  w.center()
})
await win.waitForSelector('.brand', { timeout: 20000 })
await win.waitForTimeout(1200)

const cap = (name) => win.screenshot({ path: join(OUT, `${name}.png`) })
const step = async (n, fn) => { try { await fn() } catch (e) { console.log(`! ${n}: ${e.message}`) } }
const go = async (label) => {
  const b = win.locator(`.nav button:has-text("${label}")`)
  if (await b.count()) { await b.first().click(); await win.waitForTimeout(850) }
}

await step('firstrun', async () => {
  const later = win.locator('button:has-text("Später")')
  if (await later.count()) await later.first().click()
})
await win.waitForTimeout(400)
await step('expand', async () => {
  const probe = win.locator('.nav button:has-text("Traces")')
  for (let i = 0; i < 2 && (await probe.count()) === 0; i++) {
    await win.locator('.nav button:has-text("Erweitert")').first().click()
    await win.waitForTimeout(250)
  }
})

// Mission Control — neutralize any real Windows-user path before capturing
await step('mission', async () => {
  await go('Missionen')
  const inputs = win.locator('input')
  const c = await inputs.count()
  for (let i = 0; i < c; i++) {
    const v = await inputs.nth(i).inputValue().catch(() => '')
    if (/[A-Za-z]:\\Users\\/i.test(v) || v.includes('/Users/')) await inputs.nth(i).fill('C:\\Projekte\\demo-app')
  }
  await win.waitForTimeout(300)
  await cap('v-mission')
})

await step('traces', async () => { await go('Traces'); await cap('v-traces') })
await step('workflows', async () => { await go('Workflows'); await win.waitForTimeout(400); await cap('v-workflows') })
await step('marketplace', async () => { await go('Marketplace'); await cap('v-marketplace') })

// Visual workflow builder LAST — open a template so the canvas is populated
await step('builder', async () => {
  await go('Workflows')
  const tpl = win.locator('button:has-text("Aus Vorlage")')
  if (await tpl.count()) {
    await tpl.first().click()
    await win.waitForTimeout(400)
    const card = win.locator('.wf-tpl-card')
    if (await card.count()) {
      await card.first().click()
      await win.waitForSelector('.react-flow', { timeout: 8000 })
      await win.waitForTimeout(1600)
    }
  }
  await cap('v-builder')
})

await win.waitForTimeout(300)
await app.close()
console.log('captured clean frames →', OUT)
