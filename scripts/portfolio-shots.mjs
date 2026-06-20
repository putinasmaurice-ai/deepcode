// Portfolio screenshot capture: launches the built app, sizes the window for crisp shots,
// walks the most portfolio-worthy views and saves clean PNGs into ./portfolio-shots.
//   node scripts/portfolio-shots.mjs
import { _electron } from 'playwright'
import { mkdirSync } from 'fs'

const OUT = 'portfolio-shots'
mkdirSync(OUT, { recursive: true })

const app = await _electron.launch({ args: ['out/main/index.js'] })
const win = await app.firstWindow()

// big, crisp window for screenshots
await app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setSize(1600, 1000)
  w.center()
})
await win.waitForSelector('.brand', { timeout: 20000 })
await win.waitForTimeout(1200)

const shot = async (name) => {
  await win.waitForTimeout(500)
  await win.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot:', name)
}
const step = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    console.log(`! ${name}: ${e.message}`)
  }
}

// dismiss first-run modal if present
await step('firstrun', async () => {
  const later = win.locator('button:has-text("Später")')
  if (await later.count()) await later.first().click()
})
await win.waitForTimeout(400)

// make sure the "Erweitert" (NAV_MORE) group is expanded so its nav buttons exist
await step('expand-more', async () => {
  const probe = win.locator('.nav button:has-text("Traces")')
  for (let i = 0; i < 2 && (await probe.count()) === 0; i++) {
    await win.locator('.nav button:has-text("Erweitert")').first().click()
    await win.waitForTimeout(250)
  }
})

const go = async (label) => {
  const b = win.locator(`.nav button:has-text("${label}")`)
  if (await b.count()) {
    await b.first().click()
    await win.waitForTimeout(700)
    return true
  }
  return false
}

// 01 — Chat (main interface)
await step('chat', async () => {
  await go('Chat')
  await shot('01-chat')
})

// 02 — Mission Control
await step('missions', async () => {
  if (await go('Missionen')) await shot('02-mission-control')
})

// 03 — Run traces / observability
await step('traces', async () => {
  if (await go('Traces')) await shot('03-traces')
})

// 04 — Marketplace (MCP connector catalog)
await step('market', async () => {
  if (await go('Marketplace')) await shot('04-marketplace')
})

// 05 — Cost dashboard
await step('usage', async () => {
  if (await go('Kosten')) await shot('05-cost-dashboard')
})

// 06 — Swarm
await step('swarm', async () => {
  if (await go('Schwarm')) await shot('06-swarm')
})

// 07 — Time Machine
await step('timemachine', async () => {
  if (await go('Zeitmaschine')) await shot('07-time-machine')
})

// 08 — Memory
await step('memory', async () => {
  if (await go('Memory')) await shot('08-memory')
})

// 09 — Settings
await step('settings', async () => {
  if (await go('Settings')) await shot('09-settings')
})

// 10 — Workflows list panel
await step('workflows-list', async () => {
  if (await go('Workflows')) {
    await win.waitForTimeout(500)
    await shot('10-workflows-list')
  }
})

// 11 — Visual workflow builder (populated canvas from a template)
await step('workflow-canvas', async () => {
  const tplBtn = win.locator('button:has-text("Aus Vorlage")')
  if (await tplBtn.count()) {
    await tplBtn.first().click()
    await win.waitForTimeout(500)
    const card = win.locator('.wf-tpl-card')
    if (await card.count()) {
      // pick a richer template if present (Code-Review / project overview), else the first
      await card.first().click()
      await win.waitForSelector('.react-flow', { timeout: 8000 })
      await win.waitForTimeout(1500) // let the graph lay out + animate
      await shot('11-workflow-builder')
    }
  }
})

await win.waitForTimeout(400)
await app.close()
console.log('DONE → ./portfolio-shots')
