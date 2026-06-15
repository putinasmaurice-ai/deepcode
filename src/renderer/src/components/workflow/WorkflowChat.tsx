import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, ChatMessage, WorkflowDef } from '../../../../shared/types'
import { MIN_SECRET_LEN } from '../../../../shared/types'
import { MessageView } from '../MessageView'
import type { ToolState } from '../../App'

const api = window.deepcode

// workflow-mutating tools — when one of these returns we reload the canvas mid-turn so the
// graph visibly grows node-by-node ("describe → watch it build live") instead of snapping in
// only at turn_done. syncFromDisk (the parent) no-ops when disk == canvas, so this is safe.
const MUTATING_TOOLS = new Set(['create_workflow', 'update_workflow', 'delete_workflow'])

// the dock agent is a WORKFLOW builder — restrict it to workflow + read + secret tools so its
// frictionless 'full' mode can NEVER reach write_file/run_command/web_request/git/jobs/MCP/etc.
// buildTools' allow-filter enforces this server-side (a renderer can't widen it).
const DOCK_TOOLS = [
  'list_workflows', 'get_workflow', 'create_workflow', 'update_workflow', 'delete_workflow',
  'run_workflow', 'validate_workflow', 'list_secrets', 'request_secret',
  'read_file', 'list_dir', 'glob', 'grep', 'semantic_search', 'web_fetch'
]

