// Live approval-flow test: launches the real app, sends a tool-requiring task in
// interactive mode, and drives the approval card → observes the tool run + answer.
// Exercises the full UI loop: stream → tool_pending → approve → tool_result → done.
import { _electron } from 'playwright'

const OUT = process.env.SHOT_DIR || 'C:/Users/Maurice/AppData/Local/Temp/dc-approval'
const consoleErrors = []
const pageErrors = []
const app = await _electron.launch({ args: ['out/main/index.js'] })
const win = await app.firstWindow()
win.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
win.on('pageerror', (e) => pageErrors.push(String(e)))

const result = { phase: 'init', approvalSeen: false, toolOk: false, finalText: '', keyError: false }
try {
  await win.waitForSelector('.brand', { timeout: 20000 })
  await win.waitForTimeout(1000)
  const later = win.locator('button:has-text("Später")')
  if (await later.count()) await later.first().click()

  // make sure we're in interactive mode (so the tool needs approval)
  const modeSel = win.locator('select.model-select.mode-interactive, select.model-select').first()
  try {
    await modeSel.selectOption('interactive')
  } catch {
    /* default is already interactive */
  }

  result.phase = 'send'
  const ta = win.locator('.composer textarea').first()
  await ta.fill('Run the shell command: echo approval-test-12345 — then tell me its exact output.')
  await ta.press('Enter')

  // wait for EITHER the approval card or a key/error banner
  result.phase = 'await-approval'
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (await win.locator('.approve').count()) {
      result.approvalSeen = true
      break
    }
    const banner = win.locator('.banner')
    if (await banner.count()) {
      const t = (await banner.first().innerText()).toLowerCase()
      if (t.includes('key') || t.includes('api')) {
        result.keyError = true
        result.finalText = await banner.first().innerText()
        break
      }
    }
    await win.waitForTimeout(500)
  }

  if (result.approvalSeen) {
    await win.screenshot({ path: `${OUT}/01-approval-card.png` })
    result.phase = 'approve'
    await win.locator('.approve-actions button:has-text("Allow")').first().click()
    // wait for the tool result to come back ok
    try {
      await win.waitForSelector('.tool .status.ok', { timeout: 30000 })
      result.toolOk = true
    } catch {
      /* tool may have failed or not surfaced */
    }
    await win.waitForTimeout(2500) // let the assistant finish its reply
    await win.screenshot({ path: `${OUT}/02-after-approve.png` })
    // grab the last assistant bubble text
    const bubbles = win.locator('.bubble')
    const n = await bubbles.count()
    if (n) result.finalText = (await bubbles.nth(n - 1).innerText()).slice(0, 300)
    result.phase = 'done'
  }
} catch (e) {
  result.phase = 'error: ' + e.message
}

await win.waitForTimeout(300)
await app.close()
console.log(JSON.stringify({ ...result, consoleErrors, pageErrors }, null, 2))
