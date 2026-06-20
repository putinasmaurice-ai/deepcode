import { describe, it, expect } from 'vitest'
import { costOf } from '../src/main/agent/pricing'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const p = DEFAULT_SETTINGS.provider
const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }
// fixed times so the off-peak discount can't make these assertions wall-clock-dependent.
const PEAK = Date.UTC(2026, 0, 1, 12, 0) // 12:00 UTC — outside the 16:30–00:30 window
const OFFPEAK = Date.UTC(2026, 0, 1, 20, 0) // 20:00 UTC — inside the window

describe('costOf', () => {
  it('uses chat prices for the chat model (peak)', () => {
    const c = costOf(p, usage, 'deepseek-chat', PEAK)
    expect(c.cost).toBeCloseTo(p.pricePerMillionInput + p.pricePerMillionOutput, 6)
  })

  it('uses reasoner prices for the reasoner model (peak)', () => {
    const c = costOf(p, usage, 'deepseek-reasoner', PEAK)
    expect(c.cost).toBeCloseTo(p.reasonerPricePerMillionInput + p.reasonerPricePerMillionOutput, 6)
  })

  it('charges nothing for local models', () => {
    expect(costOf(p, usage, 'local:dolphin3', PEAK).cost).toBe(0)
  })

  it('reasoner is more expensive than chat for the same tokens', () => {
    expect(costOf(p, usage, 'deepseek-reasoner', PEAK).cost).toBeGreaterThan(
      costOf(p, usage, 'deepseek-chat', PEAK).cost
    )
  })

  it('bills prompt-cache hits cheaper than fresh prompt tokens', () => {
    const allFresh = costOf(p, usage, 'deepseek-chat', PEAK)
    const allCached = costOf(p, { ...usage, cachedPromptTokens: usage.promptTokens }, 'deepseek-chat', PEAK)
    expect(allCached.cost).toBeLessThan(allFresh.cost)
    expect(allCached.cost).toBeCloseTo((p.cachedPricePerMillionInput ?? 0) + p.pricePerMillionOutput, 6)
  })

  it('never bills more cached tokens than total prompt tokens', () => {
    const c = costOf(p, { ...usage, cachedPromptTokens: 5_000_000 }, 'deepseek-chat', PEAK)
    expect(Number.isFinite(c.cost)).toBe(true)
    expect(c.cost).toBeGreaterThan(0)
  })

  // #4 — off-peak discount applied to the recorded cost (DeepSeek only)
  it('applies the off-peak discount to DeepSeek chat (-50%) and reasoner (-75%)', () => {
    const chatPeak = costOf(p, usage, 'deepseek-chat', PEAK).cost
    const chatOff = costOf(p, usage, 'deepseek-chat', OFFPEAK).cost
    expect(chatOff).toBeCloseTo(chatPeak * 0.5, 6)

    const rPeak = costOf(p, usage, 'deepseek-reasoner', PEAK).cost
    const rOff = costOf(p, usage, 'deepseek-reasoner', OFFPEAK).cost
    expect(rOff).toBeCloseTo(rPeak * 0.25, 6)
  })

  // #5 — non-DeepSeek vendors priced with THEIR card, not DeepSeek's, and no off-peak discount
  it('prices deepinfra: models with the DeepInfra card (flat, no off-peak)', () => {
    const expected = (p.deepinfraPricePerMillionInput ?? 0) + (p.deepinfraPricePerMillionOutput ?? 0)
    expect(costOf(p, usage, 'deepinfra:openai/gpt-oss-120b', PEAK).cost).toBeCloseTo(expected, 6)
    // off-peak must NOT discount a non-DeepSeek vendor
    expect(costOf(p, usage, 'deepinfra:openai/gpt-oss-120b', OFFPEAK).cost).toBeCloseTo(expected, 6)
    // and it must differ from DeepSeek's card
    expect(costOf(p, usage, 'deepinfra:openai/gpt-oss-120b', PEAK).cost).not.toBeCloseTo(
      costOf(p, usage, 'deepseek-chat', PEAK).cost,
      6
    )
  })

  it('prices google: models with the Google card', () => {
    const expected = (p.googlePricePerMillionInput ?? 0) + (p.googlePricePerMillionOutput ?? 0)
    expect(costOf(p, usage, 'google:gemini-2.5-flash-lite', OFFPEAK).cost).toBeCloseTo(expected, 6)
  })

  it('prices mimo: models with the MiMo card (free token plan → 0, never DeepSeek/off-peak)', () => {
    const expected = (p.mimoPricePerMillionInput ?? 0) + (p.mimoPricePerMillionOutput ?? 0)
    expect(costOf(p, usage, 'mimo:mimo-v2.5-pro', PEAK).cost).toBeCloseTo(expected, 6)
    expect(costOf(p, usage, 'mimo:mimo-v2.5-pro', OFFPEAK).cost).toBe(0) // default free plan, no off-peak
  })

  it('prices kilo: models with the Kilo card (free default → 0, no off-peak)', () => {
    const expected = (p.kiloPricePerMillionInput ?? 0) + (p.kiloPricePerMillionOutput ?? 0)
    expect(costOf(p, usage, 'kilo:kilo/auto', PEAK).cost).toBeCloseTo(expected, 6)
    expect(costOf(p, usage, 'kilo:anthropic/claude-sonnet-4', OFFPEAK).cost).toBe(0) // default free, no off-peak
  })
})
