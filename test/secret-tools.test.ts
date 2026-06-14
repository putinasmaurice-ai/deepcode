import { describe, it, expect } from 'vitest'
import { secretTools } from '../src/main/agent/tools/secrets'
import type { Tool, ToolContext } from '../src/main/agent/tools/types'
import { listSecretNames } from '../src/main/workflows/secrets'

// These tests assert the SECURITY invariant: a secret VALUE never travels through a tool arg or a
// tool result. The agent only ever names a secret; the value is captured out-of-band by the user.

function tool(name: string): Tool {
  const t = secretTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, ...over }
}

const list = tool('list_secrets')
const request = tool('request_secret')

describe('secret tools', () => {
  it('list_secrets returns only NAMES, never values', async () => {
    const r = await list.execute({}, ctx())
    expect(r.ok).toBe(true)
    const names = listSecretNames()
    if (!names.length) {
      expect(r.content).toMatch(/Keine Secrets/i)
    } else {
      // every line is a stored name — no key=value or value content
      for (const n of names) expect(r.content).toContain(n)
      expect(r.meta?.count).toBe(names.length)
    }
  })

  it('request_secret calls ctx.requestSecret with (name, reason) and NO value, then reports success', async () => {
    let received: { name: string; reason?: string } | undefined
    let argCount = 0
    const r = await request.execute(
      { name: 'SMTP_PASS', reason: 'für den E-Mail-Versand' },
      ctx({
        requestSecret: async (...args: unknown[]) => {
          argCount = args.length
          received = { name: args[0] as string, reason: args[1] as string | undefined }
          return { set: true }
        }
      })
    )
    expect(r.ok).toBe(true)
    expect(r.content).toBe('Secret SMTP_PASS wurde sicher gespeichert.')
    expect(received).toEqual({ name: 'SMTP_PASS', reason: 'für den E-Mail-Versand' })
    // the stub received exactly (name, reason) — no third "value" argument was ever passed
    expect(argCount).toBe(2)
  })

  it('request_secret reports a cancelled input when ctx.requestSecret resolves { set:false }', async () => {
    const r = await request.execute(
      { name: 'SMTP_PASS' },
      ctx({ requestSecret: async () => ({ set: false }) })
    )
    expect(r.ok).toBe(true)
    expect(r.content).toBe('Eingabe für SMTP_PASS abgebrochen.')
  })

  it('request_secret reports a REJECTION (not a cancel) when ctx.requestSecret resolves { set:false, error }', async () => {
    const r = await request.execute(
      { name: 'SMTP_PASS' },
      ctx({ requestSecret: async () => ({ set: false, error: 'Secret zu kurz — mindestens 8 Zeichen.' }) })
    )
    expect(r.ok).toBe(true)
    // distinct from a cancel: the agent learns WHY (min length) so it can re-prompt correctly
    expect(r.content).toBe('Secret SMTP_PASS NICHT gespeichert: Secret zu kurz — mindestens 8 Zeichen.')
    expect(r.content).not.toMatch(/abgebrochen/)
    // the error is a static constraint message — assert it carries no value placeholder
    expect(r.content).not.toContain('SMTP_PASS=')
  })

  it('request_secret fails (no user present) when ctx.requestSecret is absent', async () => {
    const r = await request.execute({ name: 'SMTP_PASS' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/nicht verfügbar/i)
  })

  it('request_secret rejects an invalid secret name before prompting', async () => {
    let called = false
    const r = await request.execute(
      { name: 'not a valid name!' },
      ctx({
        requestSecret: async () => {
          called = true
          return { set: true }
        }
      })
    )
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/Ungültiger Secret-Name/i)
    expect(called).toBe(false) // never prompted on a bad name
  })

  it('request_secret schema does NOT accept a value argument', () => {
    const props = (request.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props).sort()).toEqual(['name', 'reason'])
    expect('value' in props).toBe(false)
  })
})
