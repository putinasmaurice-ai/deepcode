import { Tool, ok, fail } from './types'
import { lookup } from 'dns/promises'
import { isIP, type LookupFunction } from 'net'
import { request as httpsRequest, type RequestOptions } from 'https'
import { request as httpRequest, type IncomingMessage } from 'http'
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib'

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
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 → ':ffff:7f00:1' in hex-compressed form):
  // WHATWG URL normalizes the embedded v4 to hex, so the dotted-quad strip above
  // misses it. Block the whole mapped range — it should never appear in a normal
  // public fetch, and it's the classic loopback/metadata SSRF bypass.
  if (l.startsWith('::ffff:')) return true
  if (/^f[cd]/.test(l)) return true // fc00::/7 unique-local
  if (/^fe[89ab]/.test(l)) return true // fe80::/10 link-local
  return false
}

// Resolve + validate the host, returning the vetted IP to PIN for the actual connection.
// Pinning closes the DNS-rebinding TOCTOU: validating with one DNS query and then letting
// the HTTP client do its own second query would let a short-TTL attacker domain return a
// public IP to the check and 127.0.0.1 / 169.254.169.254 to the connection.
async function resolveAndPin(url: URL): Promise<string> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`blocked: ${host} resolves to a local/loopback address`)
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`blocked: ${host} is a private/loopback address`)
    return host
  }
  const addrs = await lookup(host, { all: true })
  if (!addrs.length) throw new Error(`blocked: ${host} did not resolve`)
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`blocked: ${host} resolves to private address ${a.address}`)
  }
  return addrs[0].address // pin the first vetted address — the connection MUST use this IP
}

interface PinnedResponse {
  status: number
  headers: IncomingMessage['headers']
  body: string
}

// GET `url` but connect to `pinnedIp` (via a custom socket lookup), keeping the real
// hostname for SNI + Host header so TLS cert validation still works. Decompresses
// gzip/deflate/br. Caps raw bytes to avoid OOM on a hostile/huge response.
function fetchPinned(url: URL, pinnedIp: string, signal: AbortSignal, timeoutMs: number): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const family = isIP(pinnedIp) === 6 ? 6 : 4
    // pin: every DNS lookup the socket attempts returns ONLY the pre-validated IP.
    // Node's Happy-Eyeballs connect calls lookup with { all: true } and expects an ARRAY
    // ([{address, family}]); the legacy form expects (err, address, family). Handle both,
    // or the socket gets `undefined` and the fetch throws ERR_INVALID_IP_ADDRESS.
    const pinnedLookup = ((
      _host: string,
      opts: { all?: boolean } | number | undefined,
      cb: (err: NodeJS.ErrnoException | null, addr: string | { address: string; family: number }[], fam?: number) => void
    ): void => {
      if (opts && typeof opts === 'object' && opts.all) cb(null, [{ address: pinnedIp, family }])
      else cb(null, pinnedIp, family)
    }) as unknown as LookupFunction

    const opts: RequestOptions = {
      method: 'GET',
      lookup: pinnedLookup,
      servername: isHttps ? url.hostname : undefined, // SNI uses the real host, not the IP
      headers: {
        'User-Agent': 'DeepCode/0.1 (desktop coding assistant)',
        'Accept-Encoding': 'gzip, deflate, br',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
      },
      signal,
      timeout: timeoutMs
    }
    // single-settle guard: destroying the stream on overflow fires neither 'end' nor a
    // useful 'error' on every path, so we must resolve/reject exactly once ourselves.
    let settled = false
    const onRes = (res: IncomingMessage): void => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase()
      let stream: NodeJS.ReadableStream = res
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(createGunzip())
      else if (enc === 'deflate') stream = res.pipe(createInflate())
      else if (enc === 'br') stream = res.pipe(createBrotliDecompress())
      const chunks: Buffer[] = []
      let len = 0
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      }
      stream.on('data', (c: Buffer) => {
        if (settled) return
        len += c.length
        if (len <= 4_000_000) chunks.push(c) // ~4 MB raw cap
        else {
          // over cap: stop, tear down the (possibly piped) decompressor + socket, and
          // RETURN the truncated body now instead of hanging until the 30s timeout.
          stream.removeAllListeners('data')
          if (stream !== res) (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
          res.destroy()
          finish()
        }
      })
      stream.on('end', finish)
      stream.on('error', (e: Error) => {
        if (settled) return
        settled = true
        reject(e)
      })
    }
    const req = isHttps ? httpsRequest(url, opts, onRes) : httpRequest(url, opts, onRes)
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    req.on('error', (e: Error) => {
      if (settled) return
      settled = true
      reject(e)
    })
    req.end()
  })
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
      // Follow redirects manually so each hop's host is re-validated AND re-pinned
      // against the SSRF guard (a public URL must not bounce us to 127.0.0.1, and the
      // pinned IP must match the host we just validated — never a re-resolved one).
      let current = url
      let res: PinnedResponse
      let hop = 0
      for (;;) {
        const pinnedIp = await resolveAndPin(current)
        res = await fetchPinned(current, pinnedIp, ctrl.signal, 30_000)
        const loc = res.headers['location']
        if (res.status >= 300 && res.status < 400 && loc) {
          if (++hop > 5) return fail(`Too many redirects for ${url}`)
          current = new URL(Array.isArray(loc) ? loc[0] : loc, current)
          if (current.protocol !== 'http:' && current.protocol !== 'https:') {
            return fail(`Refusing to follow non-http(s) redirect to ${current.protocol}`)
          }
          continue
        }
        break
      }
      const type = String(res.headers['content-type'] ?? '')
      const text = type.includes('html') ? htmlToText(res.body) : res.body
      const body = text.slice(0, cap) + (text.length > cap ? '\n… (truncated)' : '')
      const okStatus = res.status >= 200 && res.status < 300
      return okStatus ? ok(`[${res.status}] ${url}\n\n${body}`) : fail(`HTTP ${res.status} for ${url}\n\n${body}`)
    } catch (e) {
      return fail(`Fetch failed: ${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }
}
