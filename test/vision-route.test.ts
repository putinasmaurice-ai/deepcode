import { describe, it, expect } from 'vitest'
import { localVisionId, chooseVisionModel } from '../src/main/agent/vision-route'

// The security invariant: selecting LOKAL (or the no-key online fallback) must NEVER produce a
// non-local model id, or the image bytes would be shipped to the cloud via the DeepSeek/Google
// endpoint instead of staying on the local Ollama box.
describe('localVisionId — always coerces to a routable local: id', () => {
  it('keeps an explicit local: id', () => {
    expect(localVisionId('local:qwen2.5vl:7b')).toBe('local:qwen2.5vl:7b')
  })
  it('prefixes a bare model name', () => {
    expect(localVisionId('llava')).toBe('local:llava')
  })
  it('rewrites a mistyped google: id into the local field to local: (no cloud leak)', () => {
    expect(localVisionId('google:gemini-2.5-flash-lite')).toBe('local:gemini-2.5-flash-lite')
  })
  it('falls back to the default local model on empty/whitespace', () => {
    expect(localVisionId('')).toBe('local:qwen2.5vl:7b')
    expect(localVisionId('   ')).toBe('local:qwen2.5vl:7b')
    expect(localVisionId(undefined)).toBe('local:qwen2.5vl:7b')
  })
})

describe('chooseVisionModel — routing decision', () => {
  it('routes ONLINE + key to Gemini (google:)', () => {
    const r = chooseVisionModel({ visionMode: 'online', visionModel: 'local:llava', onlineVisionModel: 'gemini-2.5-flash-lite', hasGoogleKey: true })
    expect(r.modelId).toBe('google:gemini-2.5-flash-lite')
    expect(r.usedLocalFallback).toBe(false)
  })
  it('defaults the online model id when none configured', () => {
    const r = chooseVisionModel({ visionMode: 'online', visionModel: undefined, onlineVisionModel: '', hasGoogleKey: true })
    expect(r.modelId).toBe('google:gemini-2.5-flash-lite')
  })
  it('falls back to LOCAL when ONLINE is selected but no Google key is set', () => {
    const r = chooseVisionModel({ visionMode: 'online', visionModel: 'llava', onlineVisionModel: 'gemini', hasGoogleKey: false })
    expect(r.modelId).toBe('local:llava')
    expect(r.usedLocalFallback).toBe(true)
  })
  it('routes LOKAL to a local: id even if a google: id was typed into the local field', () => {
    const r = chooseVisionModel({ visionMode: 'local', visionModel: 'google:gemini-2.5-flash-lite', onlineVisionModel: '', hasGoogleKey: true })
    expect(r.modelId).toBe('local:gemini-2.5-flash-lite') // NEVER google:, even with a key present
    expect(r.usedLocalFallback).toBe(false)
  })
})
