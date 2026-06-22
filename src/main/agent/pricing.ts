import { ProviderSettings, Session, TokenUsage } from '@shared/types'
import { RawUsage } from './deepseek'
import { offPeakStatus, offPeakEligible } from '@shared/offpeak'

type Rates = { in: number; cached?: number; out: number }

// Real DeepInfra per-model rates (USD per 1M tokens), researched 2026-06 from deepinfra.com model
// pages (input/output high-confidence; cached medium). A missing `cached` means the model has no
// prompt-cache discount (e.g. gemma-4) → cached input is billed at the full input rate. Keys are
// the model id AFTER the "deepinfra:" prefix, lowercased. This is only the FALLBACK: when the API
// returns its own usage.estimated_cost (DeepInfra does) we trust that instead, so drift here rarely
// affects the displayed cost. Update these if DeepInfra changes its list prices.
const DEEPINFRA_PRICES: Record<string, Rates> = {
  'zai-org/glm-5.2': { in: 1.0, cached: 0.18, out: 4.0 },
  'qwen/qwen3-coder-480b-a35b-instruct-turbo': { in: 0.3, cached: 0.1, out: 1.0 },
  'moonshotai/kimi-k2.6': { in: 0.75, cached: 0.15, out: 3.5 },
  'google/gemma-4-31b-it': { in: 0.13, out: 0.38 },
  // MiMo is no longer offered via DeepInfra (it runs cheaper via openrouter:xiaomi/mimo-v2.5-pro).
  'deepseek-ai/deepseek-v3': { in: 0.32, out: 0.89 }
}

// Anthropic list prices (USD per 1M) — used when a Kilo gateway route names a Claude model so a
// paid route isn't recorded as $0.
const ANTHROPIC_PRICES: Record<string, Rates> = {
  'anthropic/claude-sonnet-4': { in: 3.0, cached: 0.3, out: 15.0 }
}

// OpenRouter per-model FALLBACK rates (USD per 1M), keyed on the id after "openrouter:" (lowercased).
// Normally UNUSED: OpenRouter returns its own usage.cost (we request it) which costOf trusts — so the
// chat figure matches the real bill exactly. These are STABLE (non-promo) standard rates that only
// kick in if usage.cost is ever missing, so the displayed cost is never a wrong $0. As of 2026-06.
const OPENROUTER_PRICES: Record<string, Rates> = {
  'xiaomi/mimo-v2.5-pro': { in: 0.435, out: 0.87 },
  'google/gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
  'z-ai/glm-4.7-flash': { in: 0.06, out: 0.4 },
  'deepseek/deepseek-v4-flash': { in: 0.09, out: 0.18 },
  'qwen/qwen3-coder-flash': { in: 0.3, cached: 0.06, out: 1.5 }, // stable base (not the live 35%-off promo)
  'openai/gpt-oss-20b': { in: 0.029, out: 0.14 },
  'openai/gpt-oss-120b': { in: 0.039, out: 0.18 },
  // flagships (verified vs the OpenRouter API 2026-06). grok-4.3 lists a higher tier above 200k
  // total tokens; the live usage.cost (trusted first) reflects it — this base rate is fallback only.
  'x-ai/grok-4.3': { in: 1.25, cached: 0.2, out: 2.5 },
  'minimax/minimax-m3': { in: 0.3, cached: 0.06, out: 1.2 },
  'moonshotai/kimi-k2.7-code': { in: 0.612, cached: 0.1296, out: 3.069 }
  // openai/gpt-oss-120b:free intentionally absent → free routes report cost 0 (honored below)
}

const VENDOR_PREFIXES = ['deepinfra:', 'google:', 'openai:', 'together:', 'mimo:', 'kilo:', 'openrouter:']

// fresh + cached prompt split (cached is a SUBSET of prompt tokens — subtract it, never add) plus
// output, all per 1M. cachedRate clamps to the input rate, so a model without a cache discount is a
// no-op and an explicit cheaper cached rate is honored.
function splitCost(usage: RawUsage, r: Rates): number {
  const cachedRate = Math.min(r.in, r.cached ?? r.in)
  const cached = Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens)
  const fresh = usage.promptTokens - cached
  return (fresh / 1_000_000) * r.in + (cached / 1_000_000) * cachedRate + (usage.completionTokens / 1_000_000) * r.out
}

