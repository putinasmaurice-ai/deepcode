import { randomUUID } from 'crypto'
import { Tool, ok, fail, ToolContext } from './types'
import { listWorkflows, saveWorkflow, deleteWorkflow } from '../../workflows/store'
import { validateWorkflow, hasBlockingErrors, KNOWN_NODE_TYPES } from '@shared/workflows'
import type { WorkflowIssue } from '@shared/workflows'
import { coerceWorkflow } from '@shared/workflow-gen'
import { NODE_CATALOG } from '@shared/workflow-nodes'
import type { WorkflowDef, WorkflowNode, WorkflowEdge } from '@shared/types'

// Tools that let the chat agent author, validate, run and iteratively FIX visual workflows — its own
// little "n8n API": write a node graph, validate, run, read per-node results, update until it runs.
// Store/validate/coerce are imported directly; only EXECUTION is a capability (ctx.runWorkflow) wired
// in the main process (it needs the engine + masking). Every tool is non-throwing.

// Resolve an id-or-name to a saved def. These tools take an EXACT id or EXACT (case-insensitive)
// name — NOT a `/wf <name> <input>` string — so we must NOT reuse resolveWorkflow's
// longest-name-PREFIX matching: that would let update_workflow/delete_workflow on a multi-word
// name like "Deploy prod" silently resolve to an unrelated prefix neighbour ("Deploy") and
// clobber/delete it. No match → null, so a non-existent name fails cleanly instead of guessing.
function findWorkflow(idOrName: string): WorkflowDef | null {
  const all = listWorkflows()
  const t = String(idOrName || '').trim()
  if (!t) return null
  return all.find((w) => w.id === t) ?? all.find((w) => (w.name || '').toLowerCase() === t.toLowerCase()) ?? null
}

function triggerMode(def: WorkflowDef): string {
  const trig = def.nodes.find((n) => n.type === 'trigger')
  return String((trig?.config as Record<string, unknown>)?.mode ?? 'manual')
}

// One issue per line, with the node id when present, so the agent can pinpoint the fix.
function formatIssues(issues: WorkflowIssue[]): string {
  if (!issues.length) return '(keine)'
  return issues.map((i) => `[${i.severity}]${i.nodeId ? ` ${i.nodeId}:` : ''} ${i.message}`).join('\n')
}

