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

  it('prices kilo: by the underlying routed model — paid routes are not recorded as $0', () => {
    // kilo/auto routes to an unknown model → flat kilo default (free)
    const flat = (p.kiloPricePerMillionInput ?? 0) + (p.kiloPricePerMillionOutput ?? 0)
    expect(costOf(p, usage, 'kilo:kilo/auto', PEAK).cost).toBeCloseTo(flat, 6)
    // a named Claude route is priced by Anthropic rates, NOT silently $0; no off-peak
    expect(costOf(p, usage, 'kilo:anthropic/claude-sonnet-4', OFFPEAK).cost).toBeGreaterThan(0)
  })
})

describe('costOf — corrected DeepInfra per-model pricing + provider-reported cost', () => {
  const M = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }

  it('prices GLM-5.2 from the per-model table ($1 in + $4 out = $5), not the old flat $0.80', () => {
    const c = costOf(p, M, 'deepinfra:zai-org/GLM-5.2', PEAK)
    expect(c.cost).toBeCloseTo(5.0, 6)
    expect(c.cost).not.toBeCloseTo(0.8, 2)
  })

  it('prices Kimi-K2.6 by its real (higher) rate', () => {
    expect(costOf(p, M, 'deepinfra:moonshotai/Kimi-K2.6', PEAK).cost).toBeCloseTo(0.75 + 3.5, 6)
  })

  it('no longer has a DeepInfra MiMo rate (route removed) → flat deepinfra fallback', () => {
    expect(costOf(p, M, 'deepinfra:XiaomiMiMo/MiMo-V2.5-Pro', PEAK).cost).toBeCloseTo(
      (p.deepinfraPricePerMillionInput ?? 0) + (p.deepinfraPricePerMillionOutput ?? 0),
      6
    )
  })

  it('gemma-4 has NO cache discount: cached tokens cost the same as fresh', () => {
    const fresh = costOf(p, M, 'deepinfra:google/gemma-4-31B-it', PEAK).cost
    const cached = costOf(p, { ...M, cachedPromptTokens: M.promptTokens }, 'deepinfra:google/gemma-4-31B-it', PEAK).cost
    expect(fresh).toBeCloseTo(0.13 + 0.38, 6)
    expect(cached).toBeCloseTo(fresh, 6)
  })

  it('applies the cheaper cached rate for a model that publishes one (GLM-5.2)', () => {
    const fresh = costOf(p, M, 'deepinfra:zai-org/GLM-5.2', PEAK).cost
    const cached = costOf(p, { ...M, cachedPromptTokens: M.promptTokens }, 'deepinfra:zai-org/GLM-5.2', PEAK).cost
    expect(cached).toBeLessThan(fresh)
    expect(cached).toBeCloseTo(0.18 + 4.0, 6) // cached input $0.18 + output $4
  })

  it('an unknown deepinfra model falls back to the flat vendor rate', () => {
    expect(costOf(p, M, 'deepinfra:some/unknown', PEAK).cost).toBeCloseTo(
      (p.deepinfraPricePerMillionInput ?? 0) + (p.deepinfraPricePerMillionOutput ?? 0),
      6
    )
  })

  it('TRUSTS the provider-reported cost (DeepInfra estimated_cost) over the local table', () => {
    expect(costOf(p, { ...M, reportedCost: 0.1234 }, 'deepinfra:zai-org/GLM-5.2', PEAK).cost).toBe(0.1234)
  })

  it('ignores a non-positive reported cost and falls back to the table', () => {
    expect(costOf(p, { ...M, reportedCost: 0 }, 'deepinfra:zai-org/GLM-5.2', PEAK).cost).toBeCloseTo(5.0, 6)
  })

  it('does NOT bill an unknown non-DeepSeek bare model at DeepSeek rates (unpriced = 0)', () => {
    expect(costOf(p, M, 'some-random-model', PEAK).cost).toBe(0)
  })

  it('still prices the configured primary model even if it is not a deepseek id', () => {
    expect(costOf({ ...p, model: 'my-custom-llm' }, M, 'my-custom-llm', PEAK).cost).toBeGreaterThan(0)
  })

  it('trusts OpenRouter\'s reported cost (usage.cost) and falls back to ACCURATE per-model rates otherwise', () => {
    // OpenRouter returns its own cost → trusted exactly, table ignored
    expect(costOf(p, { ...M, reportedCost: 0.0072 }, 'openrouter:x-ai/grok-4.3', PEAK).cost).toBe(0.0072)
    // no reported cost + a known slug → accurate per-model fallback (never a wrong $0)
    expect(costOf(p, M, 'openrouter:xiaomi/mimo-v2.5-pro', PEAK).cost).toBeCloseTo(0.435 + 0.87, 6)
    expect(costOf(p, M, 'openrouter:google/gemini-2.5-flash-lite', PEAK).cost).toBeCloseTo(0.1 + 0.4, 6)
    // flagships (verified rates)
    expect(costOf(p, M, 'openrouter:x-ai/grok-4.3', PEAK).cost).toBeCloseTo(1.25 + 2.5, 6)
    expect(costOf(p, M, 'openrouter:minimax/minimax-m3', PEAK).cost).toBeCloseTo(0.3 + 1.2, 6)
    expect(costOf(p, M, 'openrouter:moonshotai/kimi-k2.7-code', PEAK).cost).toBeCloseTo(0.612 + 3.069, 6)
    // unknown slug → flat openrouter fallback (default 0), never DeepSeek rates / off-peak
    expect(costOf(p, M, 'openrouter:some/unknown', OFFPEAK).cost).toBeCloseTo(
      (p.openrouterPricePerMillionInput ?? 0) + (p.openrouterPricePerMillionOutput ?? 0),
      6
    )
  })

  it('honors a reported $0 on a :free route as authoritative, even when a flat openrouter rate is set', () => {
    const paid = { ...p, openrouterPricePerMillionInput: 5, openrouterPricePerMillionOutput: 5 }
    // :free + reported 0 → real $0 (NOT the flat 5/5)
    expect(costOf(paid, { ...M, reportedCost: 0 }, 'openrouter:openai/gpt-oss-120b:free', PEAK).cost).toBe(0)
    // a non-free route with reported 0 is not trusted → flat fallback
    expect(costOf(paid, { ...M, reportedCost: 0 }, 'openrouter:some/paid', PEAK).cost).toBeCloseTo(5 + 5, 6)
  })

  it('does NOT apply the DeepSeek off-peak discount to a configured non-DeepSeek primary', () => {
    const custom = { ...p, model: 'my-custom-llm' }
    const peak = costOf(custom, M, 'my-custom-llm', PEAK).cost
    const off = costOf(custom, M, 'my-custom-llm', OFFPEAK).cost
    expect(off).toBeCloseTo(peak, 6) // off-peak is DeepSeek-only; a custom endpoint must not be discounted
  })
})
