// Polish the feature tour into a captioned, cross-faded MP4 (+ GIF):
//   node scripts/build-tour-video.mjs   (reads %TEMP%/dc-tour/frame-*.png)
import sharp from 'sharp'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const D = join(tmpdir(), 'dc-tour')
const W = 1280, H = 800
const FONT = `'Segoe UI', system-ui, Arial, sans-serif`
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// caption bar overlaid on the bottom of a screenshot
function captionSvg(text) {
  return Buffer.from(`<svg width="${W}" height="104" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#070b12" stop-opacity="0"/>
      <stop offset="0.4" stop-color="#070b12" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#070b12" stop-opacity="0.97"/></linearGradient></defs>
    <rect width="${W}" height="104" fill="url(#b)"/>
    <circle cx="46" cy="68" r="6" fill="#22d3ee"/>
    <text x="66" y="76" font-family="${FONT}" font-size="29" font-weight="700" fill="#e8eef6">${esc(text)}</text>
  </svg>`)
}

// full-screen card (title / end)
function card(lines) {
  const body = lines.map((l) => `<text x="${l.x ?? 90}" y="${l.y}" font-family="${FONT}" font-size="${l.size}" font-weight="${l.weight ?? 700}" fill="${l.fill}">${esc(l.t)}</text>`).join('')
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c1422"/><stop offset="1" stop-color="#070b12"/></linearGradient>
      <linearGradient id="wm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2dd4bf"/><stop offset="0.55" stop-color="#22d3ee"/><stop offset="1" stop-color="#818cf8"/></linearGradient>
      <radialGradient id="g" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#22d3ee" stop-opacity="0.5"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient>
      <filter id="s"><feGaussianBlur stdDeviation="55"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <circle cx="${W - 120}" cy="120" r="240" fill="url(#g)" filter="url(#s)"/>
    ${body}
  </svg>`)
}

const slides = [
  // 0 — title
  { card: card([
      { t: 'DeepCode', y: 360, size: 110, weight: 800, fill: 'url(#wm)' },
      { t: 'Agentic coding — as a desktop app.', y: 430, size: 36, fill: '#e8eef6' },
      { t: 'Electron · React · TypeScript · multi-model · fully local', y: 480, size: 22, weight: 600, fill: '#9fb0c3' }
    ]) },
  { frame: 'v-builder.png', caption: 'Visual workflow builder — 20 node types' },
  { frame: 'v-mission.png', caption: 'Mission Control — autonomous, verify-gated' },
  { frame: 'v-traces.png', caption: 'Run traces — cost & latency per turn' },
  { frame: 'v-workflows.png', caption: 'Workflow automation — build, generate, or from templates' },
  { frame: 'v-marketplace.png', caption: 'MCP marketplace — 31 one-click connectors' },
  // 6 — end
  { card: card([
      { t: 'Built from scratch.', y: 370, size: 56, weight: 800, fill: '#e8eef6' },
      { t: 'github.com/MauricePutinas/deepcode', y: 440, size: 30, weight: 700, fill: '#22d3ee' }
    ]) }
]

// render each slide to slide-NN.png
for (let i = 0; i < slides.length; i++) {
  const s = slides[i]
  const out = join(D, `slide-${String(i).padStart(2, '0')}.png`)
  if (s.card) {
    await sharp(s.card).png().toFile(out)
  } else {
    await sharp(join(D, s.frame))
      .resize(W, H, { fit: 'cover' })
      .composite([{ input: captionSvg(s.caption), top: H - 104, left: 0 }])
      .png()
      .toFile(out)
  }
}

// ffmpeg xfade chain — uniform slide length L, transition t; offset_n = n*(L-t)
const N = slides.length, L = 2.0, T = 0.5
const inputs = []
for (let i = 0; i < N; i++) inputs.push('-loop', '1', '-t', String(L), '-i', join(D, `slide-${String(i).padStart(2, '0')}.png`))
let fc = '', prev = '0'
for (let i = 1; i < N; i++) {
  const label = i === N - 1 ? 'vout' : `v${i}`
  const off = (i * (L - T)).toFixed(2)
  fc += `[${prev}][${i}]xfade=transition=fade:duration=${T}:offset=${off}[${label}];`
  prev = label
}
fc = fc.replace(/;$/, '')

const mp4 = join(D, 'tour-polished.mp4')
execFileSync('ffmpeg', ['-y', ...inputs, '-filter_complex', fc, '-map', '[vout]', '-r', '30', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', mp4], { stdio: 'inherit' })

// GIF from the polished mp4 (palette for quality, modest size)
const gif = join(D, 'tour-polished.gif')
execFileSync('ffmpeg', ['-y', '-i', mp4, '-vf', 'fps=10,scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=144[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', gif], { stdio: 'inherit' })

console.log('DONE →', mp4, '+', gif)