// coerceWorkflow SILENTLY drops nodes with an unknown type and edges that point at a missing
// node. That makes the single most common authoring mistake — a typo'd / non-catalog node type —
// invisible: the node + its wiring just vanish and the tool reports success on a graph the agent
// never authored, defeating the validate→fix→rerun loop. So diff the raw input against the coerced
// result and surface every drop as a BLOCKING issue the agent can act on.
function dropIssues(rawNodes: unknown, rawEdges: unknown, def: WorkflowDef): WorkflowIssue[] {
  const out: WorkflowIssue[] = []
  const validTypes = [...KNOWN_NODE_TYPES].join(', ')
  const keptIds = new Set(def.nodes.map((n) => n.id))
  if (Array.isArray(rawNodes)) {
    for (const r of rawNodes) {
      if (!r || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      const type = String(o.type)
      if (!KNOWN_NODE_TYPES.has(type)) {
        const rid = typeof o.id === 'string' && o.id ? o.id : '(ohne id)'
        out.push({ nodeId: typeof o.id === 'string' ? o.id : undefined, severity: 'error', message: `Unbekannter Knotentyp „${type}" (Knoten ${rid}) — verworfen. Gültige Typen: ${validTypes}` })
      }
    }
  }
  if (Array.isArray(rawEdges)) {
    for (const r of rawEdges) {
      if (!r || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      const source = String(o.source)
      const target = String(o.target)
      if (!keptIds.has(source) || !keptIds.has(target)) {
        out.push({ severity: 'error', message: `Kante ${source}->${target} verweist auf einen unbekannten/verworfenen Knoten — verworfen.` })
      }
    }
  }
  return out
}

// Coerce agent-supplied nodes/edges into a normalized def (mint ids, autolayout, drop bad), then
// validate. The caller decides whether blocking errors abort the save.
function buildDef(
  id: string, name: string, description: string | undefined,
  nodes: unknown, edges: unknown, createdAt: number, now: number
): { def: WorkflowDef; issues: WorkflowIssue[] } {
  const raw = { name, description, nodes: nodes as WorkflowNode[], edges: edges as WorkflowEdge[] }
  const def = coerceWorkflow(raw, id, now)
  def.createdAt = createdAt
  return { def, issues: [...dropIssues(nodes, edges, def), ...validateWorkflow(def)] }
}

// Shared persist step for create/update: refuse to save on blocking errors (return them so the
// agent can fix + retry); otherwise save and report the id + any warnings. Returns a ToolResult.
function persist(def: WorkflowDef, issues: WorkflowIssue[], verb: string) {
  if (hasBlockingErrors(issues)) {
    return fail(`Workflow NICHT gespeichert — blockierende Fehler. Behebe sie und versuche es erneut:\n${formatIssues(issues)}`)
  }
  try {
    saveWorkflow(def)
  } catch (e) {
    return fail(`Speichern fehlgeschlagen: ${(e as Error).message}`)
  }
  const warnings = issues.filter((i) => i.severity === 'warn')
  return ok(
    `Workflow ${verb}: ${def.id} (${def.nodes.length} Knoten).` +
      (warnings.length ? `\nWarnungen:\n${formatIssues(warnings)}` : ''),
    { id: def.id }
  )
}

const CATALOG_HINT = `\n\nGültige Knotentypen und ihre config (ein Knoten je Eintrag):\n${NODE_CATALOG}`

const listTool: Tool = {
  name: 'list_workflows',
  description: 'Liste alle gespeicherten visuellen Workflows (id · Name · Knotenzahl · Trigger-Modus · Beschreibung).',
  permission: 'read',
  parameters: { type: 'object', properties: {} },
  summarize: () => 'List workflows',
  async execute() {
    const all = listWorkflows()
    if (!all.length) return ok('Keine Workflows gespeichert.')
    const lines = all.map(
      (w) => `${w.id} · ${w.name} · ${w.nodes.length} Knoten · ${triggerMode(w)} · ${w.description || '—'}`
    )
    return ok(lines.join('\n'), { count: all.length })
  }
}

const getTool: Tool = {
  name: 'get_workflow',
  description: 'Gib die vollständige Definition (Knoten/Kanten/config) eines Workflows als JSON zurück, damit du ihn bearbeiten kannst.',
  permission: 'read',
  parameters: { type: 'object', properties: { id_or_name: { type: 'string', description: 'Workflow-ID oder -Name.' } }, required: ['id_or_name'] },
  summarize: (a) => `Get workflow ${a?.id_or_name ?? ''}`,
  async execute(args) {
    if (!args?.id_or_name) return fail('id_or_name fehlt.')
    const def = findWorkflow(args.id_or_name)
    if (!def) return fail(`Kein Workflow gefunden für: ${args.id_or_name}`)
    return ok(JSON.stringify(def, null, 2), { id: def.id })
  }
}

const validateTool: Tool = {
  name: 'validate_workflow',
  description: 'Prüfe einen Workflow (per id_or_name ODER per workflow-JSON) und gib Fehler + Warnungen zeilenweise mit Knoten-ID zurück.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      id_or_name: { type: 'string', description: 'ID/Name eines gespeicherten Workflows.' },
      workflow: { type: 'object', description: 'Alternativ: vollständige Workflow-Definition als JSON.' }
    }
  },
  summarize: (a) => `Validate ${a?.id_or_name ?? 'workflow'}`,
  async execute(args) {
    let def: WorkflowDef | null = null
    if (args?.workflow && typeof args.workflow === 'object') {
      const w = args.workflow as Partial<WorkflowDef>
      def = buildDef('wf_validate', String(w.name || 'Entwurf'), w.description, w.nodes, w.edges, Date.now(), Date.now()).def
    } else if (args?.id_or_name) {
      def = findWorkflow(args.id_or_name)
      if (!def) return fail(`Kein Workflow gefunden für: ${args.id_or_name}`)
    } else {
      return fail('Bitte id_or_name oder workflow angeben.')
    }
    const issues = validateWorkflow(def)
    const blocking = hasBlockingErrors(issues)
    return ok(`${blocking ? 'NICHT lauffähig (blockierende Fehler):' : 'Lauffähig.'}\n${formatIssues(issues)}`, {
      blocking
    })
  }
}

const createTool: Tool = {
  name: 'create_workflow',
  description:
    'Erstelle einen neuen visuellen Workflow aus Knoten + Kanten. Bei blockierenden Fehlern wird NICHT gespeichert — die Probleme werden zurückgegeben, damit du sie behebst und erneut versuchst.' +
    CATALOG_HINT,
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name des Workflows.' },
      description: { type: 'string', description: 'Kurzbeschreibung (optional).' },
      nodes: { type: 'array', description: 'Knoten: [{id,type,label?,config}]. Genau ein trigger als erster Knoten.' },
      edges: { type: 'array', description: 'Kanten: [{source,target,sourceHandle?}].' }
    },
    required: ['name', 'nodes', 'edges']
  },
  summarize: (a) => `Create workflow ${a?.name ?? ''}`,
  async execute(args) {
    if (!args?.name || typeof args.name !== 'string') return fail('name fehlt.')
    if (!Array.isArray(args.nodes)) return fail('nodes muss ein Array sein.')
    if (!Array.isArray(args.edges)) return fail('edges muss ein Array sein.')
    const now = Date.now()
    const id = 'wf_' + randomUUID()
    const { def, issues } = buildDef(id, args.name, args.description, args.nodes, args.edges, now, now)
    return persist(def, issues, 'gespeichert')
  }
}

