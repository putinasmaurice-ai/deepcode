import { randomUUID } from 'crypto'
import { Trace, TraceSpan, TraceSpanKind, TraceStatus } from '@shared/types'
import { saveTrace } from '../trace-store'

// Builds the span tree for one chat turn and persists it incrementally. Kept out of
// the engine so the engine stays readable and the recorder is unit-testable: `persist`
// and `now` are injectable (tests pass a capturing sink + a fake clock — no disk, no
// wall-clock). All methods are best-effort and never throw into the turn.

export interface TraceMeta {
  sessionId: string
  title: string
  cwd: string
  model: string
  unattended?: boolean
}

const DETAIL_CAP = 200
const ERROR_CAP = 300
// 2s (not 500ms): the panel only refreshes on turn_done, so intermediate writes exist only
// for the running-stub + crash-resilience — a longer throttle cuts the per-flush re-serialize
// (whole growing trace) cost on long 60-step turns without hurting the UX.
const PERSIST_THROTTLE_MS = 2000

// Best-effort redaction of common secret shapes before a label/error reaches disk. The trace
// is local-only (same trust tier as audit.log/sessions), but a tool span's detail is the
// summarized command/URL and its error is the failure output — both can carry a token. Mask
// the obvious shapes centrally so no span ever persists an obvious credential. Over-masking a
// display label is harmless; the regexes are anchored on single tokens (whitespace already
// collapsed) so there is no catastrophic backtracking.
const REDACTORS: [RegExp, string][] = [
  [/\b(bearer\s+)\S+/gi, '$1***'],
  [/\b(authorization\s*[:=]\s*)\S+/gi, '$1***'],
  [/((?:password|passwd|pwd|token|api[_-]?key|secret|access[_-]?token|client[_-]?secret)\s*[=:]\s*)\S+/gi, '$1***'],
  [/(\s-p)[^\s]{2,}/g, '$1***'], // mysql -pSECRET
  [/([a-z][a-z0-9+.\-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1***:***@'], // user:pass@host
  [/\bbot\d{6,}:[A-Za-z0-9_-]{15,}/g, 'bot***'], // telegram bot token in URL path
  [/\b(gh[pousr]_[A-Za-z0-9]{6,}|sk-[A-Za-z0-9-]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{12,})\b/g, '***']
]
function redact(s: string): string {
  let out = s
  for (const [re, rep] of REDACTORS) out = out.replace(re, rep)
  return out
}

function clip(s: string | undefined, n: number): string | undefined {
  if (s == null) return undefined
  const t = redact(String(s).replace(/\s+/g, ' ').trim())
  return t ? t.slice(0, n) : undefined
}

export class TraceRecorder {
  readonly trace: Trace
  // the span a tool is currently executing under — so a subagent spawned inside a tool
  // nests beneath that tool span without threading ids through ToolContext.
  currentToolSpanId: string | undefined
  private byId = new Map<string, TraceSpan>()
  private lastPersist = 0
  private persistFn: (t: Trace) => void
  private now: () => number
  // live stream callback — fires the FULL current trace on every span change so the renderer
  // can show the tree updating in real time (separate from the throttled disk flush below).
  private onUpdate?: (t: Trace) => void

  constructor(
    meta: TraceMeta,
    opts?: { persist?: (t: Trace) => void; now?: () => number; onUpdate?: (t: Trace) => void }
  ) {
    this.persistFn = opts?.persist ?? saveTrace
    this.now = opts?.now ?? (() => Date.now())
    this.onUpdate = opts?.onUpdate
    this.trace = {
      id: randomUUID(),
      sessionId: meta.sessionId,
      title: clip(meta.title, 80) || '(leer)',
      cwd: meta.cwd,
      model: meta.model,
      status: 'running',
      startedAt: this.now(),
      costUsd: 0,
      tokens: 0,
      spans: [],
      unattended: meta.unattended
    }
    this.flush(true) // appear in the list immediately as 'running'
    this.live()
  }

  begin(kind: TraceSpanKind, name: string, parentId?: string, detail?: string): string {
    const span: TraceSpan = {
      id: randomUUID(),
      parentId,
      kind,
      name: clip(name, 120) || kind,
      status: 'running',
      startedAt: this.now(),
      detail: clip(detail, DETAIL_CAP)
    }
    this.trace.spans.push(span)
    this.byId.set(span.id, span)
    this.flush(false)
    this.live()
    return span.id
  }

  end(
    id: string | undefined,
    patch: { status: TraceStatus; costUsd?: number; tokens?: number; detail?: string; error?: string }
  ): void {
    if (!id) return
    const span = this.byId.get(id)
    if (!span || span.endedAt != null) return
    span.endedAt = this.now()
    span.status = patch.status
    if (patch.costUsd != null && Number.isFinite(patch.costUsd)) {
      span.costUsd = patch.costUsd
      this.trace.costUsd += patch.costUsd
    }
    if (patch.tokens != null && Number.isFinite(patch.tokens)) {
      span.tokens = patch.tokens
      this.trace.tokens += patch.tokens
    }
    if (patch.detail) span.detail = clip(patch.detail, DETAIL_CAP)
    if (patch.error) span.error = clip(patch.error, ERROR_CAP)
    this.flush(false)
    this.live()
  }

  // Close the turn. Any span left open (e.g. on a crash mid-tool) is closed with the
  // turn's terminal status so the tree never shows a perpetual ⏳ after the fact.
  finish(status: TraceStatus): void {
    for (const span of this.trace.spans) {
      if (span.endedAt == null) {
        span.endedAt = this.now()
        span.status = status === 'ok' ? 'cancelled' : status // an un-ended span didn't truly succeed
      }
    }
    this.trace.status = status
    this.trace.endedAt = this.now()
    this.flush(true)
    this.live()
  }

  // Stream the full current trace to the renderer. Best-effort: a listener throwing must
  // never break the turn (mirrors flush's swallow-and-continue contract).
  private live(): void {
    try {
      this.onUpdate?.(this.trace)
    } catch {
      /* a live listener must never break a turn */
    }
  }

  private flush(force: boolean): void {
    const t = this.now()
    if (!force && t - this.lastPersist < PERSIST_THROTTLE_MS) return
    this.lastPersist = t
    try {
      this.persistFn(this.trace)
    } catch {
      /* persistence must never break a turn */
    }
  }
}
