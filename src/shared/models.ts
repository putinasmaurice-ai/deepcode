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