const updateTool: Tool = {
  name: 'update_workflow',
  description:
    'Bearbeite einen bestehenden Workflow. Angegebene Felder (name/description/nodes/edges) ersetzen die alten. Bei blockierenden Fehlern wird NICHT gespeichert.' +
    CATALOG_HINT,
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      id_or_name: { type: 'string', description: 'ID/Name des zu ändernden Workflows.' },
      name: { type: 'string' },
      description: { type: 'string' },
      nodes: { type: 'array', description: 'Falls gesetzt: ersetzt alle Knoten.' },
      edges: { type: 'array', description: 'Falls gesetzt: ersetzt alle Kanten.' }
    },
    required: ['id_or_name']
  },
  summarize: (a) => `Update workflow ${a?.id_or_name ?? ''}`,
  async execute(args) {
    if (!args?.id_or_name) return fail('id_or_name fehlt.')
    if (args.nodes !== undefined && !Array.isArray(args.nodes)) return fail('nodes muss ein Array sein.')
    if (args.edges !== undefined && !Array.isArray(args.edges)) return fail('edges muss ein Array sein.')
    const existing = findWorkflow(args.id_or_name)
    if (!existing) return fail(`Kein Workflow gefunden für: ${args.id_or_name}`)
    const name = typeof args.name === 'string' ? args.name : existing.name
    const description = typeof args.description === 'string' ? args.description : existing.description
    const nodes = args.nodes !== undefined ? args.nodes : existing.nodes
    const edges = args.edges !== undefined ? args.edges : existing.edges
    const { def, issues } = buildDef(existing.id, name, description, nodes, edges, existing.createdAt, Date.now())
    return persist(def, issues, 'aktualisiert')
  }
}

const runTool: Tool = {
  name: 'run_workflow',
  description:
    'Führe einen gespeicherten Workflow aus und lies die Ergebnisse je Knoten, um zu DEBUGGEN. Danach kannst du update_workflow nutzen, um Fehler zu beheben.',
  permission: 'bash',
  parameters: {
    type: 'object',
    properties: {
      id_or_name: { type: 'string', description: 'ID/Name des auszuführenden Workflows.' },
      input: { type: 'string', description: 'Optionaler Eingabetext ({{input}}).' }
    },
    required: ['id_or_name']
  },
  summarize: (a) => `Run workflow ${a?.id_or_name ?? ''}`,
  async execute(args, ctx: ToolContext) {
    if (!args?.id_or_name) return fail('id_or_name fehlt.')
    if (!ctx.runWorkflow) return fail('Workflow-Ausführung ist in diesem Kontext nicht verfügbar.')
    let res
    try {
      res = await ctx.runWorkflow(String(args.id_or_name), args.input != null ? String(args.input) : undefined)
    } catch (e) {
      return fail(`Ausführung fehlgeschlagen: ${(e as Error).message}`)
    }
    const head = `Status: ${res.status}${res.ok ? '' : ' (FEHLGESCHLAGEN)'}`
    const nodeLines = res.nodes.map((n) => {
      const label = n.label ? ` ${n.label}` : ''
      const detail = n.error ? `Fehler: ${n.error}` : n.output != null ? n.output : '—'
      return `• ${n.id}${label} [${n.status}]: ${detail}`
    })
    const tail = res.error ? `\nLauf-Fehler: ${res.error}` : res.output != null ? `\nErgebnis: ${res.output}` : ''
    return ok([head, ...nodeLines].join('\n') + tail, { ok: res.ok, status: res.status })
  }
}

const deleteTool: Tool = {
  name: 'delete_workflow',
  description: 'Lösche einen gespeicherten Workflow per id_or_name.',
  permission: 'write',
  parameters: { type: 'object', properties: { id_or_name: { type: 'string', description: 'ID/Name des zu löschenden Workflows.' } }, required: ['id_or_name'] },
  summarize: (a) => `Delete workflow ${a?.id_or_name ?? ''}`,
  async execute(args) {
    if (!args?.id_or_name) return fail('id_or_name fehlt.')
    const def = findWorkflow(args.id_or_name)
    if (!def) return fail(`Kein Workflow gefunden für: ${args.id_or_name}`)
    try {
      deleteWorkflow(def.id)
    } catch (e) {
      return fail(`Löschen fehlgeschlagen: ${(e as Error).message}`)
    }
    return ok(`Workflow gelöscht: ${def.id} (${def.name}).`, { id: def.id })
  }
}

export const workflowTools: Tool[] = [listTool, getTool, validateTool, createTool, updateTool, runTool, deleteTool]
