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

  it('treats day-of-month and day-of-week as OR when both are restricted', () => {
    // 2026-06-15 is the 15th and a Monday. "1st OR Monday" must fire on a Monday
    // even though it is not the 1st (standard crontab OR semantics).
    expect(cronMatches('0 9 1 * 1', mondayMorning)).toBe(true) // matches via Monday
    expect(cronMatches('0 9 15 * 0', mondayMorning)).toBe(true) // matches via the 15th
    expect(cronMatches('0 9 2 * 0', mondayMorning)).toBe(false) // neither the 2nd nor Sunday
    // when only one day field is restricted it still applies (AND with *)
    expect(cronMatches('0 9 15 * *', mondayMorning)).toBe(true)
    expect(cronMatches('0 9 16 * *', mondayMorning)).toBe(false)
  })
})
