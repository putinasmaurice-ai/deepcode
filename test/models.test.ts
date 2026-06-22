import { describe, it, expect } from 'vitest'
import { contextLimit } from '../src/shared/models'

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
})
