import { describe, it, expect } from 'vitest'
import { contextLimit, modelLabel, modelOrder, MODEL_DISPLAY } from '../src/shared/models'

describe('contextLimit', () => {
  it('knows DeepSeek = 64K', () => {
    expect(contextLimit('deepseek-chat')).toBe(64_000)
    expect(contextLimit('deepseek-reasoner')).toBe(64_000)
  })

  it('strips the local: routing prefix', () => {
    expect(contextLimit('local:qwen3-coder:30b')).toBe(256_000)
    expect(contextLimit('local:dolphin3')).toBe(32_000)
  })

  it('falls back to a conservative default for unknown models', () => {
    expect(contextLimit('some-mystery-model')).toBe(32_000)
    expect(contextLimit(undefined)).toBe(32_000)
  })

  it('matches big windows for frontier models', () => {
    expect(contextLimit('claude-opus-4')).toBe(200_000)
    expect(contextLimit('gpt-4o')).toBe(128_000)
  })

  it('knows the JetBrains Mellum windows (Mellum 2 = 128K, original 4b = 8K)', () => {
    expect(contextLimit('local:mellum2')).toBe(131_072)
    expect(contextLimit('local:JetBrains/Mellum2-12B-A2.5B-Thinking')).toBe(131_072)
    expect(contextLimit('local:JetBrains/Mellum-4b-base')).toBe(8_192) // original ≠ Mellum 2
  })

  it('knows the Xiaomi MiMo window (mimo: token-plan AND deepinfra: route)', () => {
    expect(contextLimit('mimo:mimo-v2.5-pro')).toBe(128_000)
    expect(contextLimit('mimo:mimo-v2.5')).toBe(128_000)
    expect(contextLimit('deepinfra:XiaomiMiMo/MiMo-V2.5-Pro')).toBe(128_000)
  })

  it('strips ANY routing prefix so a gateway-routed model gets the underlying window', () => {
    expect(contextLimit('kilo:anthropic/claude-sonnet-4')).toBe(200_000) // claude window via prefix strip
    expect(contextLimit('together:meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe(32_000)
    expect(contextLimit('kilo:kilo/auto')).toBe(32_000) // unknown router id → conservative default
  })

  it('knows the Z.ai GLM windows (GLM-5.x = 1M, 4.6 = 200K)', () => {
    expect(contextLimit('deepinfra:zai-org/GLM-5.2')).toBe(1_000_000)
    expect(contextLimit('deepinfra:zai-org/GLM-5')).toBe(1_000_000)
    expect(contextLimit('deepinfra:zai-org/GLM-4.6')).toBe(200_000)
    expect(contextLimit('deepinfra:zai-org/GLM-4.5')).toBe(128_000) // not the 1M GLM-5 line
  })

  it('knows the Google Gemma windows (Gemma 4 = 256K, Gemma 3 = 128K)', () => {
    expect(contextLimit('deepinfra:google/gemma-4-31B-it')).toBe(262_144)
    expect(contextLimit('deepinfra:google/gemma-3-27b-it')).toBe(128_000)
  })

  it('knows Qwen3-Coder (256K) and Kimi K2.x (256K) windows', () => {
    expect(contextLimit('deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo')).toBe(256_000)
    expect(contextLimit('deepinfra:moonshotai/Kimi-K2.6')).toBe(262_144)
  })

  it('strips the openrouter: prefix and knows the new value-pick windows', () => {
    expect(contextLimit('openrouter:xiaomi/mimo-v2.5-pro')).toBe(128_000)
    expect(contextLimit('openrouter:deepseek/deepseek-v4-flash')).toBe(1_000_000) // V4 Flash 1M, not V3 64K
    expect(contextLimit('openrouter:z-ai/glm-4.7-flash')).toBe(204_800) // 4.7 ≠ generic GLM 128K
    expect(contextLimit('openrouter:qwen/qwen3-coder-flash')).toBe(1_000_000) // Flash 1M ≠ Coder-480B 256K
    expect(contextLimit('openrouter:x-ai/grok-4.1-fast')).toBe(2_000_000)
    expect(contextLimit('openrouter:openai/gpt-oss-20b')).toBe(131_072)
    expect(contextLimit('openrouter:openai/gpt-oss-120b:free')).toBe(131_072)
    expect(contextLimit('openrouter:qwen/qwen3-235b-a22b-2507')).toBe(262_144)
  })

  it('knows the OpenRouter flagship windows (Grok 4.3 = 1M ≠ 4.1-Fast 2M, MiniMax M3 = 1M ≠ M2)', () => {
    expect(contextLimit('openrouter:x-ai/grok-4.3')).toBe(1_000_000)
    expect(contextLimit('openrouter:x-ai/grok-4.1-fast')).toBe(2_000_000) // still 2M
    expect(contextLimit('openrouter:minimax/minimax-m3')).toBe(1_048_576)
    expect(contextLimit('openrouter:moonshotai/kimi-k2.7-code')).toBe(262_144)
  })
})

describe('modelLabel — curated dropdown display names (exact casing)', () => {
  it('resolves same-named models on different providers distinctly (no collision)', () => {
    expect(modelLabel('deepinfra:deepseek-ai/DeepSeek-V4-Flash')).toBe('DI DeepSeek v4 Flash')
    expect(modelLabel('openrouter:deepseek/deepseek-v4-flash')).toBe('OR DeepSeek v4 Flash')
    expect(modelLabel('deepinfra:openai/gpt-oss-120b')).toBe('DI GPT 120b')
    expect(modelLabel('openrouter:openai/gpt-oss-120b:free')).toBe('OR GPT 120b')
  })

  it('preserves the exact casing the user specified', () => {
    expect(modelLabel('deepseek-chat')).toBe('DeepSeek v4 Flash official') // lowercase v + official
    expect(modelLabel('openrouter:xiaomi/mimo-v2.5-pro')).toBe('OR Mimo 2.5 Pro') // "Mimo", trimmed
    expect(modelLabel('openrouter:minimax/minimax-m3')).toBe('OR MiniMax M3') // camelCase MiniMax
    expect(modelLabel('local:huihui_ai/qwen2.5-abliterate:14b')).toBe('Lokal Qwen 2.5 uncensored') // lowercase uncensored
    expect(modelLabel('openrouter:moonshotai/kimi-k2.7-code')).toBe('OR Kimi 2.7 Code') // capital Code
    expect(modelLabel('deepinfra:Qwen/Qwen3-VL-235B-A22B-Instruct')).toMatch(/Vision/) // flagged as a vision model, not a coder
  })

  it('falls back to a provider-icon + raw id for unknown models', () => {
    expect(modelLabel('deepinfra:some/unknown-model')).toBe('☁️ some/unknown-model')
    expect(modelLabel('local:whatever:7b')).toBe('💻 whatever:7b')
    expect(modelLabel('totally-unknown')).toBe('totally-unknown')
  })

  it('orders curated models in the user-specified sequence, unknowns last (stable)', () => {
    const shuffled = ['kilo:kilo/auto', 'zzz-unknown', 'deepseek-chat', 'openrouter:x-ai/grok-4.3', 'deepinfra:zai-org/GLM-5.2']
    const sorted = [...shuffled].sort((a, b) => modelOrder(a) - modelOrder(b))
    expect(sorted).toEqual(['deepseek-chat', 'deepinfra:zai-org/GLM-5.2', 'openrouter:x-ai/grok-4.3', 'kilo:kilo/auto', 'zzz-unknown'])
  })

  it('every curated label is unique and the list starts/ends as specified', () => {
    const labels = MODEL_DISPLAY.map((m) => m.label)
    expect(new Set(labels).size).toBe(labels.length) // no duplicate labels
    expect(labels[0]).toBe('DeepSeek v4 Flash official')
    expect(labels[labels.length - 1]).toBe('Kilo/Auto')
    expect(MODEL_DISPLAY).toHaveLength(25) // grok-4.1-fast removed (deprecated on OpenRouter → 404)
  })
})
