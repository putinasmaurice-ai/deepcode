import { relative, sep } from 'path'
import { TimelineTick, TimelineTickFile, TickDetail, ChatMessage, Trace } from '@shared/types'
import { listTraces, getTrace } from '../trace-store'
import { listTurnTags, getTurnSnapshotMeta } from '../checkpoints'
import { getSession } from '../store'
import { buildTickDiff } from './reconstruct'

// Time Machine timeline: fuse the three PERSISTED per-turn stores — traces (reasoning/cost),
// checkpoints (restorable FS pre-images) and session messages — into ONE chronological list of
// ticks (one tick = one agent TURN, keyed by its millisecond turnTag). Honest about gaps: a turn
// with no surviving trace is status 'unknown'; a turn with only skipped pre-images is not
// restorable. Background jobs / preview frames are in-memory only and never appear here.

const MERGE_MS = 50 // turn-starts within this window are the same turn (trace.turnTag wins as tick)
const CLIP_EXCERPT = 140
const CLIP_MESSAGE = 4000

function relOf(cwd: string, abs: string): string {
  if (!cwd) return abs
  try {
    return relative(cwd, abs).split(sep).join('/')
  } catch {
    return abs
  }
}

function clip(s: string, n: number): string {
  const t = (s || '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// Assign a timestamp to the NEAREST tick start (ties → the later tick). The user message that
// INITIATES a turn is created just BEFORE that turn's tick (the engine stamps the turnTag only
// after the user message + any image-describe/compaction), so a naive [start,end) window would
// mis-file the prompt onto the PREVIOUS tick. Nearest-start places it on the turn it began.
function nearestIndex(starts: number[], ms: number): number {
  let best = 0
  let bestDiff = Number.POSITIVE_INFINITY
  for (let i = 0; i < starts.length; i++) {
    const d = Math.abs(ms - starts[i])
    if (d <= bestDiff) {
      bestDiff = d
      best = i
    }
  }
  return best
}

function isoOf(ms: number): string {
  try {
    return new Date(ms).toLocaleString('de-DE')
  } catch {
    return String(ms)
  }
}

// A derived turn-start: either a trace's canonical turnTag/startedAt, or a checkpoint tag.
interface Start {
  tick: number
  trace?: Trace
  fromTag: boolean // a checkpoint tag contributed this start
  preferred: boolean // a real trace.turnTag value (canonical) — wins merge
}

function deriveStarts(traces: Trace[], tags: string[]): Start[] {
  const starts: Start[] = []
  for (const t of traces) {
    const tagged = Number(t.turnTag)
    const hasTag = Number.isFinite(tagged)
    starts.push({ tick: hasTag ? tagged : t.startedAt, trace: t, fromTag: false, preferred: hasTag })
  }
  for (const tag of tags) {
    const n = Number(tag)
    if (Number.isFinite(n)) starts.push({ tick: n, fromTag: true, preferred: false })
  }
  return starts.sort((a, b) => a.tick - b.tick)
}

// Collapse starts within MERGE_MS into one canonical tick (prefer a trace.turnTag value).
function mergeStarts(starts: Start[]): { tick: number; trace?: Trace }[] {
  const out: { tick: number; trace?: Trace }[] = []
  for (const s of starts) {
    const last = out[out.length - 1]
    if (last && s.tick - last.tick <= MERGE_MS) {
      if (!last.trace && s.trace) last.trace = s.trace
      if (s.preferred) last.tick = s.tick // canonical turnTag overrides a fuzzy startedAt
      continue
    }
    out.push({ tick: s.tick, trace: s.trace })
  }
  return out
}

function spanStats(trace?: Trace): { tools: number; topError?: string } {
  if (!trace) return { tools: 0 }
  let tools = 0
  let topError: string | undefined
  for (const sp of trace.spans) {
    if (sp.kind === 'tool') tools++
    if (!topError && sp.status === 'error' && sp.error) topError = clip(sp.error, CLIP_EXCERPT)
  }
  return { tools, topError }
}

function tickFiles(sessionId: string, cwd: string, tag?: string): TimelineTickFile[] {
  if (!tag) return []
  return getTurnSnapshotMeta(sessionId, tag).map((m) => ({
    path: m.path,
    rel: relOf(cwd, m.path),
    existed: m.existed,
    skipped: m.skipped
  }))
}

// Correlate the three stores into chronological TimelineTick[] (oldest first).
export function buildTimeline(sessionId: string): TimelineTick[] {
  const session = getSession(sessionId)
  const cwd = session?.cwd ?? ''
  const messages = session?.messages ?? []
  let traces: Trace[] = []
  let tags: string[] = []
  try {
    traces = listTraces(sessionId, 1000)
  } catch {
    traces = []
  }
  try {
    tags = listTurnTags(sessionId)
  } catch {
    tags = []
  }
  const merged = mergeStarts(deriveStarts(traces, tags))
  if (!merged.length) return []

  // each message is filed onto its NEAREST tick (handles the initiating prompt created pre-turnTag).
  const starts = merged.map((m) => m.tick)
  const msgTick = messages.map((m) => nearestIndex(starts, m.createdAt))

  const ticks: TimelineTick[] = []
  for (let i = 0; i < merged.length; i++) {
    const start = merged[i].tick
    const end = i + 1 < merged.length ? merged[i + 1].tick : Number.POSITIVE_INFINITY
    const trace =
      merged[i].trace ?? traces.find((t) => Number(t.turnTag) === start) ?? traces.find((t) => t.startedAt === start)
    const checkpointTag = tags.find((t) => Number(t) >= start && Number(t) < end)
    const files = tickFiles(sessionId, cwd, checkpointTag)
    const skippedFiles = files.filter((f) => f.skipped).length

    const inWindow = messages.filter((_, k) => msgTick[k] === i)
    const userExcerpt = inWindow.find((m) => m.role === 'user' && m.content)?.content
    const assistantExcerpt = inWindow.find((m) => m.role === 'assistant' && m.content)?.content
    const { tools, topError } = spanStats(trace)

    ticks.push({
      tick: start,
      iso: isoOf(start),
      sessionId,
      traceId: trace?.id,
      checkpointTag,
      status: trace ? trace.status : 'unknown',
      model: trace?.model,
      costUsd: trace?.costUsd ?? 0,
      tokens: trace?.tokens ?? 0,
      spanCount: trace?.spans.length ?? 0,
      toolCount: tools,
      topError,
      files,
      restorable: files.some((f) => !f.skipped),
      userExcerpt: userExcerpt ? clip(userExcerpt, CLIP_EXCERPT) : undefined,
      assistantExcerpt: assistantExcerpt ? clip(assistantExcerpt, CLIP_EXCERPT) : undefined,
      messageCount: inWindow.length,
      hasTrace: !!trace,
      hasCheckpoint: !!checkpointTag,
      skippedFiles
    })
  }
  return ticks
}

// Expanded detail for one selected tick: its TimelineTick, the full trace (when it survived),
// the turn-window messages (clipped) and a unified diff of the turn's file changes.
export function buildTickDetail(sessionId: string, tick: number): TickDetail | null {
  const timeline = buildTimeline(sessionId)
  const idx = timeline.findIndex((t) => t.tick === tick)
  if (idx === -1) return null
  const t = timeline[idx]

  // same nearest-tick filing as buildTimeline so the inspector shows exactly this turn's messages.
  const starts = timeline.map((tk) => tk.tick)
  const session = getSession(sessionId)
  const messages: ChatMessage[] = (session?.messages ?? [])
    .filter((m) => nearestIndex(starts, m.createdAt) === idx)
    .map((m) => ({ ...m, content: clip(m.content, CLIP_MESSAGE) }))

  const trace = t.traceId ? getTrace(t.traceId) ?? undefined : undefined
  let diff = ''
  try {
    diff = buildTickDiff(sessionId, tick)
  } catch {
    diff = ''
  }
  return { tick: t, trace, messages, diff: diff || undefined }
}
