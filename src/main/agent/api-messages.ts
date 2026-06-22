import { randomUUID } from 'crypto'
import { ChatMessage, ToolResult } from '@shared/types'
import { ApiMessage } from './deepseek'

// Conversion of the stored transcript into API wire format.
//
// Guarantees that every assistant tool_call is followed by a matching tool
// message — otherwise the API rejects the request (possible after a turn was
// cancelled mid-tool-execution).
//
// Token diet: only the last RECENT_TOOL_TURNS tool-calling rounds keep their
// full outputs — older tool results collapse to a stub. The agent re-reads
// files on demand anyway; resending stale 100k outputs every request is the
// single biggest input-token waste on long sessions.
const RECENT_TOOL_TURNS = 3
const RECENT_TOOL_CAP = 30_000

// opts.replayReasoning: re-send the assistant's reasoning_content on turns that carried tool_calls.
// First-party DeepSeek V3.2/V4 thinking-mode REQUIRES this (400 without it); everywhere else it's
// off (hosted deepseek via gateways ignores it, and opaque-reasoning models — grok/gemini — would
// need their verbatim reasoning_details, which we don't store). Position rule: only on tool-call
// turns; a plain final-answer turn keeps reasoning stripped (matches the legacy-R1 "no reasoning in
// input" contract too).
export function toApiMessages(system: string, messages: ChatMessage[], opts?: { replayReasoning?: boolean }): ApiMessage[] {
  const out: ApiMessage[] = [{ role: 'system', content: system }]
  const respondedIds = new Set(
    messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string)
  )

  const recentCallIds = new Set<string>()
  let turns = 0
  for (let i = messages.length - 1; i >= 0 && turns < RECENT_TOOL_TURNS; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) recentCallIds.add(tc.id)
      turns++
    }
  }
  const toolContent = (m: ChatMessage): string => {
    if (recentCallIds.has(m.toolCallId ?? '')) return m.content.slice(0, RECENT_TOOL_CAP)
    const head = m.content.replace(/\s+/g, ' ').slice(0, 220)
    return `${head}… [ältere Ausgabe gekürzt — Datei/Befehl bei Bedarf erneut abrufen]`
  }

  for (const m of messages) {
    if (m.role === 'user') {
      if (m.images?.length) {
        // The text model (DeepSeek) can't see images — the vision model (Gemini/local)
        // already DESCRIBED them before the turn. Inline that description as text instead
        // of sending raw image parts (which DeepSeek would reject). Never emit image_url
        // parts here: this builder only ever targets the text model now.
        const note = m.imageDescription
          ? `\n\n[👁 Bildanalyse]\n${m.imageDescription}`
          : `\n\n[👁 ${m.images.length} Bild(er) angehängt — keine Analyse verfügbar]`
        out.push({ role: 'user', content: (m.content || '') + note })
      } else {
        out.push({ role: 'user', content: m.content })
      }
    } else if (m.role === 'assistant') {
      const msg: ApiMessage = { role: 'assistant', content: m.content || '' }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }))
        if (!m.content) msg.content = null
        // first-party DeepSeek thinking-mode: the reasoning that preceded this tool_calls block must
        // be replayed verbatim, or the API 400s ("reasoning_content … must be passed back").
        if (opts?.replayReasoning && m.reasoning) msg.reasoning_content = m.reasoning
      }
      out.push(msg)
      // backfill any tool_calls that never got a response
      for (const tc of m.toolCalls ?? []) {
        if (!respondedIds.has(tc.id)) {
          out.push({
            role: 'tool',
            content: '(no result — the previous turn was interrupted)',
            tool_call_id: tc.id,
            name: tc.name
          })
          respondedIds.add(tc.id)
        }
      }
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: toolContent(m),
        tool_call_id: m.toolCallId,
        name: m.toolName
      })
    }
  }
  return out
}

// Error fed back to the model when a tool call's arguments can't be parsed. Crucially distinguishes
// the two causes so the model self-corrects instead of looping: (a) truncated = the arguments were
// CUT OFF at the output-token limit (finish_reason=length) — the file/output was too big for one
// call, so it must write in smaller chunks; (b) otherwise the JSON is genuinely malformed. We never
// echo the (often ~8 KB) truncated payload back — that only bloats the next prompt and nudges the
// model to re-emit the same oversized call.
export function toolArgErrorMessage(name: string, argChars: number, truncated: boolean): string {
  if (truncated) {
    return (
      `Tool-Argumente von \`${name}\` wurden am Token-Limit ABGESCHNITTEN ` +
      `(finish_reason=length, ${argChars} Zeichen, unvollständiges JSON) — NICHT fehlerhaft formatiert. ` +
      `Die Ausgabe war zu groß für ein einziges Token-Fenster. Schreibe die Datei in MEHREREN, KLEINEN ` +
      `Schritten: zuerst write_file mit einem Skelett/ersten Teil, dann jede weitere Sektion per ` +
      `write_file(mode:"append") oder edit_file/apply_patch anhängen. Halte jeden Tool-Aufruf unter ~6 KB. ` +
      `Sende NICHT denselben großen Inhalt erneut.`
    )
  }
  return (
    `Ungültige (nicht parsebare) JSON-Argumente für \`${name}\`. Sende GÜLTIGES, vollständiges JSON. ` +
    `Bei großem Inhalt auf mehrere kleinere Tool-Aufrufe aufteilen (z. B. write_file(mode:"append")).`
  )
}

// Stored form of a tool result (transcript side, capped).
export function toolResultMessage(callId: string, name: string, res: ToolResult): ChatMessage {
  return {
    id: randomUUID(),
    role: 'tool',
    content: res.content.slice(0, 100_000),
    toolCallId: callId,
    toolName: name,
    createdAt: Date.now(),
    error: !res.ok,
    meta: res.meta
  }
}
