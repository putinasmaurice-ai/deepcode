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
  { pattern: /grok-4\.3/i, context: 1_000_000 }, // xAI Grok 4.3: 1M (verified)
  { pattern: /grok/i, context: 2_000_000 }, // xAI Grok 4.1 Fast: up to 2M
  { pattern: /gpt-oss/i, context: 131_072 }, // OpenAI gpt-oss 20b/120b: 131K
  { pattern: /minimax[-_\s]?m3/i, context: 1_048_576 }, // MiniMax M3: 1M (verified)
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
// Friendly dropdown display names + ORDER. Keyed by the full prefixed model id. The dropdown shows
// known models in THIS order with these exact labels; any other model falls back to a provider-icon
// + raw id and is appended afterwards. Labels only affect display — the stored model id is unchanged.
export const MODEL_DISPLAY: { id: string; label: string }[] = [
  { id: 'deepseek-chat', label: 'DeepSeek v4 Flash official' },
  { id: 'deepseek-reasoner', label: 'DeepSeek v4 Pro official' },
  { id: 'deepinfra:deepseek-ai/DeepSeek-V4-Flash', label: 'DI DeepSeek v4 Flash' },
  { id: 'deepinfra:openai/gpt-oss-120b', label: 'DI GPT 120b' },
  { id: 'deepinfra:Qwen/Qwen3-VL-235B-A22B-Instruct', label: 'DI Qwen 3 235b' },
  { id: 'deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo', label: 'DI Qwen 3 480b' },
  { id: 'deepinfra:zai-org/GLM-5.2', label: 'DI GLM 5.2' },
  { id: 'deepinfra:google/gemma-4-31B-it', label: 'DI Gemma 4' },
  { id: 'deepinfra:moonshotai/Kimi-K2.6', label: 'DI Kimi 2.6' },
  { id: 'openrouter:moonshotai/kimi-k2.7-code', label: 'OR Kimi 2.7 Code' },
  { id: 'openrouter:openai/gpt-oss-120b:free', label: 'OR GPT 120b' },
  { id: 'openrouter:openai/gpt-oss-20b', label: 'OR GPT 20b' },
  { id: 'openrouter:xiaomi/mimo-v2.5-pro', label: 'OR Mimo 2.5 Pro' },
  { id: 'openrouter:deepseek/deepseek-v4-flash', label: 'OR DeepSeek v4 Flash' },
  { id: 'openrouter:z-ai/glm-4.7-flash', label: 'OR GLM 4.7' },
  { id: 'openrouter:google/gemini-2.5-flash-lite', label: 'OR Gemini 2.5 Flash' },
  { id: 'openrouter:x-ai/grok-4.3', label: 'OR Grok 4.3' },
  { id: 'openrouter:minimax/minimax-m3', label: 'OR MiniMax M3' },
  { id: 'openrouter:qwen/qwen3-coder-flash', label: 'OR Qwen 3 Coder' },
  { id: 'local:qwen3-coder:30b', label: 'Lokal Qwen 3 Coder' },
  { id: 'local:qwen2.5vl:7b', label: 'Lokal Qwen 2.5 7b' },
  { id: 'local:huihui_ai/qwen2.5-abliterate:14b', label: 'Lokal Qwen 2.5 uncensored' },
  { id: 'local:dolphin3:latest', label: 'Lokal Dolphin 3 uncensored' },
  { id: 'local:mellum2', label: 'Lokal Mellum 2' },
  { id: 'kilo:kilo/auto', label: 'Kilo/Auto' }
]

const LABEL_BY_ID = new Map(MODEL_DISPLAY.map((m) => [m.id, m.label]))
const ORDER_BY_ID = new Map(MODEL_DISPLAY.map((m, i) => [m.id, i]))

// Fallback label for a model NOT in MODEL_DISPLAY: provider-icon + the id minus its routing prefix.
function iconLabel(id: string): string {
  const p: [string, string][] = [
    ['local:', '💻 '],
    ['deepinfra:', '☁️ '],
    ['together:', '🧩 '],
    ['mimo:', '📱 '],
    ['kilo:', '🦘 '],
    ['openrouter:', '🌐 ']
  ]
  for (const [prefix, icon] of p) if (id.startsWith(prefix)) return icon + id.slice(prefix.length)
  return id
}

// Dropdown label for a model id: the curated friendly name, else the icon + raw id.
export function modelLabel(id: string): string {
  return LABEL_BY_ID.get(id) ?? iconLabel(id)
}

// Sort key: curated models keep MODEL_DISPLAY order; everything else sorts after (stable).
export function modelOrder(id: string): number {
  return ORDER_BY_ID.get(id) ?? Number.MAX_SAFE_INTEGER
}

export const SUGGESTED_MODELS: string[] = [
  'deepinfra:zai-org/GLM-5.2', // Z.ai GLM-5.2 — 1M context, agentic/coding flagship (via DeepInfra)
  'deepinfra:Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo', // Qwen3-Coder 480B — agentic coding (256K), ~Claude Sonnet
  'deepinfra:moonshotai/Kimi-K2.6', // Kimi K2.6 — agentic, native function-calling, 256K
  'deepinfra:google/gemma-4-31B-it', // Google Gemma 4 31B — dense, 256K context, multimodal
  'openrouter:xiaomi/mimo-v2.5-pro', // Xiaomi MiMo V2.5 Pro via OpenRouter — far cheaper than DeepInfra (~$0.44/$0.87) — needs OpenRouter key
  // --- OpenRouter value picks (tool-calling confirmed; need an OpenRouter key) ---
  'openrouter:openai/gpt-oss-120b:free', // FREE, native tool-calling, 131K — smart zero-cost default (rate-limited)
  'openrouter:openai/gpt-oss-20b', // cheapest capable workhorse ~$0.03/$0.14, tools, 131K
  'openrouter:deepseek/deepseek-v4-flash', // V4 Flash — 1M context, cheap output ~$0.09/$0.18, agentic
  'openrouter:z-ai/glm-4.7-flash', // GLM 4.7 Flash — cheapest agentic coder ~$0.06/$0.40, 203K
  'openrouter:qwen/qwen3-coder-flash', // Qwen3-Coder Flash — 1M, autonomous coding ~$0.20/$0.98
  'openrouter:google/gemini-2.5-flash-lite', // Gemini 2.5 Flash Lite — fast all-rounder + vision, 1M ~$0.10/$0.40
  // --- OpenRouter flagships (max capability; pricier) — verified against the OpenRouter API ---
  'openrouter:x-ai/grok-4.3', // Grok 4.3 — xAI reasoning flagship, 1M, ~$1.25/$2.50 (cached $0.20)
  'openrouter:minimax/minimax-m3', // MiniMax M3 — top agentic/MCP open-weight, 1M, ~$0.30/$1.20
  'openrouter:moonshotai/kimi-k2.7-code', // Kimi K2.7 Code — long-horizon coding flagship, 256K, ~$0.61/$3.07
  'kilo:kilo/auto' // Kilo Code gateway — smart routing
]
