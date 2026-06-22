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

// OpenAI-compatible multimodal content parts (used for image attachments).
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
  name?: string
  // replayed chain-of-thought on an assistant tool-call turn — REQUIRED by first-party DeepSeek
  // V3.2/V4 thinking-mode (400 without it); only set on that route (see toApiMessages replayReasoning).
  reasoning_content?: string
}

export interface StreamCallbacks {
  onReasoning?: (delta: string) => void
  onContent?: (delta: string) => void
  onToolCallDelta?: (index: number, id: string | undefined, name: string | undefined, argsDelta: string) => void
  onDone?: (finishReason: string) => void
  // a human-readable progress note during otherwise-silent stretches (connect retries, backoff)
  // so the UI can show "working, not hung". Optional — existing `{}` callers are unaffected.
  onStatus?: (message: string) => void
}

export interface RawUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  // cached prompt portion (billed cheaper): DeepSeek reports prompt_cache_hit_tokens; OpenAI-style
  // providers (DeepInfra) report prompt_tokens_details.cached_tokens — we accept either.
  cachedPromptTokens?: number
  // the provider's OWN authoritative $ for this round (DeepInfra returns usage.estimated_cost) —
  // when present we trust it over our local rate table so the chat matches the real invoice.
  reportedCost?: number
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

// Stream watchdogs — the LLM stream is the one unbounded `await` in a turn. A provider that
// accepts the socket then sends nothing (local model still loading / OOM, reasoner stuck, a cloud
// gateway holding the connection under load) would otherwise hang the turn forever. These are
// generous so a slow-but-working model is never killed: reasoning/content deltas reset the idle
// timer, and local gets a longer connect window because loading a big model is legitimately slow.
const CONNECT_TIMEOUT_MS = 60_000 // response headers must arrive within this (cloud)
const LOCAL_CONNECT_TIMEOUT_MS = 180_000 // local: allow time for the model to load into VRAM
const STREAM_IDLE_TIMEOUT_MS = 120_000 // max gap with NO progress once the stream is open

// the result of one reader.read() — derived structurally so we don't depend on the global
// `ReadableStreamReadResult` name (absent from the node tsconfig lib).
type ReadChunk = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

// Race a single reader.read() against an idle deadline and the turn's abort signal, so a stalled
// stream can never pend forever. Rejects 'TimeoutError' on idle, 'AbortError' on Stop. Exported
// for unit testing the watchdog in isolation.
export function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
  signal: AbortSignal
): Promise<ReadChunk> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => reject(new DOMException('Idle', 'TimeoutError')), ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (r) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(r)
      },
      (e) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

function isReasonerModel(model: string, configuredReasoner: string): boolean {
  // explicit config wins; regex covers common reasoning-model families
  if (configuredReasoner && model === configuredReasoner) return true
  return /reason|qwq|deepseek-r1|(^|[:/])o[13](-|$)/i.test(model)
}

// gpt-oss / OpenAI "harmony" models emit channel control tokens (<|channel|>, <|message|>,
// <|constrain|>, <|start|>, <|end|>, <|call|>, <|return|>) plus a "commentary to=functions.NAME"
// routing prefix. OpenRouter sometimes leaks these into the streamed function NAME, so the tool
// name arrives as e.g. "apply_patch<|channel|>commentary" and never matches the clean registry.
// Cut at the first control token / whitespace and drop any "functions." routing prefix. A clean
// name has none of these markers, so this is a no-op for every well-behaved provider.
export function cleanToolName(raw: string): string {
  let n = raw
  const lt = n.indexOf('<|') // first harmony control token
  if (lt !== -1) n = n.slice(0, lt)
  n = n.split(/\s/)[0] // cut at first whitespace ("commentary to=functions.x")
  const dot = n.lastIndexOf('functions.')
  if (dot !== -1) n = n.slice(dot + 'functions.'.length)
  return n.trim()
}

