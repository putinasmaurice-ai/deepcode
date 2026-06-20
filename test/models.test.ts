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
})
