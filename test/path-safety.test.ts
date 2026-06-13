import { describe, it, expect } from 'vitest'
import { safeId } from '../src/main/paths'
import { isPrivateIp } from '../src/main/agent/tools/web'
import { previewToolDiff } from '../src/main/preview-diff'

// #2 — the chokepoint that keeps a renderer-supplied id from traversing into unlink/rmSync.
describe('safeId', () => {
  it('accepts uuid-style ids', () => {
    expect(safeId('a1b2c3d4-0000-4111-8222-deadbeef0001')).toBeTruthy()
    expect(safeId('New_session-2')).toBeTruthy()
  })
  it('rejects traversal / separators / empties', () => {
    for (const bad of ['../sessions/x', '..\\..\\settings', 'a/b', 'a\\b', '..', '.', '', 'a b', 'a.b']) {
      expect(() => safeId(bad)).toThrow(/invalid id/)
    }
  })
})

// #15 — SSRF IPv6 bypasses (NAT64 + 6to4 embedding loopback/metadata).
describe('isPrivateIp', () => {
  it('blocks loopback/private/link-local (existing)', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('169.254.169.254')).toBe(true)
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true)
  })
  it('blocks NAT64 (64:ff9b::/96) and 6to4 (2002::/16) that embed v4', () => {
    expect(isPrivateIp('64:ff9b::7f00:1')).toBe(true) // 127.0.0.1
    expect(isPrivateIp('2002:7f00:1::')).toBe(true) // 127.0.0.1
    expect(isPrivateIp('2002:a9fe:a9fe::')).toBe(true) // 169.254.169.254
  })
  it('allows a normal public address', () => {
    expect(isPrivateIp('93.184.216.34')).toBe(false) // example.com
    expect(isPrivateIp('2606:2800:220:1::')).toBe(false) // global unicast
  })
})

// #3 — preview must not read files outside the allowed roots.
describe('previewToolDiff path guard', () => {
  it('returns "Zugriff verweigert" when the path is not allowed', () => {
    const out = previewToolDiff('write_file', JSON.stringify({ path: '/etc/passwd', content: '' }), '/tmp', () => false)
    expect(out).toMatch(/verweigert/)
  })
  it('proceeds when the path is allowed', () => {
    // a non-existent allowed path → empty "before" → diff of the new content (no crash, not denied)
    const out = previewToolDiff('write_file', JSON.stringify({ path: 'new.txt', content: 'hi' }), '/tmp', () => true)
    expect(out).not.toMatch(/verweigert/)
  })
})
