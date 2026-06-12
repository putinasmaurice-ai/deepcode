// Converts resources/icon-source.png into a multi-size Windows icon.ico
// (and a 512px PNG for Linux/docs). Run: node scripts/make-icon.mjs
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { writeFileSync } from 'fs'

const SRC = 'resources/icon-source.png'
const sizes = [16, 24, 32, 48, 64, 128, 256]

const pngs = []
for (const s of sizes) {
  pngs.push(await sharp(SRC).resize(s, s, { fit: 'cover' }).png().toBuffer())
}
writeFileSync('resources/icon.ico', await pngToIco(pngs))
await sharp(SRC).resize(512, 512).png().toFile('resources/icon.png')
console.log('icon.ico + icon.png written')
