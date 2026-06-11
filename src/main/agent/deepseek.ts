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

export interface StreamResult {
  content: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
  finishReason: string
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
    const model = modelOverride || this.settings.model
    const url = `${this.settings.baseUrl.replace(/\/$/, '')}/chat/completions`

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens
    }
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.settings.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`DeepSeek API error ${res.status}: ${text || res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    let content = ''
    let reasoning = ''
    let finishReason = 'stop'
    // accumulate tool calls by index
    const toolAcc: Map<number, { id: string; name: string; arguments: string }> = new Map()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let json: any
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        const choice = json.choices?.[0]
        if (!choice) continue
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
    }

    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((t) => t.name)

    callbacks.onDone?.(finishReason)
    return { content, reasoning, toolCalls, finishReason }
  }
}
