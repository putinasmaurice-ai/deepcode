import { randomUUID } from 'crypto'
import { ChatMessage, Session, TokenUsage } from '@shared/types'
import { EngineDeps, Emit } from './deps'
import { saveSession } from '../store'
import { costOf } from './pricing'
import { recordUsage } from '../ledger'
import { distillMemories } from './distill'

// Summarize older turns into one synthetic message to keep context small while
// preserving recent turns and tool-call/result pairing.
export async function compactSession(
  deps: EngineDeps,
  session: Session,
  emit: Emit,
  onUsage?: (u: TokenUsage) => void // trace/cost bubbling for the compaction round
): Promise<Session> {
  const msgs = session.messages
  if (msgs.length < 8) {
    emit({ type: 'status', message: 'Nothing to compact yet.' })
    return session
  }
  // Keep the last ~6 messages verbatim; never split an assistant tool_calls
  // block from its tool responses.
  let cut = Math.max(2, msgs.length - 6)
  while (cut < msgs.length && msgs[cut].role === 'tool') cut++
  const older = msgs.slice(0, cut)
  const recent = msgs.slice(cut)

  const transcript = older
    .map((m) => {
      if (m.role === 'tool') return `TOOL(${m.toolName}): ${m.content.slice(0, 800)}`
      const tc = m.toolCalls?.length ? ` [called: ${m.toolCalls.map((t) => t.name).join(', ')}]` : ''
      return `${m.role.toUpperCase()}: ${m.content.slice(0, 2000)}${tc}`
    })
    .join('\n\n')

  emit({ type: 'status', message: 'Compacting conversation…' })
  // reentrant: auto-compaction inside runTurn already holds the session lock —
  // share the parent's signal so cancel aborts the compaction too
  const existing = deps.current(session.id)
  const ownsLock = !existing
  const signal = existing ? existing.signal : deps.acquire(session.id).signal
  let summary = ''
  try {
    const res = await deps.client.streamChat(
      [
        {
          role: 'system',
          content:
            'You compress a coding-assistant conversation. Produce a dense summary that preserves: the user goals, decisions made, files created/edited (with paths), key findings, commands run and their outcomes, and any open TODOs. Keep it factual and compact.'
        },
        { role: 'user', content: `Summarize this conversation so work can continue:\n\n${transcript}` }
      ],
      [],
      {},
      signal,
      session.model
    )
    summary = res.content
    if (res.usage) {
      const u = costOf(deps.settings.provider, res.usage, session.model)
      recordUsage(u)
      onUsage?.(u)
    }
  } catch (e) {
    emit({ type: 'error', message: `Compaction failed: ${(e as Error).message}` })
    return session
  } finally {
    if (ownsLock) deps.release(session.id)
  }

  const synthetic: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: `<conversation-summary>\n${summary}\n</conversation-summary>`,
    createdAt: Date.now(),
    auto: 'compaction' // muted "context compacted" note in the UI; still sent to the model
  }
  session.messages = [synthetic, ...recent]
  saveSession(session)
  emit({ type: 'status', message: `Compacted ${older.length} messages into a summary.` })

  // opt-in auto-memory: distil durable facts from the FULL pre-compaction transcript (the
  // detail being summarized away is exactly what's worth remembering). Fire-and-forget so it
  // never delays the turn; reads `msgs` (the pre-compaction snapshot, since session.messages
  // was just reassigned), saves independent memory files.
  if (deps.settings.autoMemory) {
    distillMemories(deps, { ...session, messages: msgs }, session.projectId)
      .then((saved) => {
        if (saved.length) emit({ type: 'status', message: `🧠 ${saved.length} bleibende Fakt(en) ins Memory aufgenommen.` })
      })
      .catch(() => {
        /* best-effort — auto-memory must never disrupt a turn */
      })
  }
  return session
}
