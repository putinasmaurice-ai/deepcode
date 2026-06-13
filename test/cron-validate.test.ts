import { describe, it, expect } from 'vitest'
import { isValidCron } from '../src/shared/workflows'
import { cronMatches } from '../src/main/systems/automations'

// #11 — validation must reject expressions the matcher can never fire (was: field-count only).
describe('isValidCron', () => {
  it('accepts valid expressions', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('*/15 * * * 1-5')).toBe(true)
    expect(isValidCron('0 0 1 1 *')).toBe(true)
    expect(isValidCron('0 9 * * 7')).toBe(true) // 7 = Sunday allowed
  })
  it('rejects out-of-range / bad-step / wrong-field-count', () => {
    expect(isValidCron('99 9 * * *')).toBe(false) // minute > 59
    expect(isValidCron('0 9 32 * *')).toBe(false) // day 32
    expect(isValidCron('*/0 * * * *')).toBe(false) // step 0
    expect(isValidCron('0 9 * *')).toBe(false) // 4 fields
    expect(isValidCron('0 9 * * 8')).toBe(false) // dow 8
    expect(isValidCron('5-1 * * * *')).toBe(false) // lo > hi
  })
})

// #18 — dow 7 = Sunday, and a stepped single value (5/15) expands to value..max.
describe('cronMatches edge cases', () => {
  const sunday9am = new Date(2026, 5, 14, 9, 0, 0) // 2026-06-14 is a Sunday, getDay()===0
  it('matches dow 7 on Sunday', () => {
    expect(cronMatches('0 9 * * 7', sunday9am)).toBe(true)
    expect(cronMatches('0 9 * * 0', sunday9am)).toBe(true)
  })
  it('expands a stepped single value (5/15 → 5,20,35,50)', () => {
    expect(cronMatches('5/15 * * * *', new Date(2026, 5, 14, 9, 20, 0))).toBe(true) // 20 = 5+15
    expect(cronMatches('5/15 * * * *', new Date(2026, 5, 14, 9, 35, 0))).toBe(true) // 35 = 5+30
    expect(cronMatches('5/15 * * * *', new Date(2026, 5, 14, 9, 6, 0))).toBe(false) // 6 not in series
  })
  it('a step of 0 never matches (no NaN crash)', () => {
    expect(cronMatches('*/0 * * * *', new Date(2026, 5, 14, 9, 0, 0))).toBe(false)
  })
})
