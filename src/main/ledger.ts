import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { PATHS } from './paths'
import { Session, TokenUsage } from '@shared/types'

// Lifetime usage ledger: a persistent running total of tokens + cost that only
// ever GROWS. Deleting chats must never reduce the lifetime/monthly totals —
// the money was already spent. The per-chat/per-project breakdown still reflects
// only existing sessions, but these headline numbers come from here.

interface Ledger {
  tokens: number
  cost: number
  months: Record<string, { tokens: number; cost: number }> // 'YYYY-MM'
  days?: Record<string, { tokens: number; cost: number }> // 'YYYY-MM-DD' (for the daily spend cap)
  since: number
}

const FILE = join(PATHS.root, 'usage-ledger.json')
const KEEP_DAYS = 70
let cache: Ledger | null = null

function monthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// One-time migration: seed the ledger from whatever usage already sits in the
// stored sessions, so existing totals carry over instead of resetting to 0.
function backfill(): Ledger {
  const led: Ledger = { tokens: 0, cost: 0, months: {}, since: Date.now() }
  let files: string[] = []
  try {
    files = readdirSync(PATHS.sessions).filter((f) => f.endsWith('.json'))
  } catch {
    files = []
  }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(PATHS.sessions, f), 'utf8')) as Session
      for (const m of s.messages ?? []) {
        if (!m.usage) continue
        led.tokens += m.usage.totalTokens
        led.cost += m.usage.cost
        const k = monthKey(m.createdAt)
        const b = (led.months[k] ??= { tokens: 0, cost: 0 })
        b.tokens += m.usage.totalTokens
        b.cost += m.usage.cost
      }
    } catch {
      /* skip corrupt */
    }
  }
  console.info(
    `[ledger] no usage-ledger.json — reconstructed from ${files.length} session(s): ` +
      `${led.tokens.toLocaleString()} tokens, $${led.cost.toFixed(4)}. ` +
      `Totals are now persistent and won't drop when chats are deleted.`
  )
  return led
}

function load(): Ledger {
  if (cache) return cache
  if (existsSync(FILE)) {
    try {
      cache = JSON.parse(readFileSync(FILE, 'utf8')) as Ledger
      cache.months ??= {}
      return cache
    } catch {
      /* fall through to backfill */
    }
  }
  cache = backfill()
  persist()
  return cache
}

function persist(): void {
  if (!cache) return
  // atomic write: a torn write would corrupt the lifetime ledger; load() then falls back to
  // backfill() which can only reconstruct totals from STILL-EXISTING sessions — silently
  // violating the monotonic "totals only grow" guarantee. tmp + rename preserves the last good file.
  const tmp = `${FILE}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8')
    renameSync(tmp, FILE)
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

// Called once per billed API round (also for local models, cost 0).
export function recordUsage(usage: TokenUsage): void {
  const led = load()
  led.tokens += usage.totalTokens
  led.cost += usage.cost
  const now = Date.now()
  const m = (led.months[monthKey(now)] ??= { tokens: 0, cost: 0 })
  m.tokens += usage.totalTokens
  m.cost += usage.cost
  led.days ??= {}
  const dk = dayKey(now)
  const d = (led.days[dk] ??= { tokens: 0, cost: 0 })
  d.tokens += usage.totalTokens
  d.cost += usage.cost
  // keep the daily map bounded (it's only for the rolling cap, not lifetime totals)
  const keys = Object.keys(led.days)
  if (keys.length > KEEP_DAYS) for (const old of keys.sort().slice(0, keys.length - KEEP_DAYS)) delete led.days[old]
  persist()
}

export function todayTotals(): { tokens: number; cost: number } {
  const led = load()
  return led.days?.[dayKey(Date.now())] ?? { tokens: 0, cost: 0 }
}

// True when a positive daily cap (USD) is set and today's recorded spend has reached it. Used to
// halt UNATTENDED runs (cron/automations/night-shift) so a runaway loop can't burn money overnight.
export function overDailyCap(cap: number): boolean {
  return cap > 0 && todayTotals().cost >= cap
}

export function lifetimeTotals(): { tokens: number; cost: number } {
  const led = load()
  return { tokens: led.tokens, cost: led.cost }
}

export function monthTotals(): { tokens: number; cost: number } {
  const led = load()
  return led.months[monthKey(Date.now())] ?? { tokens: 0, cost: 0 }
}
