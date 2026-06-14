import { ProviderSettings, Session, TokenUsage } from '@shared/types'
import { RawUsage } from './deepseek'
import { offPeakStatus } from '@shared/offpeak'

// Cost attribution for a completed API round. `at` = round time (defaults to now) for the
// DeepSeek off-peak discount. Models are priced by their vendor PREFIX — google:/deepinfra:
// must NOT use DeepSeek's price card; local: is free.
export function costOf(provider: ProviderSettings, usage: RawUsage, model?: string, at: number = Date.now()): TokenUsage {
  if (model?.startsWith('local:')) return { ...usage, cost: 0 }

  // ---- non-DeepSeek vendors: flat per-vendor pricing (no reasoner/cache split, no off-peak) ----
  if (
    model?.startsWith('deepinfra:') ||
    model?.startsWith('google:') ||
    model?.startsWith('openai:') ||
    model?.startsWith('together:')
  ) {
    const vIn = model.startsWith('google:')
      ? provider.googlePricePerMillionInput
      : model.startsWith('openai:')
        ? provider.openaiPricePerMillionInput
        : model.startsWith('together:')
          ? provider.togetherPricePerMillionInput
          : provider.deepinfraPricePerMillionInput
    const vOut = model.startsWith('google:')
      ? provider.googlePricePerMillionOutput
      : model.startsWith('openai:')
        ? provider.openaiPricePerMillionOutput
        : model.startsWith('together:')
          ? provider.togetherPricePerMillionOutput
          : provider.deepinfraPricePerMillionOutput
    const cost = (usage.promptTokens / 1_000_000) * (vIn ?? 0) + (usage.completionTokens / 1_000_000) * (vOut ?? 0)
    return { ...usage, cost }
  }

  // ---- DeepSeek: reasoner/chat card + prompt-cache split + off-peak discount ----
  // the reasoner has its own price card (falls back to chat prices if unset)
  const isReasoner = !!model && model === provider.reasonerModel
  const inPrice = isReasoner
    ? provider.reasonerPricePerMillionInput || provider.pricePerMillionInput || 0
    : provider.pricePerMillionInput || 0
  const outPrice = isReasoner
    ? provider.reasonerPricePerMillionOutput || provider.pricePerMillionOutput || 0
    : provider.pricePerMillionOutput || 0
  // Prompt-cache hits are billed at a fraction of the miss price. Split the prompt
  // tokens into cached (cheap) + fresh and price each correctly.
  // ?? (not ||) so an explicit 0 ("cache reads are free") is honored; clamp so the
  // cached rate can never exceed the miss rate even if mistyped higher.
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
  // DeepSeek discounts the off-peak window (chat ~-50%, reasoner ~-75%). The UI already advertises
  // it; apply it to the RECORDED cost too, else the ledger/budget overstate spend 2-4x.
  const off = offPeakStatus(new Date(at))
  if (off.active) cost *= 1 - (isReasoner ? off.reasonerDiscount : off.chatDiscount)
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
