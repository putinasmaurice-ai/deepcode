import { describe, it, expect } from 'vitest'
import { resolve, type ResolveCtx } from '../src/main/workflows/executor'

const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({ vars: {}, ...over })

describe('resolve() — richer safe expressions', () => {
  it('is backward-compatible with flat {{var}} tokens', () => {
    expect(resolve('{{last}}', ctx({ vars: { last: 'hi' } }))).toBe('hi')
    expect(resolve('a {{name}} b', ctx({ vars: { name: 'X' } }))).toBe('a X b')
    expect(resolve('{{missing}}', ctx())).toBe('')
    // a legacy literal flat key with dots must still resolve to that flat value, not path-walk
    expect(resolve('{{x.a.b}}', ctx({ vars: { 'x.a.b': 'flat' } }))).toBe('flat')
  })

  it('reads a node output via {{node.<id>.path}} (JSON-path)', () => {
    const nodeOutputs = new Map([['n1', JSON.stringify({ user: { name: 'Ann' } })]])
    expect(resolve('{{node.n1.user.name}}', ctx({ nodeOutputs }))).toBe('Ann')
    expect(resolve('{{n1.user.name}}', ctx({ nodeOutputs }))).toBe('Ann') // bare node id form
  })

  it('JSON-paths into a stringified-object var ({{item.field}}) — the loop-body footgun fix', () => {
    expect(resolve('{{item.field}}', ctx({ vars: { item: JSON.stringify({ field: 'V' }) } }))).toBe('V')
    expect(resolve('{{arr[2]}}', ctx({ vars: { arr: JSON.stringify(['a', 'b', 'c']) } }))).toBe('c')
  })

  it('rejects prototype-pollution keys and never pollutes', () => {
    expect(resolve('{{x.__proto__.y}}', ctx({ vars: { x: JSON.stringify({}) } }))).toBe('')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).y).toBeUndefined()
    expect(resolve('{{x.constructor}}', ctx({ vars: { x: JSON.stringify({}) } }))).toBe('')
  })

  it('fail-soft: deep/garbage paths return empty, never throw', () => {
    const deep = '{{a.' + Array.from({ length: 30 }, (_, i) => 'k' + i).join('.') + '}}'
    expect(resolve(deep, ctx({ vars: { a: JSON.stringify({}) } }))).toBe('')
    expect(resolve('{{a.b}}', ctx({ vars: { a: 'not json' } }))).toBe('') // unparseable base
  })

  it('resolves {{secret.NAME}} ONLY in tool/shell/http nodes (allowlist), never elsewhere', () => {
    const resolveSecret = (n: string): string | undefined => (n === 'TOKEN' ? 's3cr3t-value' : undefined)
    // allowed node types → real value
    for (const t of ['tool', 'shell', 'http']) {
      expect(resolve('Bearer {{secret.TOKEN}}', ctx({ resolveSecret, nodeType: t }))).toBe('Bearer s3cr3t-value')
    }
    expect(resolve('{{secret.MISSING}}', ctx({ resolveSecret, nodeType: 'tool' }))).toBe('')
    // every other node type (agent/transform/condition/switch/output/notify/undefined) → '' —
    // closes the two-hop laundering of a secret into a var and then a prompt
    for (const t of ['agent', 'transform', 'condition', 'switch', 'output', 'notify', undefined]) {
      expect(resolve('{{secret.TOKEN}}', ctx({ resolveSecret, nodeType: t }))).toBe('')
    }
  })

  it('does not pick up inherited Object.prototype members as bare vars', () => {
    expect(resolve('{{toString}}', ctx())).toBe('')
    expect(resolve('{{constructor}}', ctx())).toBe('')
    expect(resolve('{{__proto__}}', ctx())).toBe('')
  })
})
