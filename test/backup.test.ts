import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'

// Redirect ~/.deepcode to an isolated temp HOME BEFORE paths.ts loads (it reads homedir() at
// module-eval time). vi.hoisted runs before the static imports below.
const HOME = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp'
  const home = `${base}/dc-backup-test-${process.pid}`
  process.env.USERPROFILE = home // os.homedir() reads this on Windows
  process.env.HOME = home // …and this on POSIX
  return home
})

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../src/main/paths'
import { createBackup, restoreBackup } from '../src/main/backup'

const CFG = join(HOME, '.deepcode')

beforeAll(() => {
  // hard safety: if the redirect didn't take, ABORT before any write touches the real config dir
  if (PATHS.root !== CFG) throw new Error(`paths not redirected (root=${PATHS.root}) — aborting`)
  mkdirSync(join(CFG, 'memory'), { recursive: true })
  mkdirSync(join(CFG, 'workflows'), { recursive: true })
})
afterAll(() => {
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('backup / restore (MED-38)', () => {
  it('strips secrets from the exported settings', () => {
    writeFileSync(
      join(CFG, 'settings.json'),
      JSON.stringify({
        _apiKeyEnc: 'SECRETBLOB',
        visionMode: 'online',
        provider: { model: 'deepseek-chat', apiKey: 'sk-plaintext', maxTokens: 4000 }
      }),
      'utf8'
    )
    writeFileSync(join(CFG, 'memory', 'note.md'), 'hello', 'utf8')
    const b = createBackup('9.9.9', 123)
    expect(b.app).toBe('deepcode')
    expect(b.createdAt).toBe(123)
    const s = b.files['settings.json'] as Record<string, unknown>
    const prov = s.provider as Record<string, unknown>
    expect(s._apiKeyEnc).toBeUndefined() // top-level encrypted blob stripped
    expect(prov.apiKey).toBeUndefined() // plaintext key stripped
    expect(prov.model).toBe('deepseek-chat') // non-secret preserved
    expect(s.visionMode).toBe('online')
    expect(b.memory['note.md']).toBe('hello')
  })

  it('restore overlays non-secret config, keeps this machine\'s keys, and rejects traversal names', () => {
    writeFileSync(
      join(CFG, 'settings.json'),
      JSON.stringify({ _apiKeyEnc: 'KEEPME', provider: { model: 'old' } }),
      'utf8'
    )
    const bundle = {
      app: 'deepcode',
      kind: 'backup',
      version: '1',
      createdAt: 1,
      files: { 'settings.json': { provider: { model: 'restored' } }, 'projects.json': [{ id: 'p1', name: 'P' }] },
      memory: { 'good.md': 'G', '../evil.md': 'E' },
      workflows: {}
    }
    const { restored } = restoreBackup(bundle as Parameters<typeof restoreBackup>[0])
    const s = JSON.parse(readFileSync(join(CFG, 'settings.json'), 'utf8'))
    expect(s.provider.model).toBe('restored') // non-secret overlaid from backup
    expect(s._apiKeyEnc).toBe('KEEPME') // existing machine key preserved (backup carried none)
    expect(existsSync(join(CFG, 'memory', 'good.md'))).toBe(true)
    expect(restored).toContain('memory/good.md')
    expect(restored.some((r) => r.includes('evil'))).toBe(false) // traversal name rejected
    expect(existsSync(join(HOME, 'evil.md'))).toBe(false) // nothing written outside the memory dir
  })

  it('throws on a non-DeepCode bundle', () => {
    expect(() => restoreBackup({ app: 'other' } as Parameters<typeof restoreBackup>[0])).toThrow()
  })
})
