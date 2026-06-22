// DeepSeek off-peak discount window (UTC 16:30–00:30): chat ~-50%, reasoner ~-75%.
// Pure + shared so both the engine/night-shift (main) and the Crystal Ball (renderer)
// agree on the window and the countdown.

const START_MIN = 16 * 60 + 30 // 16:30 UTC
const END_MIN = 30 // 00:30 UTC (next day)

export interface OffPeakStatus {
  active: boolean
  // minutes until the window opens (when inactive) or closes (when active)
  minutesUntilChange: number
  chatDiscount: number // fraction off, e.g. 0.5 = -50%
  reasonerDiscount: number
}

export function offPeakStatus(now: Date = new Date()): OffPeakStatus {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()
  const active = mins >= START_MIN || mins < END_MIN
  let minutesUntilChange: number
  if (active) {
    // time until the window closes at 00:30 UTC
    minutesUntilChange = mins < END_MIN ? END_MIN - mins : 24 * 60 + END_MIN - mins
  } else {
    // time until it opens at 16:30 UTC
    minutesUntilChange = START_MIN - mins
  }
  return { active, minutesUntilChange, chatDiscount: 0.5, reasonerDiscount: 0.75 }
}

export function inOffPeak(now: Date = new Date()): boolean {
  return offPeakStatus(now).active
}

// The off-peak discount is DeepSeek's FIRST-PARTY pricing perk: it applies ONLY to the bare DeepSeek
// route (no provider prefix). A prefixed model — deepinfra:/openrouter:/mimo:/google:/… — is billed
// by THAT vendor and never gets the discount, even a DeepSeek model HOSTED elsewhere
// (e.g. openrouter:deepseek/…). Single source of truth for both the cost calc and the UI banner.
const VENDOR_PREFIX_RE = /^(local|google|deepinfra|openai|together|mimo|kilo|openrouter):/i
export function offPeakEligible(model: string | undefined): boolean {
  if (!model) return true // the default route is the first-party DeepSeek API
  if (VENDOR_PREFIX_RE.test(model)) return false
  return /deepseek/i.test(model)
}
