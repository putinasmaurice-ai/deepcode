import { describe, it, expect } from 'vitest'
import { cronMatches } from '../src/main/systems/automations'

// 2026-06-15 is a Monday; use fixed local Dates to keep the test deterministic.
const mondayMorning = new Date(2026, 5, 15, 9, 0)
const mondayOdd = new Date(2026, 5, 15, 9, 30)

describe('cronMatches (min hour dom mon dow)', () => {
  it('matches a wildcard expression always', () => {
    expect(cronMatches('* * * * *', mondayMorning)).toBe(true)
  })

  it('matches an exact minute/hour', () => {
    expect(cronMatches('0 9 * * *', mondayMorning)).toBe(true)
    expect(cronMatches('30 9 * * *', mondayMorning)).toBe(false)
    expect(cronMatches('30 9 * * *', mondayOdd)).toBe(true)
  })

  it('handles step values', () => {
    expect(cronMatches('*/30 * * * *', mondayMorning)).toBe(true) // minute 0
    expect(cronMatches('*/30 * * * *', mondayOdd)).toBe(true) // minute 30
    expect(cronMatches('*/30 * * * *', new Date(2026, 5, 15, 9, 15))).toBe(false)
  })

  it('handles ranges and lists', () => {
    expect(cronMatches('0 8-10 * * *', mondayMorning)).toBe(true)
    expect(cronMatches('0 11,12 * * *', mondayMorning)).toBe(false)
  })

  it('matches weekday (Monday = 1)', () => {
    expect(cronMatches('0 9 * * 1', mondayMorning)).toBe(true)
    expect(cronMatches('0 9 * * 0', mondayMorning)).toBe(false)
  })

  it('rejects malformed expressions', () => {
    expect(cronMatches('* * *', mondayMorning)).toBe(false)
  })
})
