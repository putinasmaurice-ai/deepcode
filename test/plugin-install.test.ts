import { describe, it, expect } from 'vitest'
import { parsePluginRepoUrl, pluginCloneArgs } from '../src/main/plugin-install'

describe('parsePluginRepoUrl — host/scheme allowlist + path-safe name', () => {
  it('accepts allowed https repo URLs and derives the repo name', () => {
    expect(parsePluginRepoUrl('https://github.com/owner/my-plugin')).toBe('my-plugin')
    expect(parsePluginRepoUrl('https://github.com/owner/my-plugin.git')).toBe('my-plugin')
    expect(parsePluginRepoUrl('https://gitlab.com/group/tool/')).toBe('tool')
    expect(parsePluginRepoUrl('https://codeberg.org/u/repo.v2')).toBe('repo.v2')
  })
  it('rejects non-https and non-allowlisted hosts (no SSRF/arbitrary clone source)', () => {
    expect(parsePluginRepoUrl('http://github.com/o/r')).toBeNull() // not https
    expect(parsePluginRepoUrl('https://evil.com/o/r')).toBeNull() // host not allowlisted
    expect(parsePluginRepoUrl('git@github.com:o/r.git')).toBeNull() // ssh
    expect(parsePluginRepoUrl('file:///etc/passwd')).toBeNull()
  })
  it('rejects traversal / unsafe derived names (the name becomes a dir under plugins/)', () => {
    expect(parsePluginRepoUrl('https://github.com/owner/..')).toBeNull() // would resolve to plugins/ parent
    expect(parsePluginRepoUrl('https://github.com/owner/.')).toBeNull()
    expect(parsePluginRepoUrl('https://github.com/owner/...')).toBeNull()
  })
  it('rejects malformed input without throwing', () => {
    expect(parsePluginRepoUrl('')).toBeNull()
    expect(parsePluginRepoUrl('not a url')).toBeNull()
    // @ts-expect-error non-string input must be rejected, not throw
    expect(parsePluginRepoUrl(undefined)).toBeNull()
    // @ts-expect-error non-string input must be rejected, not throw
    expect(parsePluginRepoUrl(123)).toBeNull()
  })
})

describe('pluginCloneArgs — hardened clone argv', () => {
  it('is shallow, no-tags, and blocks file transport + submodule recursion', () => {
    const args = pluginCloneArgs('https://github.com/o/r', '/dest/r')
    expect(args).toContain('--depth')
    expect(args).toContain('1')
    expect(args).toContain('--no-tags')
    expect(args).toContain('protocol.file.allow=never')
    expect(args).toContain('submodule.recurse=false')
    expect(args[args.length - 1]).toBe('/dest/r') // dest is last
  })
})
