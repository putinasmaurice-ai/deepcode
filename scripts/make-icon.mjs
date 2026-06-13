// Converts resources/icon-source.png into a multi-size Windows icon.ico
// (and a 512px PNG for Linux/docs). Run: node scripts/make-icon.mjs
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { writeFileSync } from 'fs'

const SRC = 'resources/icon-source.png'
const sizes = [16, 24, 32, 48, 64, 128, 256]
// 'contain' on a transparent background keeps the whole logo (incl. the DEEPCODE
// wordmark) even when the source isn't perfectly square — 'cover' would crop it.
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }
const fit = { fit: 'contain', background: TRANSPARENT }

const pngs = []
for (const s of sizes) {
  pngs.push(await sharp(SRC).resize(s, s, fit).png().toBuffer())
}
writeFileSync('resources/icon.ico', await pngToIco(pngs))
await sharp(SRC).resize(512, 512, fit).png().toFile('resources/icon.png')
console.log('icon.ico + icon.png written')
