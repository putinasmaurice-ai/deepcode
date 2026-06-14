import { WorkflowDef } from '@shared/types'
import { EngineDeps } from '../agent/deps'
import { costOf } from '../agent/pricing'
import { recordUsage } from '../ledger'
import { validateWorkflow, hasBlockingErrors } from '@shared/workflows'
import { parseWorkflowJson, coerceWorkflow } from '@shared/workflow-gen'
import { NODE_CATALOG } from '@shared/workflow-nodes'

// The node catalogue + rules handed to the model. Deliberately steers toward SELF-CONTAINED
// flows (no loop/parallel/subworkflow, which need a separate saved workflow id) so the result
// runs immediately. Variable conventions match the executor's resolve(). The node-type/config
// section comes from NODE_CATALOG (single source of truth, shared with the chat agent's tools).
const SYSTEM = `You design an automation WORKFLOW as a directed graph for a desktop coding assistant.
Output STRICT JSON only — no prose, no code fences — of this exact shape:
{"name": string, "description": string,
 "nodes": [{"id": string, "type": string, "label": string, "config": object}],
 "edges": [{"source": nodeId, "target": nodeId, "sourceHandle"?: string}]}

${NODE_CATALOG}

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
