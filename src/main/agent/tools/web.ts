import { Tool, ok, fail } from './types'

// Built-in web access: fetch a URL and return readable text. No API key needed.
// HTML is crudely stripped to text; JSON/text pass through. Capped output.

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
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30_000)
      const onAbort = (): void => ctrl.abort()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'DeepCode/0.1 (desktop coding assistant)' },
        redirect: 'follow'
      })
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      const type = res.headers.get('content-type') ?? ''
      const raw = await res.text()
      const text = type.includes('html') ? htmlToText(raw) : raw
      const body = text.slice(0, cap) + (text.length > cap ? '\n… (truncated)' : '')
      return res.ok
        ? ok(`[${res.status}] ${url}\n\n${body}`)
        : fail(`HTTP ${res.status} for ${url}\n\n${body}`)
    } catch (e) {
      return fail(`Fetch failed: ${(e as Error).message}`)
    }
  }
}
