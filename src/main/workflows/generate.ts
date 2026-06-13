import { WorkflowDef } from '@shared/types'
import { EngineDeps } from '../agent/deps'
import { costOf } from '../agent/pricing'
import { recordUsage } from '../ledger'
import { validateWorkflow, hasBlockingErrors } from '@shared/workflows'
import { parseWorkflowJson, coerceWorkflow } from '@shared/workflow-gen'

// The node catalogue + rules handed to the model. Deliberately steers toward SELF-CONTAINED
// flows (no loop/parallel/subworkflow, which need a separate saved workflow id) so the result
// runs immediately. Variable conventions match the executor's resolve().
const SYSTEM = `You design an automation WORKFLOW as a directed graph for a desktop coding assistant.
Output STRICT JSON only — no prose, no code fences — of this exact shape:
{"name": string, "description": string,
 "nodes": [{"id": string, "type": string, "label": string, "config": object}],
 "edges": [{"source": nodeId, "target": nodeId, "sourceHandle"?: string}]}

Node types and their config:
- trigger  {"mode":"manual"} or {"mode":"cron","cron":"min hour dom mon dow"} — REQUIRED as the first node, exactly one.
- agent    {"prompt": string} — a full AI step WITH tools (read/write files, run commands). Use for anything needing reasoning or file/codebase work.
- shell    {"command": string, "continueOnError"?: true} — run one shell command. Set continueOnError when the command commonly exits non-zero (npm test, npm outdated, linters).
- http     {"url": string, "continueOnError"?: true} — fetch a URL (http/https only).
- transform{"mode":"template","template": string} | {"mode":"set","value": string} | {"mode":"extract","pattern": regex} — string templating / set a var / regex-extract.
- condition{"expression": string} — branch; its outgoing edges MUST use "sourceHandle":"true" and "sourceHandle":"false".
- switch   {"cases":"a,b,c"} — multi-branch; outgoing edges use "sourceHandle" per case plus one "sourceHandle":"default".
- delay    {"seconds": number}
- notify   {"title"?: string, "message"?: string} — desktop notification.
- output   {"template"?: string} — emit the final result (defaults to {{last}}).

Variables (in any string config): {{input}} = the text the user passes when running it; {{last}} = previous node's output; {{name}} = a variable a transform set via its config "outputVar". Put the user-facing result in the LAST node.

Rules: first node is a trigger. Prefer a simple linear chain; only branch with condition/switch when the request needs it. Do NOT use loop/parallel/merge/subworkflow. Keep it self-contained and runnable. Never put {{secret.*}} in an agent prompt. Keep it to 3-6 nodes unless more are truly needed.`

async function callModel(deps: EngineDeps, messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string> {
  const res = await deps.client.streamChat(messages, [], {}, new AbortController().signal)
  // bill against the model the call actually used (provider.model) — so a local default is free
  // (costOf zeroes local:) and a reasoner default is priced correctly, like every other call site.
  if (res.usage) recordUsage(costOf(deps.settings.provider, res.usage, deps.settings.provider.model))
  return res.content
}

// Generate a validated WorkflowDef from a natural-language description. One repair round: if the
// first attempt fails validation (or isn't parseable), the model is shown the blocking issues and
// asked to fix them. Throws a clear error rather than returning an invalid/garbage workflow.
export async function generateWorkflow(
  deps: EngineDeps,
  description: string,
  id: string,
  now: number
): Promise<WorkflowDef> {
  const desc = String(description || '').trim()
  if (!desc) throw new Error('Bitte beschreibe, was der Workflow tun soll.')

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Erzeuge einen Workflow für: ${desc}` }
  ]

  let content = await callModel(deps, messages)
  let def = buildFrom(content, id, now)
  let issues = def ? validateWorkflow(def) : []

  if (!def || hasBlockingErrors(issues)) {
    const reason = !def
      ? 'die Antwort war kein gültiges Workflow-JSON'
      : issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('; ')
    messages.push({ role: 'assistant', content })
    messages.push({
      role: 'user',
      content: `Der Workflow hatte diese blockierenden Probleme: ${reason}. Gib einen KORRIGIERTEN Workflow als striktes JSON (gleiches Schema) zurück, der sie behebt.`
    })
    content = await callModel(deps, messages)
    def = buildFrom(content, id, now)
    issues = def ? validateWorkflow(def) : []
  }

  if (!def) throw new Error('Konnte keinen gültigen Workflow erzeugen — formuliere die Beschreibung bitte anders oder konkreter.')
  if (hasBlockingErrors(issues)) {
    const errs = issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')
    throw new Error(`Der erzeugte Workflow ist noch unvollständig (${errs}). Bitte konkreter beschreiben.`)
  }
  return def
}

function buildFrom(content: string, id: string, now: number): WorkflowDef | null {
  const raw = parseWorkflowJson(content)
  if (!raw) return null
  const def = coerceWorkflow(raw, id, now)
  return def.nodes.length ? def : null
}
