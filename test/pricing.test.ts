import { describe, it, expect } from 'vitest'
import { costOf } from '../src/main/agent/pricing'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const p = DEFAULT_SETTINGS.provider
const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }

describe('costOf', () => {
  it('uses chat prices for the chat model', () => {
    const c = costOf(p, usage, 'deepseek-chat')
    expect(c.cost).toBeCloseTo(p.pricePerMillionInput + p.pricePerMillionOutput, 6)
  })

  it('uses reasoner prices for the reasoner model', () => {
    const c = costOf(p, usage, 'deepseek-reasoner')
    expect(c.cost).toBeCloseTo(p.reasonerPricePerMillionInput + p.reasonerPricePerMillionOutput, 6)
  })

  it('charges nothing for local models', () => {
    expect(costOf(p, usage, 'local:dolphin3').cost).toBe(0)
  })

  it('reasoner is more expensive than chat for the same tokens', () => {
    expect(costOf(p, usage, 'deepseek-reasoner').cost).toBeGreaterThan(
      costOf(p, usage, 'deepseek-chat').cost
    )
  })
})
