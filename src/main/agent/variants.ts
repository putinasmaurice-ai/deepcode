import { ChatMessage, Session } from '@shared/types'
import { EngineDeps, Emit } from './deps'
import { buildSystemPrompt } from './prompt'
import { toApiMessages } from './api-messages'
import { newAssistantMessage, streamCallbacksFor } from './streaming'
import { costOf } from './pricing'
import { recordUsage } from '../ledger'
import { getProject } from '../projects'
import { saveSession } from '../store'

// Alternative-answer features (no tools, one round each):
// - second opinion: the reasoner model independently reviews the last answer
// - arena: two models answer in parallel, the user votes

function variantSystem(deps: EngineDeps, session: Session, modeNote: string): string {
  const project = session.projectId ? getProject(session.projectId) : null
  return (
    buildSystemPrompt({
      cwd: session.cwd,
      skills: [],
      customInstructions: deps.settings.customInstructions,
      project: project
        ? { name: project.name, instructions: project.instructions, goal: project.goal }
        : null,
      sessionGoal: session.goal
    }) + modeNote
  )
}

async function streamVariant(
  deps: EngineDeps,
  session: Session,
  emit: Emit,
  system: string,
  model: string,
  variant: 'second-opinion' | 'arena',
  signal: AbortSignal
): Promise<ChatMessage> {
  const msg = newAssistantMessage({ variant, variantModel: model })
  emit({ type: 'message_start', message: msg })
  const result = await deps.client.streamChat(
    toApiMessages(system, session.messages),
    [],
    streamCallbacksFor(msg, emit),
    signal,
    model
  )
  msg.finishReason = result.finishReason
  if (result.usage) {
    msg.usage = costOf(deps.settings.provider, result.usage, model)
    recordUsage(msg.usage)
    emit({ type: 'usage', messageId: msg.id, usage: msg.usage })
  }
  emit({ type: 'message_done', message: msg })
  return msg
}

export async function runSecondOpinion(deps: EngineDeps, session: Session, emit: Emit): Promise<void> {
  const aborter = deps.acquire(session.id)
  try {
    const model = deps.settings.provider.reasonerModel || deps.settings.provider.model
    const system = variantSystem(
      deps,
      session,
      '\n\n# Second-opinion mode\nReview the conversation and give YOUR OWN independent answer to the last user request. If the previous assistant answer has flaws, point them out concretely; if it is good, say so briefly and add what is missing.'
    )
    const msg = await streamVariant(deps, session, emit, system, model, 'second-opinion', aborter.signal)
    session.messages.push(msg)
    saveSession(session)
  } catch (e) {
    if ((e as Error).name !== 'AbortError') emit({ type: 'error', message: (e as Error).message })
  } finally {
    deps.release(session.id)
    emit({ type: 'turn_done', sessionId: session.id })
  }
}

export async function runArena(
  deps: EngineDeps,
  session: Session,
  emit: Emit,
  modelB?: string
): Promise<void> {
  const aborter = deps.acquire(session.id)
  const modelA = session.model || deps.settings.provider.model
  const b = modelB || deps.settings.provider.reasonerModel || modelA
  const system = variantSystem(
    deps,
    session,
    '\n\n# Arena mode\nAnswer the last user request directly and completely. Tools are unavailable — answer from the conversation context.'
  )

  try {
    const settled = await Promise.allSettled([
      streamVariant(deps, session, emit, system, modelA, 'arena', aborter.signal),
      streamVariant(deps, session, emit, system, b, 'arena', aborter.signal)
    ])
    for (const r of settled) {
      if (r.status === 'fulfilled') session.messages.push(r.value)
      else emit({ type: 'error', message: `Arena: ${(r.reason as Error).message}` })
    }
    saveSession(session)
  } finally {
    deps.release(session.id)
    emit({ type: 'turn_done', sessionId: session.id })
  }
}