// In-tab chat dock for the workflow editor: the user describes/iterates THIS workflow in
// plain words and watches the graph rebuild live. Self-contained — owns ONE dedicated
// session (lazily created on first send) and its own messages[]/toolState, subscribing to
// onAgentEvent FILTERED by its own sessionId. Mirrors App.tsx's handleEvent assembly,
// including real approval + secret prompts so a gated tool (MCP / dangerous shell / secret
// request) surfaces a UI here instead of deadlocking the turn.
export function WorkflowChat({
  workflow,
  onWorkflowChanged,
  onClose,
  hidden
}: {
  workflow: WorkflowDef
  onWorkflowChanged?: () => void
  onClose?: () => void
  // kept MOUNTED but hidden (display:none) when collapsed, so an in-flight turn's subscription,
  // session id and transcript survive a collapse instead of being torn down + restarted.
  hidden?: boolean
}): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [toolState, setToolState] = useState<Record<string, ToolState>>({})
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [text, setText] = useState('')
  // an open secure secret prompt (the agent asked for SMTP_PASS/TELEGRAM_CHAT_ID/…). null =
  // none. Without this the turn would block forever on requestSecretInput.
  const [pendingSecret, setPendingSecret] = useState<{ callId: string; name: string; reason?: string } | null>(null)
  // the dock's own session id — lazily minted on first send, then reused. Ref so the event
  // handler (subscribed once) reads the live value without re-subscribing.
  const sessionIdRef = useRef<string | null>(null)
  const msgsRef = useRef<HTMLDivElement>(null)
  const changedRef = useRef(onWorkflowChanged)
  changedRef.current = onWorkflowChanged

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      const el = msgsRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  // single subscription for this dock's lifetime — every branch is scoped to our own session.
  useEffect(() => {
    const off = api.onAgentEvent((e: AgentEvent) => {
      // 'error' carries NO sessionId (shared/types) so it would always fail the guard below.
      // Special-case it first: only surface once the dock has actually sent (sessionIdRef set),
      // so a background/main-chat failure can't leak an error bubble into an idle dock.
      if (e.type === 'error') {
        if (sessionIdRef.current) {
          setMessages((m) => [
            ...m,
            { id: 'err-' + Date.now(), role: 'assistant', content: '⚠ ' + e.message, createdAt: Date.now(), error: true }
          ])
          setBusy(false)
          setStatus('')
          scrollDown()
        }
        return
      }
      const sid = 'sessionId' in e ? (e as { sessionId?: string }).sessionId : undefined
      if (!sessionIdRef.current || sid !== sessionIdRef.current) return
      switch (e.type) {
        case 'message_start':
          setMessages((m) => [...m, e.message])
          scrollDown()
          break
        case 'content_delta':
          setMessages((m) =>
            m.map((x) => (x.id === e.messageId ? { ...x, content: x.content + e.delta } : x))
          )
          scrollDown()
          break
        case 'reasoning_delta':
          setMessages((m) =>
            m.map((x) =>
              x.id === e.messageId ? { ...x, reasoning: (x.reasoning ?? '') + e.delta } : x
            )
          )
          break
        case 'message_done':
          setMessages((m) => m.map((x) => (x.id === e.message.id ? e.message : x)))
          scrollDown()
          break
        case 'tool_pending':
          setToolState((t) => ({
            ...t,
            [e.callId]: { ...t[e.callId], pending: true, name: e.name, args: e.args }
          }))
          scrollDown()
          break
        case 'tool_result':
          setToolState((t) => ({
            ...t,
            [e.callId]: { ...t[e.callId], pending: false, result: e.result, name: e.name }
          }))
          // live build: a workflow-mutating tool just landed — reload the canvas now so the
          // graph grows visibly during the turn instead of only at turn_done.
          if (MUTATING_TOOLS.has(e.name)) changedRef.current?.()
          scrollDown()
          break
        case 'secret_request':
          // open the secure prompt; if one is already open, settle it (submit null) first so
          // its waiting main-side promise can't strand.
          setPendingSecret((prev) => {
            if (prev && prev.callId !== e.callId) api.submitSecret(prev.callId, null).catch(() => {})
            return { callId: e.callId, name: e.name, reason: e.reason }
          })
          scrollDown()
          break
        case 'status':
          setStatus(e.message)
          break
        case 'turn_done':
          setBusy(false)
          setStatus('')
          // a turn ended — tear down any open secret prompt; its backing promise is dead.
          setPendingSecret((prev) => {
            if (prev) api.submitSecret(prev.callId, null).catch(() => {})
            return null
          })
          changedRef.current?.()
          break
      }
    })
    return off
  }, [scrollDown])

  const send = useCallback(async () => {
    const userText = text.trim()
    if (!userText || busy) return
    setText('')
    setBusy(true)
    try {
      if (!sessionIdRef.current) {
        const s = await api.createSession()
        sessionIdRef.current = s.id
        // give the dock's session a clean, recognizable title so it doesn't masquerade as a user
        // chat in the sidebar (and the augmented context text can't leak in as the auto-title).
        api.renameSession(s.id, '🔧 Workflow-Assistent: ' + workflow.name).catch(() => {})
      }
      const sid = sessionIdRef.current
      // DISPLAYED message is the clean text; the SENT text is augmented so update/run target
      // the currently open workflow by id.
      const shown: ChatMessage = {
        id: 'local-' + Date.now(),
        role: 'user',
        content: userText,
        createdAt: Date.now()
      }
      setMessages((m) => [...m, shown])
      scrollDown()
      const sentText =
        userText +
        '\n\n(Kontext: aktuell geöffneter Workflow — id: ' +
        workflow.id +
        ', Name: "' +
        workflow.name +
        '". Verwende diese id für update_workflow/run_workflow.)'
      // mode 'full' — the user explicitly asked the assistant to build, so workflow tools run
      // without approval friction. MCP / dangerous-shell / secret-gated calls still surface a
      // real prompt (approve handler + SecretPrompt below) so the turn can't deadlock.
      await api.sendMessage(sid, sentText, undefined, 'full', DOCK_TOOLS)
    } catch (err) {
      setBusy(false)
      setStatus('')
      setMessages((m) => [
        ...m,
        {
          id: 'err-' + Date.now(),
          role: 'assistant',
          content: '⚠ ' + (err as Error).message,
          createdAt: Date.now(),
          error: true
        }
      ])
    }
  }, [text, busy, workflow.id, workflow.name, scrollDown])

  const onKey = useCallback(
    (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        void send()
      }
    },
    [send]
  )

  // real approval handler — mirrors App.tsx's approve(): forward the decision to main (which
  // unblocks the awaiting requestApproval) and optimistically clear the pending flag so the
  // ToolBlock's Allow/Deny buttons resolve. Without this, MCP / dangerous-shell tools hang.
  const approve = useCallback((callId: string, approved: boolean, remember?: boolean): void => {
    api.approveTool(callId, approved, remember).catch(() => {})
    setToolState((t) => ({ ...t, [callId]: { ...t[callId], pending: false } }))
  }, [])

  // resolve the open secret prompt. The value (or null on cancel) goes ONLY to api.submitSecret
  // → main → setSecret; never stored in messages or logged. On a server-side reject (too short /
  // no OS encryption) keep the prompt open so the user can correct it.
  const resolveSecret = useCallback((callId: string, value: string | null): void => {
    if (value === null) {
      api.submitSecret(callId, null).catch(() => {})
      setPendingSecret((p) => (p && p.callId === callId ? null : p))
      return
    }
    api
      .submitSecret(callId, value)
      .then((r) => {
        if (r?.set) setPendingSecret((p) => (p && p.callId === callId ? null : p))
        // else: leave the prompt open (the user can fix the value or cancel)
      })
      .catch(() => {})
  }, [])

  // stop a running build — cancels the dock's own turn so a wrong/long request is recoverable.
  const stop = useCallback(() => {
    const sid = sessionIdRef.current
    if (sid) api.cancelTurn(sid).catch(() => {})
    setStatus('Stoppe…')
  }, [])

  return (
    <div className={'wf-chat-dock' + (hidden ? ' hidden' : '')}>
      <div className="wf-chat-head">
        <span className="wf-chat-title">💬 Workflow-Assistent</span>
        <span className="wf-chat-sub">{workflow.name}</span>
        {onClose && (
          <button className="wf-chat-close" onClick={onClose} title="Assistent schließen">
            ✕
          </button>
        )}
      </div>
      <div className="wf-chat-msgs" ref={msgsRef}>
        {messages.length === 0 ? (
          <div className="wf-chat-empty">
            <div className="wf-chat-empty-orb" aria-hidden />
            <strong>Beschreibe deinen Workflow</strong>
            Der Assistent baut & ändert ihn live auf der Leinwand. Z. B. „Füge nach dem Trigger
            einen HTTP-POST an Telegram an.“
          </div>
        ) : (
          messages.map((m) => (
            <MessageView key={m.id} message={m} toolState={toolState} onApprove={approve} />
          ))
        )}
        {busy && (
          <div className="wf-chat-busy">
            <span>● {status || 'Assistent baut deinen Workflow…'}</span>
            <button className="btn ghost sm" onClick={stop} title="Build abbrechen">
              ⏹ Stop
            </button>
          </div>
        )}
      </div>
      {pendingSecret && (
        <SecretPrompt
          key={pendingSecret.callId}
          name={pendingSecret.name}
          reason={pendingSecret.reason}
          onSave={(value) => resolveSecret(pendingSecret.callId, value)}
          onCancel={() => resolveSecret(pendingSecret.callId, null)}
        />
      )}
      <div className="wf-chat-input">
        <textarea
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={onKey}
          placeholder="Workflow beschreiben oder ändern… (Enter = senden, Shift+Enter = neue Zeile)"
          rows={2}
        />
        <button
          className="btn sm wf-chat-send"
          onClick={() => void send()}
          disabled={busy || !text.trim()}
        >
          Senden
        </button>
      </div>
    </div>
  )
}

