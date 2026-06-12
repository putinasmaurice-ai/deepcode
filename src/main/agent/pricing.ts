import { ProviderSettings, Session, TokenUsage } from '@shared/types'
import { RawUsage } from './deepseek'

// Cost attribution for a completed API round. Local models are free.
export function costOf(provider: ProviderSettings, usage: RawUsage, model?: string): TokenUsage {
  if (model?.startsWith('local:')) return { ...usage, cost: 0 }
  const cost =
    (usage.promptTokens / 1_000_000) * (provider.pricePerMillionInput || 0) +
    (usage.completionTokens / 1_000_000) * (provider.pricePerMillionOutput || 0)
  return { ...usage, cost }
}

// Rough token estimate (~4 chars/token) used for the auto-compaction trigger.
export function estimateTokens(session: Session): number {
  let chars = 0
  for (const m of session.messages) chars += (m.content?.length ?? 0) + (m.reasoning?.length ?? 0)
  return Math.ceil(chars / 4)
}
