import { Tool, ok, fail } from './types'
import { lookup } from 'dns/promises'
import { isIP } from 'net'

// Built-in web access: fetch a URL and return readable text. No API key needed.
// HTML is crudely stripped to text; JSON/text pass through. Capped output.

// SSRF guard: web_fetch is a read tool (auto-approved by default), so the model
// could otherwise reach loopback/LAN/cloud-metadata endpoints. Block private,
// loopback and link-local targets — and re-check on every redirect hop.
function isPrivateIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, '')
  if (isIP(v4) === 4) {
    const p = v4.split('.').map(Number)
    if (p[0] === 0 || p[0] === 127 || p[0] === 10) return true
    if (p[0] === 169 && p[1] === 254) return true // link-local incl. 169.254.169.254 metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true // CGNAT
    return false
  }
  const l = ip.toLowerCase()
  if (l === '::1' || l === '::') return true
  if (/^f[cd]/.test(l)) return true // fc00::/7 unique-local
  if (/^fe[89ab]/.test(l)) return true // fe80::/10 link-local
  return false
}

async function assertSafeHost(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`blocked: ${host} resolves to a local/loopback address`)
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`blocked: ${host} is a private/loopback address`)
    return
  }
  const addrs = await lookup(host, { all: true })
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`blocked: ${host} resolves to private address ${a.address}`)
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a URL from the internet and return its content as readable text (HTML is converted to plain text). ' +
    'Use for documentation, APIs, release notes, error messages. Only http/https.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch.' },
      max_chars: { type: 'number', description: 'Max characters to return (default 20000).' }
    },
    required: ['url']
  },
  summarize: (a) => `Fetch ${String(a.url).slice(0, 80)}`,
  async execute(args, ctx) {
    let url: URL
    try {
      url = new URL(args.url)
    } catch {
      return fail(`Invalid URL: ${args.url}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return fail('Only http/https URLs are allowed.')
    }
    const cap = Math.min(args.max_chars ?? 20_000, 80_000)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 30_000)
    const onAbort = (): void => ctrl.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Follow redirects manually so each hop's host is re-validated against the
      // SSRF guard (a public URL must not be able to bounce us to 127.0.0.1).
      let current = url
      let res: Awaited<ReturnType<typeof fetch>>
      let hop = 0
      for (;;) {
        await assertSafeHost(current)
        res = await fetch(current, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'DeepCode/0.1 (desktop coding assistant)' },
          redirect: 'manual'
        })
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          if (++hop > 5) return fail(`Too many redirects for ${url}`)
          current = new URL(res.headers.get('location') as string, current)
          if (current.protocol !== 'http:' && current.protocol !== 'https:') {
            return fail(`Refusing to follow non-http(s) redirect to ${current.protocol}`)
          }
          continue
        }
        break
      }
      const type = res.headers.get('content-type') ?? ''
      const raw = await res.text()
      const text = type.includes('html') ? htmlToText(raw) : raw
      const body = text.slice(0, cap) + (text.length > cap ? '\n… (truncated)' : '')
      return res.ok
        ? ok(`[${res.status}] ${url}\n\n${body}`)
        : fail(`HTTP ${res.status} for ${url}\n\n${body}`)
    } catch (e) {
      return fail(`Fetch failed: ${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }
}
