import { describe, it, expect } from 'vitest'
import { offPeakStatus, offPeakEligible } from '../src/shared/offpeak'

// helper: a Date at a given UTC hour/min
const utc = (h: number, m: number): Date => new Date(Date.UTC(2026, 5, 15, h, m))

describe('offPeakStatus (UTC 16:30–00:30 window)', () => {
  it('is active inside the window', () => {
    expect(offPeakStatus(utc(17, 0)).active).toBe(true) // evening
    expect(offPeakStatus(utc(0, 10)).active).toBe(true) // just after midnight
    expect(offPeakStatus(utc(16, 30)).active).toBe(true) // exact open
  })

  it('is inactive outside the window', () => {
    expect(offPeakStatus(utc(12, 0)).active).toBe(false) // midday
    expect(offPeakStatus(utc(0, 30)).active).toBe(false) // exact close
    expect(offPeakStatus(utc(16, 29)).active).toBe(false) // one minute before open
  })

  it('counts minutes until the window opens when inactive', () => {
    expect(offPeakStatus(utc(16, 0)).minutesUntilChange).toBe(30) // 30 min to 16:30
    expect(offPeakStatus(utc(12, 0)).minutesUntilChange).toBe(4 * 60 + 30)
  })

  it('counts minutes until the window closes when active', () => {
    expect(offPeakStatus(utc(0, 0)).minutesUntilChange).toBe(30) // 30 min to 00:30
    expect(offPeakStatus(utc(23, 30)).minutesUntilChange).toBe(60) // 23:30 -> 00:30
    expect(offPeakStatus(utc(16, 30)).minutesUntilChange).toBe(8 * 60) // open -> close = 8h
  })

  it('exposes the discount fractions', () => {
    const s = offPeakStatus(utc(17, 0))
    expect(s.chatDiscount).toBeGreaterThan(0)
    expect(s.reasonerDiscount).toBeGreaterThan(s.chatDiscount)
  })
})

describe('offPeakEligible — off-peak applies ONLY to the first-party DeepSeek route', () => {
  it('is true for the bare DeepSeek route (and the default/undefined route)', () => {
    expect(offPeakEligible('deepseek-chat')).toBe(true)
    expect(offPeakEligible('deepseek-reasoner')).toBe(true)
    expect(offPeakEligible(undefined)).toBe(true) // default route = first-party DeepSeek
  })

  it('is false for ANY prefixed model — including DeepSeek HOSTED elsewhere', () => {
    expect(offPeakEligible('mimo:mimo-v2.5-pro')).toBe(false) // the user's exact case
    expect(offPeakEligible('deepinfra:deepseek-ai/DeepSeek-V4-Flash')).toBe(false) // hosted DeepSeek ≠ first-party
    expect(offPeakEligible('openrouter:deepseek/deepseek-v4-flash')).toBe(false) // contains "deepseek" but prefixed
    expect(offPeakEligible('openrouter:x-ai/grok-4.3')).toBe(false)
    expect(offPeakEligible('local:qwen3-coder:30b')).toBe(false)
    expect(offPeakEligible('kilo:kilo/auto')).toBe(false)
  })

  it('is false for a bare non-DeepSeek custom model', () => {
    expect(offPeakEligible('my-custom-llm')).toBe(false)
  })
})
