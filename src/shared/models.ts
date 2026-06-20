// Per-model context window sizes (in tokens). Used to drive the context-usage
// pill and to warn before a request would overflow the model's window. These are
// the *usable* input windows, kept slightly conservative on purpose.

interface ModelInfo {
  pattern: RegExp
  context: number
}

const TABLE: ModelInfo[] = [
  { pattern: /deepseek/i, context: 64_000 }, // DeepSeek chat + reasoner: 64K
  { pattern: /qwen3-coder|qwen2\.5-coder/i, context: 256_000 },
  { pattern: /qwen|qwq/i, context: 32_000 },
  { pattern: /mellum[-_\s]?2/i, context: 131_072 }, // JetBrains Mellum 2 (Thinking MoE): 128K
  { pattern: /mellum/i, context: 8_192 }, // JetBrains Mellum 4b (code completion): 8K
  { pattern: /mimo/i, context: 128_000 }, // Xiaomi MiMo v2/v2.5 (estimate; conservative for the pill)
  { pattern: /llama3\.[12]|llama-3\.[12]/i, context: 128_000 },
  { pattern: /llama|mistral|mixtral|dolphin|gemma|phi/i, context: 32_000 },
  { pattern: /gpt-4o|gpt-4\.1|o[134]/i, context: 128_000 },
  { pattern: /claude/i, context: 200_000 }
]

const DEFAULT_CONTEXT = 32_000

// Best-effort context window for a model id. Strips the "local:" routing prefix.
export function contextLimit(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT
  const name = model.replace(/^local:/, '')
  for (const { pattern, context } of TABLE) if (pattern.test(name)) return context
  return DEFAULT_CONTEXT
}

// Curated local models surfaced as ready-to-pick options in the model dropdown, in ADDITION to
// whatever Ollama already has installed (those are auto-listed). Full `local:` ids. Pull it first,
// e.g. `ollama pull hf.co/JetBrains/Mellum2-12B-A2.5B-Thinking-GGUF-Q4_K_M` (or your own tag named
// `mellum2`) — JetBrains' Mellum 2 is a 12B MoE "Thinking" code model with a 128K window.
export const SUGGESTED_LOCAL_MODELS: string[] = ['local:mellum2']
