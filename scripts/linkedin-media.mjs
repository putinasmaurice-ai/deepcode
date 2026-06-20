// Generate branded LinkedIn media (cover + feature highlights) as crisp PNGs from SVG via sharp.
//   node scripts/linkedin-media.mjs   →   C:/Users/Maurice/Desktop/linkedin-media/*.png
import sharp from 'sharp'
import { mkdirSync } from 'fs'

const OUT = 'C:/Users/Maurice/Desktop/linkedin-media'
mkdirSync(OUT, { recursive: true })

const W = 1200, H = 630, SCALE = 2
const FONT = `'Segoe UI', system-ui, -apple-system, Arial, sans-serif`
const C = {
  bg0: '#070b12', bg1: '#0c1422',
  teal: '#2dd4bf', cyan: '#22d3ee', indigo: '#818cf8',
  text: '#e8eef6', muted: '#9fb0c3', faint: '#64768a',
  line: 'rgba(255,255,255,0.10)', pill: 'rgba(255,255,255,0.045)'
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/>
    </linearGradient>
    <linearGradient id="wm" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${C.teal}"/><stop offset="0.55" stop-color="${C.cyan}"/><stop offset="1" stop-color="${C.indigo}"/>
    </linearGradient>
    <radialGradient id="glowT" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.cyan}" stop-opacity="0.55"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowI" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.indigo}" stop-opacity="0.45"/><stop offset="1" stop-color="${C.indigo}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="60"/></filter>
  </defs>`

const backdrop = `
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="${W - 120}" cy="90" r="260" fill="url(#glowT)" filter="url(#soft)"/>
  <circle cx="80" cy="${H - 40}" r="240" fill="url(#glowI)" filter="url(#soft)"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="0" fill="none" stroke="${C.line}"/>`

// rounded pill with auto width from text length
function pill(x, y, label, accent) {
  const w = Math.round(label.length * 9.2 + 40)
  const h = 38
  return {
    w,
    svg: `<g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.pill}" stroke="${C.line}"/>
      <circle cx="${x + 19}" cy="${y + h / 2}" r="4" fill="${accent}"/>
      <text x="${x + 33}" y="${y + h / 2 + 5}" font-family="${FONT}" font-size="15" font-weight="600" fill="${C.text}">${esc(label)}</text>
    </g>`
  }
}
function pillRow(x, y, items) {
  let cx = x, out = ''
  const acc = [C.teal, C.cyan, C.indigo, C.teal, C.cyan]
  items.forEach((t, i) => { const p = pill(cx, y, t, acc[i % acc.length]); out += p.svg; cx += p.w + 12 })
  return out
}

// ---- 01 cover ----
const cover = `<svg width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  ${defs}${backdrop}
  <g transform="translate(76,0)">
    <text x="0" y="92" font-family="${FONT}" font-size="14" font-weight="700" letter-spacing="3" fill="${C.faint}">DESKTOP · AGENTIC · OPEN SOURCE</text>
    <text x="-2" y="196" font-family="${FONT}" font-size="96" font-weight="800" fill="url(#wm)">DeepCode</text>
    <text x="0" y="252" font-family="${FONT}" font-size="33" font-weight="700" fill="${C.text}">Agentic coding — as a desktop app.</text>
    <text x="0" y="300" font-family="${FONT}" font-size="20" fill="${C.muted}">It doesn't just suggest code — it reads, writes &amp; refactors files, runs tests,</text>
    <text x="0" y="328" font-family="${FONT}" font-size="20" fill="${C.muted}">automates work on a visual canvas, and runs autonomous, verify-gated missions.</text>
    ${pillRow(0, 392, ['Visual Workflows', 'Autonomous Missions', 'Swarm', 'Run Traces', '31 MCP Connectors'])}
    <line x1="0" y1="486" x2="1048" y2="486" stroke="${C.line}"/>
    <text x="0" y="536" font-family="${FONT}" font-size="18" font-weight="700" fill="${C.cyan}">github.com/MauricePutinas/deepcode</text>
    <text x="1048" y="536" text-anchor="end" font-family="${FONT}" font-size="16" fill="${C.muted}">Electron · React · TypeScript · 394 tests · CI · multi-model · local</text>
  </g>
</svg>`

// ---- 02 highlights ----
const cards = [
  ['Agent loop', 'Reads / writes / edits / patches files, shell, git, web-fetch, sub-agents, live cost.'],
  ['Visual workflow builder', '20 node types, cron + file-watch triggers, self-healing, run-from-chat.'],
  ['Mission Control', 'Set a goal — autonomous, verify-gated execution of a plan tree.'],
  ['Swarm', 'Parallel agents, each in its own isolated git worktree + branch.'],
  ['Run traces', 'Every turn as a cost / latency tree + waterfall, per-call tokens.'],
  ['MCP marketplace', '31 curated connectors, one-click activate. Skills · Hooks · Memory.']
]
const PADX = 64, GAP = 26, COLS = 3, ROWS = 2
const CW = Math.round((W - PADX * 2 - GAP * (COLS - 1)) / COLS)
const CH = 150, TOP = 196
const acc = [C.teal, C.cyan, C.indigo]
function card(i) {
  const r = Math.floor(i / COLS), c = i % COLS
  const x = PADX + c * (CW + GAP), y = TOP + r * (CH + GAP)
  const [title, desc] = cards[i]
  const a = acc[(r + c) % 3]
  // wrap desc to ~ width
  const words = desc.split(' '); const lines = ['']; const max = 38
  for (const w of words) { if ((lines[lines.length - 1] + ' ' + w).trim().length > max) lines.push(w); else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w).trim() }
  const descSvg = lines.slice(0, 3).map((l, k) => `<text x="${x + 24}" y="${y + 86 + k * 22}" font-family="${FONT}" font-size="15" fill="${C.muted}">${esc(l)}</text>`).join('')
  return `<g>
    <rect x="${x}" y="${y}" width="${CW}" height="${CH}" rx="16" fill="${C.pill}" stroke="${C.line}"/>
    <rect x="${x}" y="${y}" width="4" height="${CH}" rx="2" fill="${a}"/>
    <circle cx="${x + 30}" cy="${y + 34}" r="6" fill="${a}"/>
    <text x="${x + 48}" y="${y + 40}" font-family="${FONT}" font-size="20" font-weight="700" fill="${C.text}">${esc(title)}</text>
    ${descSvg}
  </g>`
}
const highlights = `<svg width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  ${defs}${backdrop}
  <text x="${PADX}" y="92" font-family="${FONT}" font-size="14" font-weight="700" letter-spacing="3" fill="${C.faint}">WHAT IT DOES</text>
  <text x="${PADX - 2}" y="150" font-family="${FONT}" font-size="46" font-weight="800" fill="${C.text}">Built like a <tspan fill="url(#wm)">product</tspan>, not a demo</text>
  ${cards.map((_, i) => card(i)).join('')}
</svg>`

await sharp(Buffer.from(cover)).png().toFile(`${OUT}/01-cover.png`)
await sharp(Buffer.from(highlights)).png().toFile(`${OUT}/02-highlights.png`)
console.log('DONE →', OUT)
