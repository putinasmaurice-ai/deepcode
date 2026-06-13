import { ProviderSettings, Session, TokenUsage } from '@shared/types'
import { RawUsage } from './deepseek'

// Cost attribution for a completed API round. Local models are free.
export function costOf(provider: ProviderSettings, usage: RawUsage, model?: string): TokenUsage {
  if (model?.startsWith('local:')) return { ...usage, cost: 0 }
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
  const cost =
    (fresh / 1_000_000) * inPrice +
    (cached / 1_000_000) * cachedPrice +
    (usage.completionTokens / 1_000_000) * outPrice
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
