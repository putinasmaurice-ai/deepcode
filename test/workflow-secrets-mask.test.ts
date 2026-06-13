import { describe, it, expect, vi } from 'vitest'

// secrets.ts imports electron's safeStorage at module top — stub it so we can unit-test the
// pure masking helpers without an Electron runtime.
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

import { buildMaskList, maskWith } from '../src/main/workflows/secrets'

describe('secret masking', () => {
  it('includes values >=8 chars + encoded variants, excludes short ones, longest-first', () => {
    const list = buildMaskList({ A: 'supersecret123', SHORT: 'abc', B: 'token-with-dash!' })
    expect(list).toContain('supersecret123')
    expect(list).toContain(encodeURIComponent('token-with-dash!'))
    expect(list).toContain(Buffer.from('supersecret123').toString('base64'))
    expect(list).not.toContain('abc') // <8 → not masked (avoid corrupting unrelated output)
    // longest-first ordering so an overlapping shorter value can't pre-empt a longer one
    for (let i = 1; i < list.length; i++) expect(list[i - 1].length).toBeGreaterThanOrEqual(list[i].length)
  })

  it('masks verbatim and encoded occurrences with literal (regex-safe) replace', () => {
    const secret = 's3cr3t-value.+*' // contains regex metachars
    const list = buildMaskList({ TOK: secret })
    expect(maskWith(list, `Authorization: Bearer ${secret}`)).toBe('Authorization: Bearer •••')
    // encoded echo is masked too
    expect(maskWith(list, `url?x=${encodeURIComponent(secret)}`)).toBe('url?x=•••')
    // unrelated text untouched
    expect(maskWith(list, 'nothing here')).toBe('nothing here')
  })

  it('is a no-op when there are no secrets', () => {
    expect(maskWith([], 'plain text')).toBe('plain text')
  })
})