// Per-1M rates for a prefixed (non-DeepSeek) model: DeepInfra per-MODEL from the table, Kilo by its
// underlying routed model, the rest by the configurable flat per-vendor rate (0 = unpriced/free).
function vendorRates(provider: ProviderSettings, model: string): Rates {
  if (model.startsWith('deepinfra:')) {
    return (
      DEEPINFRA_PRICES[model.slice('deepinfra:'.length).toLowerCase()] ?? {
        in: provider.deepinfraPricePerMillionInput ?? 0,
        out: provider.deepinfraPricePerMillionOutput ?? 0
      }
    )
  }
  if (model.startsWith('kilo:')) {
    const under = model.slice('kilo:'.length).toLowerCase()
    return (
      DEEPINFRA_PRICES[under] ??
      ANTHROPIC_PRICES[under] ?? {
        in: provider.kiloPricePerMillionInput ?? 0,
        out: provider.kiloPricePerMillionOutput ?? 0
      }
    )
  }
  if (model.startsWith('openrouter:')) {
    return (
      OPENROUTER_PRICES[model.slice('openrouter:'.length).toLowerCase()] ?? {
        in: provider.openrouterPricePerMillionInput ?? 0,
        out: provider.openrouterPricePerMillionOutput ?? 0
      }
    )
  }
  if (model.startsWith('google:')) return { in: provider.googlePricePerMillionInput ?? 0, out: provider.googlePricePerMillionOutput ?? 0 }
  if (model.startsWith('openai:')) return { in: provider.openaiPricePerMillionInput ?? 0, out: provider.openaiPricePerMillionOutput ?? 0 }
  if (model.startsWith('together:')) return { in: provider.togetherPricePerMillionInput ?? 0, out: provider.togetherPricePerMillionOutput ?? 0 }
  return { in: provider.mimoPricePerMillionInput ?? 0, out: provider.mimoPricePerMillionOutput ?? 0 } // mimo:
}

// Cost attribution for a completed API round. `at` = round time (for the DeepSeek off-peak
// discount). Order: (1) trust the provider's own reported cost when present; (2) local: free;
// (3) prefixed vendors via per-model/flat rates; (4) DeepSeek/configured card (reasoner + cache +
// off-peak). An unknown id is NOT silently billed at DeepSeek rates.
export function costOf(provider: ProviderSettings, usage: RawUsage, model?: string, at: number = Date.now()): TokenUsage {
  // (1) provider-authoritative cost (DeepInfra estimated_cost / OpenRouter usage.cost) — matches the
  // real invoice exactly regardless of table staleness. Trusted when > 0, AND a reported 0 on a
  // ":free" route is honored as a real $0 (so a free model always shows free, whatever the table says).
  if (
    typeof usage.reportedCost === 'number' &&
    isFinite(usage.reportedCost) &&
    (usage.reportedCost > 0 || (usage.reportedCost === 0 && !!model && model.endsWith(':free')))
  ) {
    return { ...usage, cost: usage.reportedCost }
  }

  if (model?.startsWith('local:')) return { ...usage, cost: 0 }

  // (3) prefixed vendors — per-model (DeepInfra) or flat per-vendor rates, cached split, no off-peak
  if (model && VENDOR_PREFIXES.some((p) => model.startsWith(p))) {
    return { ...usage, cost: splitCost(usage, vendorRates(provider, model)) }
  }

  // (4) DeepSeek / configured card. GATE it: only genuine DeepSeek ids, the configured primary/
  // reasoner model, or an absent id (the default route) get this card — an unknown bare id is
  // returned as unpriced (cost 0) rather than silently billed at DeepSeek rates.
  const isConfigured = !model || /deepseek/i.test(model) || model === provider.model || model === provider.reasonerModel
  if (!isConfigured) return { ...usage, cost: 0 }

  // the reasoner has its own price card (falls back to chat prices if unset)
  const isReasoner = !!model && model === provider.reasonerModel
  const inPrice = isReasoner
    ? provider.reasonerPricePerMillionInput || provider.pricePerMillionInput || 0
    : provider.pricePerMillionInput || 0
  const outPrice = isReasoner
    ? provider.reasonerPricePerMillionOutput || provider.pricePerMillionOutput || 0
    : provider.pricePerMillionOutput || 0
  // Prompt-cache hits are billed at a fraction of the miss price. ?? (not ||) so an explicit 0
  // ("cache reads are free") is honored; clamp so the cached rate can never exceed the miss rate.
  const cachedPrice = Math.min(
    inPrice,
    (isReasoner ? provider.reasonerCachedPricePerMillionInput : provider.cachedPricePerMillionInput) ?? inPrice
  )
  const cached = Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens)
  const fresh = usage.promptTokens - cached
  let cost =
    (fresh / 1_000_000) * inPrice +
    (cached / 1_000_000) * cachedPrice +
    (usage.completionTokens / 1_000_000) * outPrice
  // DeepSeek discounts the off-peak window (chat ~-50%, reasoner ~-75%); apply it to the RECORDED
  // cost too, else the ledger/budget overstate spend 2-4x. ONLY for the first-party DeepSeek route
  // (offPeakEligible) — a configured non-DeepSeek primary or a hosted DeepSeek doesn't honor it.
  const off = offPeakStatus(new Date(at))
  if (off.active && offPeakEligible(model)) cost *= 1 - (isReasoner ? off.reasonerDiscount : off.chatDiscount)
  return { ...usage, cost }
}

// Rough token estimate (~4 chars/token) used for the auto-compaction trigger. Counts only what
// actually goes on the wire: assistant chain-of-thought (m.reasoning) is NEVER re-sent by
// toApiMessages, so including it would over-estimate the real context (esp. on reasoner sessions)
// and trigger compaction too early.
export function estimateTokens(session: Session): number {
  let chars = 0
  for (const m of session.messages) chars += m.content?.length ?? 0
  return Math.ceil(chars / 4)
}
