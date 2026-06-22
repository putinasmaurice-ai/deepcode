// Per-model context window sizes (in tokens). Used to drive the context-usage
// pill and to warn before a request would overflow the model's window. These are
// the *usable* input windows, kept slightly conservative on purpose.

interface ModelInfo {
  pattern: RegExp
  context: number
}

const TABLE: ModelInfo[] = [
  { pattern: /deepseek[-_\s]?v4/i, context: 1_000_000 }, // DeepSeek V4 (Flash): 1M
  { pattern: /deepseek/i, context: 64_000 }, // DeepSeek chat + reasoner (V3-era): 64K
  { pattern: /qwen3-coder-flash/i, context: 1_000_000 }, // Qwen3-Coder Flash: 1M
  { pattern: /qwen3-coder|qwen2\.5-coder/i, context: 256_000 },
  { pattern: /qwen3-235b/i, context: 262_144 }, // Qwen3 235B (Instruct/Thinking 2507): 256K
  { pattern: /qwen|qwq/i, context: 32_000 },
  { pattern: /mellum[-_\s]?2/i, context: 131_072 }, // JetBrains Mellum 2 (Thinking MoE): 128K
  { pattern: /mellum/i, context: 8_192 }, // JetBrains Mellum 4b (code completion): 8K
  { pattern: /mimo/i, context: 128_000 }, // Xiaomi MiMo v2/v2.5 (estimate; conservative for the pill)
  { pattern: /glm[-_\s]?5/i, context: 1_000_000 }, // Z.ai GLM-5 / 5.1 / 5.2: up to 1M
  { pattern: /glm[-_\s]?4\.7/i, context: 204_800 }, // GLM 4.7 (Flash): ~203K
  { pattern: /glm[-_\s]?4\.6/i, context: 200_000 }, // GLM-4.6: 200K
  { pattern: /glm/i, context: 128_000 }, // other GLM (4.5 etc.)
  { pattern: /gemma[-_\s]?4/i, context: 262_144 }, // Google Gemma 4: 256K
  { pattern: /gemma[-_\s]?3/i, context: 128_000 }, // Google Gemma 3: 128K
  { pattern: /kimi/i, context: 262_144 }, // Moonshot Kimi K2.x: 256K
  { pattern: /grok/i, context: 2_000_000 }, // xAI Grok 4.x (Fast): up to 2M
  { pattern: /gpt-oss/i, context: 131_072 }, // OpenAI gpt-oss 20b/120b: 131K
  { pattern: /minimax/i, context: 204_800 }, // MiniMax M2: ~205K
  { pattern: /gemini/i, context: 1_000_000 }, // Google Gemini 2.x (Flash/Pro): ~1M
  { pattern: /llama3\.[12]|llama-3\.[12]/i, context: 128_000 },
  { pattern: /llama|mistral|mixtral|dolphin|gemma|phi/i, context: 32_000 },
  { pattern: /gpt-4o|gpt-4\.1|o[134]/i, context: 128_000 },
  { pattern: /claude/i, context: 200_000 }
]

const DEFAULT_CONTEXT = 32_000

// Best-effort context window for a model id. Strips any routing prefix first so the underlying
// model name is matched (e.g. `kilo:anthropic/claude-sonnet-4` → claude → 200K).
export function contextLimit(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT
  const name = model.replace(/^(local|google|deepinfra|openai|together|mimo|kilo|openrouter):/, '')
  for (const { pattern, context } of TABLE) if (pattern.test(name)) return context
  return DEFAULT_CONTEXT
}

// Curated local models surfaced as ready-to-pick options in the model dropdown, in ADDITION to
// whatever Ollama already has installed (those are auto-listed). Full `local:` ids. Pull it first,
// e.g. `ollama pull hf.co/JetBrains/Mellum2-12B-A2.5B-Thinking-GGUF-Q4_K_M` (or your own tag named
// `mellum2`) — JetBrains' Mellum 2 is a 12B MoE "Thinking" code model with a 128K window.
export const SUGGESTED_LOCAL_MODELS: string[] = ['local:mellum2']

// Curated CLOUD models surfaced as ready-to-pick options in the model dropdown (the matching
// provider key must be set in Settings). Always visible, regardless of the user's saved
// extraModels list — so a freshly added model shows up without editing settings by hand.
export const SUGGESTED_MODELS: string[] = [
  'deepinfra:zai-org/GLM-5.2', // Z.ai GLM-5.2 — 1M context, agentic/coding flagship (via DeepInfra)
  'deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo', // Qwen3-Coder 480B — agentic coding (256K), ~Claude Sonnet
  'deepinfra:moonshotai/Kimi-K2.6', // Kimi K2.6 — agentic, native function-calling, 256K
  'deepinfra:google/gemma-4-31B-it', // Google Gemma 4 31B — dense, 256K context, multimodal
  'deepinfra:XiaomiMiMo/MiMo-V2.5-Pro', // Xiaomi MiMo V2.5 Pro (MoE, omnimodal) — via DeepInfra (uses your DeepInfra key; the mimo: prefix is Xiaomi's own free token-plan endpoint)
  'openrouter:xiaomi/mimo-v2.5-pro', // SAME MiMo, far cheaper via OpenRouter (Xiaomi first-party ~$0.44/$0.87 vs DeepInfra ~$1/$3) — needs OpenRouter key
  // --- OpenRouter value picks (tool-calling confirmed; need an OpenRouter key) ---
  'openrouter:openai/gpt-oss-120b:free', // FREE, native tool-calling, 131K — smart zero-cost default (rate-limited)
  'openrouter:openai/gpt-oss-20b', // cheapest capable workhorse ~$0.03/$0.14, tools, 131K
  'openrouter:deepseek/deepseek-v4-flash', // V4 Flash — 1M context, cheap output ~$0.09/$0.18, agentic
  'openrouter:z-ai/glm-4.7-flash', // GLM 4.7 Flash — cheapest agentic coder ~$0.06/$0.40, 203K
  'openrouter:qwen/qwen3-coder-flash', // Qwen3-Coder Flash — 1M, autonomous coding ~$0.20/$0.98
  'openrouter:x-ai/grok-4.1-fast', // Grok 4.1 Fast — 2M context, strong agentic tool-calling ~$0.20/$0.50
  'kilo:kilo/auto' // Kilo Code gateway — smart routing
]
