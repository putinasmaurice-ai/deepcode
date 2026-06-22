import { describe, it, expect, vi, afterEach } from 'vitest'
import { DeepSeekClient, readWithTimeout } from '../src/main/agent/deepseek'
import type { ProviderSettings } from '../src/shared/types'

// Exercises the highest-failure-surface file (SSE parsing, retry/backoff, tool-strip self-heal,
// provider error mapping) with a fake global fetch + a ReadableStream — no network, deterministic.

const settings = (over: Partial<ProviderSettings> = {}): ProviderSettings =>
  ({
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    reasonerModel: 'deepseek-reasoner',
    temperature: 0.5,
    maxTokens: 4000,
    ...over
  }) as ProviderSettings

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    }
  })
}
function ok(chunks: string[]): Response {
  return { ok: true, status: 200, statusText: 'OK', body: sseBody(chunks), text: async () => '' } as unknown as Response
}
function err(status: number, text = ''): Response {
  return { ok: false, status, statusText: 'ERR', body: null, text: async () => text } as unknown as Response
}
// queue of responses; each fetch call shifts one and records the parsed request body
function stubFetch(responses: Response[]): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      const r = responses.shift()
      if (!r) throw new Error('no more stubbed responses')
      return r
    })
  )
  return { bodies }
}
const sig = (): AbortSignal => new AbortController().signal
afterEach(() => vi.unstubAllGlobals())

describe('DeepSeekClient.streamChat — SSE parsing', () => {
  it('accumulates content, tool-call deltas, reasoning + usage (incl. a line split across chunks)', async () => {
    stubFetch([
      ok([
        'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"con', // a data line split mid-JSON across two chunks
        'tent":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"p\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_cache_hit_tokens":4}}\n\n',
        'data: [DONE]\n\n'
      ])
    ])
    const seen: string[] = []
    const res = await new DeepSeekClient(settings()).streamChat(
      [{ role: 'user', content: 'hi' }],
      [],
      { onContent: (d) => seen.push(d) },
      sig()
    )
    expect(res.content).toBe('Hello')
    expect(res.reasoning).toBe('think')
    expect(seen.join('')).toBe('Hello') // streamed incrementally
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{"p":1}' }])
    expect(res.finishReason).toBe('tool_calls')
    expect(res.usage).toMatchObject({ totalTokens: 15, cachedPromptTokens: 4 })
  })

  it('ignores a `data: null` keep-alive without throwing', async () => {
    stubFetch([ok(['data: null\n\n', 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])])
    const res = await new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())
    expect(res.content).toBe('ok')
  })

  it('reads DeepInfra-shaped usage: prompt_tokens_details.cached_tokens + estimated_cost', async () => {
    stubFetch([
      ok([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":40},"estimated_cost":0.000123}}\n\n',
        'data: [DONE]\n\n'
      ])
    ])
    // the parse is provider-independent; use the default (keyless) route to exercise it
    const res = await new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())
    expect(res.usage?.cachedPromptTokens).toBe(40) // OpenAI-compatible cached field (not DeepSeek's)
    expect(res.usage?.reportedCost).toBeCloseTo(0.000123, 9) // provider's own authoritative cost
  })
})