// Repair harmony-wrapped tool ARGUMENTS. Gated behind a parse-failure check: if the accumulated
// string already parses as JSON it is returned byte-identical (so a legit argument that merely
// contains "<|" inside a string is never mangled, and clean providers are untouched). Only when it
// does NOT parse do we strip <|message|>/<|constrain|>/<|...|> wrappers and slice to the outermost
// {...}. A TRUNCATED arg (large-file cutoff) has no closing brace, so this can't fabricate one — it
// stays invalid and falls through to the engine's truncation-aware handler.
export function cleanToolArgs(raw: string): string {
  if (!raw) return raw
  try {
    JSON.parse(raw)
    return raw // already valid — leave exactly as-is
  } catch {
    /* not valid JSON: try to repair harmony junk below */
  }
  let a = raw
  const msg = a.indexOf('<|message|>')
  if (msg !== -1) a = a.slice(msg + '<|message|>'.length)
  a = a.replace(/<\|constrain\|>\s*json\s*/gi, '')
  a = a.replace(/<\|[^>]*\|>/g, '') // strip any remaining harmony tokens
  a = a.trim()
  const s = a.indexOf('{')
  const e = a.lastIndexOf('}')
  if (s !== -1 && e !== -1 && e > s) a = a.slice(s, e + 1)
  return a.trim()
}

