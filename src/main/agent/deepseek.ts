// Minimal, dependency-free client for the DeepSeek API (OpenAI-compatible
// /chat/completions endpoint) with streaming + tool-call support.
//
// Works against any OpenAI-compatible endpoint — set baseUrl/model in settings.
// DeepSeek today exposes `deepseek-chat` and `deepseek-reasoner`; whatever
// "v4 PRO" model id you have access to plugs in via settings without code changes.

import { ProviderSettings } from '@shared/types'

export interface ApiToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
  name?: string
}

export interface StreamCallbacks {
  onReasoning?: (delta: string) => void
  onContent?: (delta: string) => void
  onToolCallDelta?: (index: number, id: string | undefined, name: string | undefined, argsDelta: string) => void
  onDone?: (finishReason: string) => void
}

export interface RawUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface StreamResult {
  content: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
  finishReason: string
  usage?: RawUsage
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const MAX_RETRIES = 3

function isReasoner(model: string): boolean {
  return /reason/i.test(model)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

export class DeepSeekClient {
  constructor(private settings: ProviderSettings) {}

  update(settings: ProviderSettings): void {
    this.settings = settings
  }

  async streamChat(
    messages: ApiMessage[],
    tools: ApiToolDef[],
    callbacks: StreamCallbacks,
    signal: AbortSignal,
    modelOverride?: string
  ): Promise<StreamResult> {
    const rawModel = modelOverride || this.settings.model
    // "local:<name>" routes to the local OpenAI-compatible endpoint (Ollama /
    // LM Studio): keyless, free, offline-capable.
    const isLocal = rawModel.startsWith('local:')
    const model = isLocal ? rawModel.slice('local:'.length) : rawModel
    const base = isLocal
      ? this.settings.localBaseUrl || 'http://localhost:11434/v1'
      : this.settings.baseUrl

    if (!isLocal && (!this.settings.apiKey || !this.settings.apiKey.trim())) {
      throw new Error('DeepSeek API key is not configured. Add it in Settings.')
    }

    const reasoner = isReasoner(model)
    const url = `${base.replace(/\/$/, '')}/chat/completions`

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.settings.maxTokens
    }
    // deepseek-reasoner rejects temperature/top_p/tool params — only send them otherwise.
    if (!reasoner) {
      body.temperature = this.settings.temperature
      if (tools.length > 0) {
        body.tools = tools
        body.tool_choice = 'auto'
      }
    }

    // Establish the connection with retry/backoff. We only retry BEFORE streaming
    // begins — once bytes flow, retrying would duplicate output.
    let res: Response | null = null
    let lastErr = ''
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (!isLocal) headers.Authorization = `Bearer ${this.settings.apiKey}`
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal
        })
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        lastErr = (e as Error).message
        if (attempt < MAX_RETRIES) {
          await sleep(backoff(attempt), signal)
          continue
        }
        if (isLocal) {
          throw new Error(
            `Lokales Modell nicht erreichbar (${base}). Läuft Ollama/LM Studio? Starte es oder wechsle oben rechts das Modell.`
          )
        }
        throw new Error(`Netzwerkfehler zu DeepSeek: ${lastErr}`)
      }

      if (res.ok && res.body) break

      const text = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        throw new Error('API-Key ungültig oder abgelaufen — bitte in den Settings prüfen.')
      }
      if (res.status === 402) {
        throw new Error('DeepSeek-Guthaben aufgebraucht — bitte unter platform.deepseek.com aufladen.')
      }
      lastErr = `DeepSeek API error ${res.status}: ${text || res.statusText}`
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(backoff(attempt), signal)
        res = null
        continue
      }
      throw new Error(lastErr)
    }
    if (!res || !res.body) throw new Error(lastErr || 'DeepSeek API: no response body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    let content = ''
    let reasoning = ''
    let finishReason = 'stop'
    let usage: RawUsage | undefined
    const toolAcc: Map<number, { id: string; name: string; arguments: string }> = new Map()

    const handleData = (data: string): void => {
      if (data === '[DONE]' || !data) return
      let json: any
      try {
        json = JSON.parse(data)
      } catch {
        return
      }
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
          totalTokens: json.usage.total_tokens ?? 0
        }
      }
      const choice = json.choices?.[0]
      if (!choice) return
      const delta = choice.delta ?? {}
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content
        callbacks.onReasoning?.(delta.reasoning_content)
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        callbacks.onContent?.(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const cur = toolAcc.get(idx) ?? { id: '', name: '', arguments: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.arguments += tc.function.arguments
          toolAcc.set(idx, cur)
          callbacks.onToolCallDelta?.(idx, tc.id, tc.function?.name, tc.function?.arguments ?? '')
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    const drainLines = (): void => {
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) handleData(line.slice(5).trim())
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      drainLines()
    }
    // Flush any incomplete multi-byte sequence and the final newline-less line.
    buffer += decoder.decode()
    drainLines()
    const tail = buffer.trim()
    if (tail.startsWith('data:')) handleData(tail.slice(5).trim())

    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((t) => t.name)

    callbacks.onDone?.(finishReason)
    return { content, reasoning, toolCalls, finishReason, usage }
  }
}

function backoff(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000)
  return base + Math.floor((attempt * 137 + 250) % 500) // small deterministic jitter
}