describe('DeepSeekClient.streamChat — gpt-oss harmony / Hermes tool-call recovery', () => {
  it('strips harmony control tokens from the tool NAME and ARGUMENTS (gpt-oss via OpenRouter)', async () => {
    stubFetch([
      ok([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"apply_patch<|channel|>commentary","arguments":"<|constrain|>json<|message|>{\\"path\\":\\"x\\"}<|call|>"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    ])
    const res = await new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())
    expect(res.toolCalls[0].name).toBe('apply_patch') // harmony suffix cut → matches the clean registry
    expect(JSON.parse(res.toolCalls[0].arguments)).toEqual({ path: 'x' }) // wrappers stripped → parses
  })

  it('leaves already-valid arguments BYTE-IDENTICAL even when a string value contains "<|"', async () => {
    stubFetch([
      ok([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"content\\":\\"a<|b\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    ])
    const res = await new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())
    expect(res.toolCalls[0].arguments).toBe('{"content":"a<|b"}') // parses cleanly → never mangled
  })

  it('recovers <tool_call> blocks emitted into CONTENT when no structured tool call arrives (Qwen3-VL)', async () => {
    stubFetch([
      ok([
        'data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"a.ts\\"}}</tool_call>"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    ])
    const res = await new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0].name).toBe('read_file')
    expect(JSON.parse(res.toolCalls[0].arguments)).toEqual({ path: 'a.ts' })
  })
})

describe('DeepSeekClient.streamChat — OpenRouter routing', () => {
  it('requires an OpenRouter key for openrouter: models', async () => {
    await expect(
      new DeepSeekClient(settings({ model: 'openrouter:xiaomi/mimo-v2.5-pro' })).streamChat(
        [{ role: 'user', content: 'x' }],
        [],
        {},
        sig()
      )
    ).rejects.toThrow(/OpenRouter/i)
  })

  it('routes to the OpenRouter base URL, asks for cost, and strips the prefix from the model id', async () => {
    let calledUrl = ''
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init: { body: string }) => {
        calledUrl = u
        bodies.push(JSON.parse(init.body))
        return ok(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
      })
    )
    await new DeepSeekClient(
      settings({ model: 'openrouter:xiaomi/mimo-v2.5-pro', openrouterApiKey: 'sk-or-test', openrouterBaseUrl: 'https://openrouter.ai/api/v1' })
    ).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())
    expect(calledUrl).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(bodies[0].model).toBe('xiaomi/mimo-v2.5-pro') // prefix stripped
    expect(bodies[0].usage).toEqual({ include: true }) // cost requested
  })
})

describe('DeepSeekClient.streamChat — mid-stream provider errors must NOT abort silently', () => {
  it('surfaces a mid-stream {"error":...} chunk (OpenRouter) instead of resolving empty', async () => {
    stubFetch([
      ok([
        'data: {"choices":[{"delta":{"content":"Ich baue dir jetzt…"}}]}\n\n',
        'data: {"error":{"message":"upstream provider overloaded","code":502,"metadata":{"provider_code":"upstream_502"}},"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\n'
      ])
    ])
    await expect(
      new DeepSeekClient(settings({ model: 'openrouter:xiaomi/mimo-v2.5-pro', openrouterApiKey: 'sk-or-x' })).streamChat(
        [{ role: 'user', content: 'x' }],
        [],
        {},
        sig()
      )
    ).rejects.toThrow(/Provider-Fehler.*overloaded/)
  })

  it('throws when the FIRST chunk is an error object (no choices) — the worst-case silent path', async () => {
    stubFetch([ok(['data: {"error":{"message":"rate limited","code":429}}\n\n', 'data: [DONE]\n\n'])])
    await expect(new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())).rejects.toThrow(
      /Provider-Fehler.*rate limited/
    )
  })

  it('throws on finish_reason="error" even without a top-level error object', async () => {
    stubFetch([ok(['data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"error"}]}\n\n', 'data: [DONE]\n\n'])])
    await expect(new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())).rejects.toThrow(
      /finish_reason=error/
    )
  })

  it('does NOT throw on a non-fatal error:null and still streams normally', async () => {
    stubFetch([ok(['data: {"error":null,"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])])
    const res = await new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())
    expect(res.content).toBe('ok')
  })
})

describe('DeepSeekClient.streamChat — provider error mapping', () => {
  it('maps 402 to a credit message and 401/403 to a key message', async () => {
    stubFetch([err(402, 'Insufficient Balance')])
    await expect(new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())).rejects.toThrow(/Guthaben/)
    stubFetch([err(401, 'bad key')])
    await expect(new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], [], {}, sig())).rejects.toThrow(/Key ungültig/)
  })
  it('maps a Google 400 "api key" response to the Google-key message', async () => {
    stubFetch([err(400, 'Please pass a valid API key')])
    await expect(
      new DeepSeekClient(settings({ googleApiKey: 'g' })).streamChat([{ role: 'user', content: 'x' }], [], {}, sig(), 'google:gemini-2.5-flash-lite')
    ).rejects.toThrow(/Google-AI-Studio-Key/)
  })
})

describe('DeepSeekClient.streamChat — self-heal + retry', () => {
  it('strips tools and resends once when the model rejects tools', async () => {
    const { bodies } = stubFetch([
      err(400, 'this model does not support tools'),
      ok(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'])
    ])
    const tools = [{ type: 'function' as const, function: { name: 'read_file', description: 'd', parameters: {} } }]
    const res = await new DeepSeekClient(settings()).streamChat([{ role: 'user', content: 'x' }], tools, {}, sig())
    expect(res.content).toBe('hi')
    expect(bodies[0].tools).toBeTruthy() // first attempt carried tools
    expect(bodies[1].tools).toBeUndefined() // retry stripped them
  })

  it('retries a retryable 503 then succeeds, and emits a visible retry status (not a silent hang)', async () => {
    stubFetch([err(503, 'busy'), ok(['data: {"choices":[{"delta":{"content":"done"}}]}\n\n', 'data: [DONE]\n\n'])])
    const notes: string[] = []
    const res = await new DeepSeekClient(settings()).streamChat(
      [{ role: 'user', content: 'x' }],
      [],
      { onStatus: (m) => notes.push(m) },
      sig()
    )
    expect(res.content).toBe('done')
    expect(notes.some((n) => /neuer Versuch/i.test(n))).toBe(true) // the silent backoff window is now legible
  }, 10000)
})

describe('readWithTimeout — stream idle watchdog (the "model hangs mid-task" guard)', () => {
  const never = (): { read: () => Promise<never> } => ({ read: () => new Promise<never>(() => {}) })

  it('rejects with TimeoutError when read() never resolves within the deadline', async () => {
    await expect(readWithTimeout(never() as never, 20, new AbortController().signal)).rejects.toMatchObject({
      name: 'TimeoutError'
    })
  })

  it('resolves with the chunk when read() resolves before the deadline', async () => {
    const reader = { read: async () => ({ done: false, value: new Uint8Array([1, 2]) }) }
    await expect(readWithTimeout(reader as never, 1000, new AbortController().signal)).resolves.toMatchObject({
      done: false
    })
  })

  it('rejects with AbortError when the turn is stopped mid-read', async () => {
    const ac = new AbortController()
    const p = readWithTimeout(never() as never, 1000, ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects immediately if the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(readWithTimeout(never() as never, 1000, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('DeepSeekClient.streamChat — reasoner param stripping', () => {
  it('omits temperature + tools for a reasoner model', async () => {
    const { bodies } = stubFetch([ok(['data: {"choices":[{"delta":{"content":"r"}}]}\n\n', 'data: [DONE]\n\n'])])
    const tools = [{ type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } }]
    await new DeepSeekClient(settings({ model: 'deepseek-reasoner' })).streamChat([{ role: 'user', content: 'x' }], tools, {}, sig())
    expect(bodies[0].temperature).toBeUndefined()
    expect(bodies[0].tools).toBeUndefined()
    expect(bodies[0].max_tokens).toBe(4000) // still sent
  })
})