// secure secret entry inside the dock — mirrors App.tsx's SecretPrompt. The submitted value
// travels ONLY via onSave → api.submitSecret → main; it is never placed in messages or logged.
function SecretPrompt({
  name,
  reason,
  onSave,
  onCancel
}: {
  name: string
  reason?: string
  onSave: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const tooShort = value.length < MIN_SECRET_LEN
  const save = (): void => {
    if (tooShort) return
    onSave(value)
  }
  return (
    <div className="wf-chat-secret" role="dialog" aria-label={`Secret ${name} eingeben`}>
      <div className="wf-chat-secret-title">
        🔐 <b>{name}</b> sicher eingeben
      </div>
      {reason && <div className="wf-chat-secret-reason">{reason}</div>}
      <div className="wf-chat-secret-row">
        <input
          ref={inputRef}
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder={`Wert für ${name}…`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
        />
        <button className="btn sm" disabled={tooShort} onClick={save}>
          Speichern
        </button>
        <button className="btn ghost sm" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
      <div className="wf-chat-secret-hint">
        {tooShort && value.length > 0
          ? `Mindestens ${MIN_SECRET_LEN} Zeichen.`
          : `Mind. ${MIN_SECRET_LEN} Zeichen. Wird verschlüsselt gespeichert und nie an das Modell oder den Chatverlauf gesendet.`}
      </div>
    </div>
  )
}
