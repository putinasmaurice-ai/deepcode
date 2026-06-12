// Visual inspection tour: launches the built app, walks the main views and
// captures screenshots for design review. Run: node scripts/screenshot-tour.mjs
import { _electron } from 'playwright'

const OUT = process.env.SHOT_DIR || 'C:/Users/Maurice/AppData/Local/Temp/dc-shots'
const app = await _electron.launch({ args: ['out/main/index.js'] })
const win = await app.firstWindow()
await win.waitForSelector('.brand', { timeout: 15000 })
await win.waitForTimeout(1200)

const shot = async (name) => {
  await win.waitForTimeout(450)
  await win.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot:', name)
}

await shot('01-chat-welcome')
for (const [label, name] of [
  ['Projekte', '02-projekte'],
  ['Kosten', '03-kosten'],
  ['Nachtschicht', '04-nachtschicht'],
  ['Skills', '05-skills'],
  ['Settings', '06-settings']
]) {
  await win.click(`.nav button:has-text("${label}")`)
  await shot(name)
}
// light theme
await win.click('.theme-toggle')
await win.click(`.nav button:has-text("Chat")`)
await shot('07-light-chat')
await win.click(`.nav button:has-text("Kosten")`)
await shot('08-light-kosten')
await win.click('.theme-toggle') // back to dark
await app.close()
console.log('done')