// Fallback for models (e.g. Qwen3-VL served behind a Hermes parser, vLLM #29814) that emit tool
// calls as <tool_call>{...}</tool_call> blocks INTO the content stream with tool_calls:null. We
// only consult this when no structured tool calls arrived, so it never overrides a clean provider.
export function parseHermesToolCalls(text: string): { id: string; name: string; arguments: string }[] {
  const out: { id: string; name: string; arguments: string }[] = []
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1])
      const name = obj.name ?? obj.function?.name
      if (!name) continue
      const argsRaw = obj.arguments ?? obj.function?.arguments ?? obj.parameters ?? {}
      const argsStr = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw)
      out.push({ id: `hermes_${i++}`, name: cleanToolName(String(name)), arguments: argsStr })
    } catch {
      /* skip an unparseable block */
    }
  }
  return out
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
    // Routing by model-id prefix:
    //  "local:<name>"     → local OpenAI-compatible endpoint (Ollama/LM Studio): keyless, free.
    //  "google:<name>"    → Google AI Studio (Gemini), OpenAI-compatible: needs googleApiKey.
    //  "deepinfra:<name>" → DeepInfra (OpenAI-compatible): needs deepinfraApiKey.
    //  otherwise          → the configured DeepSeek endpoint.
    const isLocal = rawModel.startsWith('local:')
    const isGoogle = rawModel.startsWith('google:')
    const isDeepinfra = rawModel.startsWith('deepinfra:')
    const isOpenai = rawModel.startsWith('openai:') // OpenAI-compatible (api.openai.com)
    const isTogether = rawModel.startsWith('together:') // Together AI (OpenAI-compatible)
    const isMimo = rawModel.startsWith('mimo:') // Xiaomi MiMo (OpenAI-compatible)
    const isKilo = rawModel.startsWith('kilo:') // Kilo Code gateway (OpenAI-compatible)
    const isOpenrouter = rawModel.startsWith('openrouter:') // OpenRouter aggregator (OpenAI-compatible)
    const prefix = isLocal
      ? 'local:'
      : isGoogle
        ? 'google:'
        : isDeepinfra
          ? 'deepinfra:'
          : isOpenai
            ? 'openai:'
            : isTogether
              ? 'together:'
              : isMimo
                ? 'mimo:'
                : isKilo
                  ? 'kilo:'
                  : isOpenrouter
                    ? 'openrouter:'
                    : ''
    const model = prefix ? rawModel.slice(prefix.length) : rawModel
    const base = isLocal
      ? this.settings.localBaseUrl || 'http://localhost:11434/v1'
      : isGoogle
        ? this.settings.googleBaseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'
        : isDeepinfra
          ? this.settings.deepinfraBaseUrl || 'https://api.deepinfra.com/v1/openai'
          : isOpenai
            ? this.settings.openaiBaseUrl || 'https://api.openai.com/v1'
            : isTogether
              ? this.settings.togetherBaseUrl || 'https://api.together.xyz/v1'
              : isMimo
                ? this.settings.mimoBaseUrl || 'https://token-plan-ams.xiaomimimo.com/v1'
                : isKilo
                  ? this.settings.kiloBaseUrl || 'https://api.kilo.ai/api/gateway'
                  : isOpenrouter
                    ? this.settings.openrouterBaseUrl || 'https://openrouter.ai/api/v1'
                    : this.settings.baseUrl
    const apiKey = isGoogle
      ? this.settings.googleApiKey
      : isDeepinfra
        ? this.settings.deepinfraApiKey
        : isOpenai
          ? this.settings.openaiApiKey
          : isTogether
            ? this.settings.togetherApiKey
            : isMimo
              ? this.settings.mimoApiKey
              : isKilo
                ? this.settings.kiloApiKey
                : isOpenrouter
                  ? this.settings.openrouterApiKey
                  : this.settings.apiKey

    if (isGoogle && (!this.settings.googleApiKey || !this.settings.googleApiKey.trim())) {
      throw new Error('Kein Google-AI-Studio-Key konfiguriert. Trage ihn in den Settings ein (für Bild-Analyse online).')
    }
    if (isDeepinfra && (!this.settings.deepinfraApiKey || !this.settings.deepinfraApiKey.trim())) {
      throw new Error('Kein DeepInfra-API-Key konfiguriert. Trage ihn in den Settings ein.')
    }
    if (isOpenai && (!this.settings.openaiApiKey || !this.settings.openaiApiKey.trim())) {
      throw new Error('Kein OpenAI-API-Key konfiguriert. Trage ihn in den Settings ein.')
    }
    if (isTogether && (!this.settings.togetherApiKey || !this.settings.togetherApiKey.trim())) {
      throw new Error('Kein Together-AI-API-Key konfiguriert. Trage ihn in den Settings ein.')
    }
    if (isMimo && (!this.settings.mimoApiKey || !this.settings.mimoApiKey.trim())) {
      throw new Error('Kein Xiaomi-MiMo-API-Key konfiguriert. Trage ihn in den Settings ein.')
    }
    if (isKilo && (!this.settings.kiloApiKey || !this.settings.kiloApiKey.trim())) {
      throw new Error('Kein Kilo-Code-API-Key konfiguriert. Trage ihn in den Settings ein (app.kilo.ai → API Keys).')
    }
    if (isOpenrouter && (!this.settings.openrouterApiKey || !this.settings.openrouterApiKey.trim())) {
      throw new Error('Kein OpenRouter-API-Key konfiguriert. Trage ihn in den Settings ein (openrouter.ai/keys).')
    }
    if (!isLocal && !isGoogle && !isDeepinfra && !isOpenai && !isTogether && !isMimo && !isKilo && !isOpenrouter && (!this.settings.apiKey || !this.settings.apiKey.trim())) {
      throw new Error('DeepSeek API key is not configured. Add it in Settings.')
    }

    const reasoner = isReasonerModel(model, this.settings.reasonerModel)
    const url = `${base.replace(/\/$/, '')}/chat/completions`

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    }
    // only send max_tokens when it's a positive integer — a persisted 0/NaN/empty (e.g. the user
    // cleared the field) would otherwise be sent verbatim and the API rejects it, bricking the turn.
    const mt = Number(this.settings.maxTokens)
    if (Number.isFinite(mt) && mt >= 1) body.max_tokens = Math.floor(mt)
    // deepseek-reasoner rejects temperature/top_p/tool params — only send them otherwise.
    if (!reasoner) {
      body.temperature = this.settings.temperature
      if (tools.length > 0) {
        body.tools = tools
        body.tool_choice = 'auto'
      }
    }
    // OpenRouter returns its own authoritative per-round cost in usage.cost when asked — request it
    // so costOf() can trust it (exact, regardless of which underlying provider OR routed to).
    if (isOpenrouter) body.usage = { include: true }

    // Establish the connection with retry/backoff. We only retry BEFORE streaming
    // begins — once bytes flow, retrying would duplicate output.
    let res: Response | null = null
    let lastErr = ''
    let toolsStripped = false
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const connectMs = isLocal ? LOCAL_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (!isLocal) headers.Authorization = `Bearer ${apiKey}`
        // OpenRouter attribution headers (optional, recommended; no secrets)
        if (isOpenrouter) {
          headers['HTTP-Referer'] = 'https://github.com/MauricePutinas/deepcode'
          headers['X-Title'] = 'DeepCode'
        }
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          // connect/headers deadline merged with the turn signal: a provider that accepts the
          // socket but never sends headers (local model loading, gateway stalled) times out and
          // is retried, instead of hanging the turn forever.
          signal: AbortSignal.any([signal, AbortSignal.timeout(connectMs)])
        })
      } catch (e) {
        // the user pressed Stop → abort the whole turn (never retry)
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        // else: a connect-timeout (TimeoutError) or a transient network error → retry with backoff
        const isTimeout = (e as Error).name === 'TimeoutError'
        lastErr = isTimeout ? `Zeitüberschreitung beim Verbindungsaufbau nach ${Math.round(connectMs / 1000)}s` : (e as Error).message
        if (attempt < MAX_RETRIES) {
          callbacks.onStatus?.(`Verbindung fehlgeschlagen — neuer Versuch in ${Math.round(backoff(attempt) / 1000)}s (${attempt + 1}/${MAX_RETRIES})…`)
          await sleep(backoff(attempt), signal)
          continue
        }
        if (isLocal) {
          throw new Error(
            `Lokales Modell nicht erreichbar/bereit (${base}). Läuft Ollama/LM Studio und ist das Modell geladen? Starte es oder wechsle oben rechts das Modell.`
          )
        }
        throw new Error(`Netzwerkfehler zu DeepSeek: ${lastErr}`)
      }

      if (res.ok && res.body) break

      const text = await res.text().catch(() => '')
      // Google AI Studio answers an invalid/missing key with HTTP 400 ("Please pass a
      // valid API key"), not 401 — surface a clear, provider-correct message.
      if (isGoogle && (res.status === 400 || res.status === 401 || res.status === 403) && /api[_ ]?key|invalid/i.test(text)) {
        throw new Error('Google-AI-Studio-Key ungültig oder fehlt — bitte in den Settings prüfen (für Online-Bildanalyse).')
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error('API-Key ungültig oder abgelaufen — bitte in den Settings prüfen.')
      }
      if (res.status === 402) {
        throw new Error('DeepSeek-Guthaben aufgebraucht — bitte unter platform.deepseek.com aufladen.')
      }
      // Self-heal: many local models (Dolphin, plain chat LLMs) reject tools.
      // Resend once without tools so they work as a tool-less chat model.
      if (!toolsStripped && body.tools && /does not support tools|tools.*not.*support|tool.*unsupported/i.test(text)) {
        toolsStripped = true
        delete body.tools
        delete body.tool_choice
        res = null
        continue
      }
      lastErr = `DeepSeek API error ${res.status}: ${text || res.statusText}`
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        callbacks.onStatus?.(`Server antwortete ${res.status} — neuer Versuch in ${Math.round(backoff(attempt) / 1000)}s (${attempt + 1}/${MAX_RETRIES})…`)
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
    // last time the stream made REAL progress (a content/reasoning/tool delta). Drives the idle
    // watchdog so a heartbeat-only stream (keep-alive bytes but no tokens) still self-terminates.
    let lastProgressAt = Date.now()

    const handleData = (data: string): void => {
      if (data === '[DONE]' || !data) return
      let json: any
      try {
        json = JSON.parse(data)
      } catch {
        return
      }
      // JSON.parse("null") succeeds and returns null; guard before field access so a
      // `data: null` keep-alive line can't throw and abort the whole turn.
      if (!json || typeof json !== 'object') return
      // OpenRouter (and other gateways) deliver an upstream/provider error MID-STREAM as a data
      // chunk — HTTP is already 200 — e.g. {"error":{"message":"…","code":429,…}}, usually with
      // choices[0].finish_reason="error". The `if (!choice) return` below would silently DROP it,
      // ending the turn empty with no reason. Throw instead so the real cause surfaces. Guard on a
      // truthy error (so a non-fatal `error: null` is ignored).
      if (json.error) {
        const e = json.error
        const msg = typeof e === 'string' ? e : e.message || 'unbekannter Provider-Fehler'
        const code = typeof e === 'object' ? (e.metadata?.provider_code ?? e.code ?? e.type) : undefined
        throw new Error(`Provider-Fehler im Antwort-Stream${code ? ` (${code})` : ''}: ${msg}`)
      }
      if (json.usage) {
        // DeepInfra reports the round's cost as estimated_cost; OpenRouter as cost (with usage.include)
        const est = json.usage.estimated_cost ?? json.usage.cost
        usage = {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
          totalTokens: json.usage.total_tokens ?? 0,
          // DeepSeek: prompt_cache_hit_tokens (top-level). DeepInfra & other OpenAI-compatible
          // providers: prompt_tokens_details.cached_tokens. Accept whichever is present.
          cachedPromptTokens: json.usage.prompt_cache_hit_tokens ?? json.usage.prompt_tokens_details?.cached_tokens ?? 0,
          // DeepInfra returns its own per-round cost; trust it downstream over our local table
          reportedCost: typeof est === 'number' && isFinite(est) ? est : undefined
        }
      }
      const choice = json.choices?.[0]
      if (!choice) return
      const delta = choice.delta ?? {}
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content
        lastProgressAt = Date.now()
        callbacks.onReasoning?.(delta.reasoning_content)
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        lastProgressAt = Date.now()
        callbacks.onContent?.(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        lastProgressAt = Date.now()
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const cur = toolAcc.get(idx) ?? { id: '', name: '', arguments: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = cleanToolName(tc.function.name)
          if (tc.function?.arguments) cur.arguments += tc.function.arguments
          toolAcc.set(idx, cur)
          callbacks.onToolCallDelta?.(idx, tc.id, tc.function?.name ? cleanToolName(tc.function.name) : undefined, tc.function?.arguments ?? '')
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

    // Hard caps so a runaway/never-terminating or newline-less stream (a buggy local
    // model or a compromised endpoint) can't grow memory until the app OOMs/hangs.
    const MAX_STREAM_BYTES = 64 * 1024 * 1024 // total decoded payload ceiling
    const MAX_BUFFER_BYTES = 4 * 1024 * 1024 // undrained buffer (no-newline) ceiling
    let totalBytes = 0
    // the FIRST token may legitimately take as long as a connect (a slow local model finishing
    // prefill after it already flushed headers), so the pre-first-token reads get the generous
    // connect budget; once real tokens flow we tighten to the idle timeout for mid-stream stalls.
    const firstReadMs = Math.max(isLocal ? LOCAL_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS)
    const idleMsg = `Antwort-Stream seit ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s ohne Daten — abgebrochen. Das Modell hängt evtl.; wechsle das Modell oder versuche es erneut.`
    while (true) {
      // "real progress" = at least one content/reasoning/tool token has arrived. Until then we're
      // still waiting for the first token and must not apply the tight mid-stream idle guard.
      const sawProgress = content.length > 0 || reasoning.length > 0 || toolAcc.size > 0
      let chunk: ReadChunk
      try {
        // idle watchdog: catches a stream that opens then sends NOTHING (read() never resolves)
        chunk = await readWithTimeout(reader, sawProgress ? STREAM_IDLE_TIMEOUT_MS : firstReadMs, signal)
      } catch (e) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError') // user pressed Stop
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        throw new Error(idleMsg)
      }
      const { done, value } = chunk
      if (done) break
      totalBytes += value?.length ?? 0
      buffer += decoder.decode(value, { stream: true })
      drainLines()
      if (totalBytes > MAX_STREAM_BYTES || buffer.length > MAX_BUFFER_BYTES) {
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        throw new Error('Antwort-Stream überschritt das Größenlimit — abgebrochen.')
      }
      // heartbeat-only stall: real tokens started, then bytes keep arriving (SSE keep-alives) but
      // no further progress for too long. Only armed AFTER the first token (sawProgress) so a long
      // silent prefill isn't mistaken for a hang.
      if (sawProgress && Date.now() - lastProgressAt > STREAM_IDLE_TIMEOUT_MS) {
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        throw new Error(idleMsg)
      }
    }
    // Flush any incomplete multi-byte sequence and the final newline-less line.
    buffer += decoder.decode()
    drainLines()
    const tail = buffer.trim()
    if (tail.startsWith('data:')) handleData(tail.slice(5).trim())

    // The provider signalled an error via finish_reason without a top-level {"error":…} object —
    // don't return a half/empty result as if it were a clean answer; surface it as a real error.
    if (finishReason === 'error') {
      throw new Error('Antwort-Stream vom Provider mit Fehler beendet (finish_reason=error) — meist Überlastung/Timeout. Erneut versuchen oder Modell wechseln.')
    }

    let toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ ...v, arguments: cleanToolArgs(v.arguments) }))
      .filter((t) => t.name)

    // No structured tool call but the model dumped <tool_call>…</tool_call> into the content
    // (Hermes/XML-style serving, e.g. Qwen3-VL). Recover them so the agent doesn't silently stall.
    if (toolCalls.length === 0 && content.includes('<tool_call>')) {
      const recovered = parseHermesToolCalls(content)
      if (recovered.length) toolCalls = recovered
    }

    callbacks.onDone?.(finishReason)
    return { content, reasoning, toolCalls, finishReason, usage }
  }
}

function backoff(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000)
  return base + Math.floor((attempt * 137 + 250) % 500) // small deterministic jitter
}
