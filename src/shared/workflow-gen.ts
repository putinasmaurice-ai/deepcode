import { WorkflowDef, WorkflowNode, WorkflowEdge } from './types'
import { KNOWN_NODE_TYPES } from './workflows'

// Pure helpers for turning a natural-language description into a WorkflowDef via an LLM.
// Kept dependency-free (no electron/fs) so the risky parse/sanitize/layout logic is unit-tested
// against synthetic model output; the actual LLM call + validate-repair loop live in main.

export interface RawWorkflow {
  name?: unknown
  description?: unknown
  nodes?: unknown
  edges?: unknown
}

// Tolerant JSON extraction from a model response (may be fenced, or wrapped in prose).
export function parseWorkflowJson(text: string): RawWorkflow | null {
  if (typeof text !== 'string') return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const braced = text.match(/\{[\s\S]*\}/)
  const candidates = [fenced?.[1], braced?.[0], text].filter((c): c is string => !!c)
  for (const c of candidates) {
    try {
      const o = JSON.parse(c)
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as RawWorkflow
    } catch {
      /* try next candidate */
    }
  }
  return null
}

// Assign canvas positions: BFS depth from the entry node → column; order within a column → row.
// Unreached nodes are parked in a trailing column so they're still visible/editable.
// Nodes that ALREADY carry finite x/y (the user's hand-arranged layout, or model-supplied
// coordinates) are left untouched — only nodes MISSING a position are placed, so an update_workflow
// can't silently scramble a canvas the user arranged by hand.
export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
  if (!nodes.length) return
  const hasPos = (n: WorkflowNode): boolean => Number.isFinite(n.x) && Number.isFinite(n.y)
  if (nodes.every(hasPos)) return // every node already positioned — nothing to lay out
  const adj = new Map<string, string[]>()
  for (const e of edges) (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target)
  const start = nodes.find((n) => n.type === 'trigger') ?? nodes[0]
  const depth = new Map<string, number>([[start.id, 0]])
  const queue = [start.id]
  while (queue.length) {
    const cur = queue.shift()!
    const d = depth.get(cur)!
    for (const t of adj.get(cur) ?? []) if (!depth.has(t)) (depth.set(t, d + 1), queue.push(t))
  }
  let maxD = 0
  for (const d of depth.values()) maxD = Math.max(maxD, d)
  // seed each column's row counter from the positioned nodes so newly-placed nodes don't
  // overlap the ones the user already arranged in that column.
  const rowOf = new Map<number, number>()
  for (const n of nodes) {
    if (!hasPos(n)) continue
    const d = depth.get(n.id) ?? maxD + 1
    rowOf.set(d, (rowOf.get(d) ?? 0) + 1)
  }
  for (const n of nodes) {
    if (hasPos(n)) continue // keep the user's / model's existing coordinates
    const d = depth.get(n.id) ?? maxD + 1
    const row = rowOf.get(d) ?? 0
    rowOf.set(d, row + 1)
    n.x = 120 + d * 240
    n.y = 60 + row * 130
  }
}

// Build a sane WorkflowDef from raw model output: keep only KNOWN node types, force unique string
// ids, drop edges that point at missing nodes, guarantee a trigger entry, and auto-layout. The
// result is then run through validateWorkflow by the caller (and repaired once if needed).
export function coerceWorkflow(raw: RawWorkflow, id: string, now: number): WorkflowDef {
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const nodes: WorkflowNode[] = []
  const seen = new Set<string>()
  const MAX_GEN_NODES = 60 // at most 60 model-provided nodes (a synthesized trigger may add one) — a runaway response must not persist a giant graph
  for (const r of rawNodes) {
    if (nodes.length >= MAX_GEN_NODES) break
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const type = String(o.type)
    if (!KNOWN_NODE_TYPES.has(type)) continue
    let nid = typeof o.id === 'string' && o.id ? o.id : `n${nodes.length + 1}`
    while (seen.has(nid)) nid = `${nid}_${nodes.length + 1}`
    seen.add(nid)
    nodes.push({
      id: nid,
      type: type as WorkflowNode['type'],
      label: typeof o.label === 'string' ? o.label : undefined,
      config: o.config && typeof o.config === 'object' ? (o.config as Record<string, unknown>) : {},
      // preserve an existing hand-arranged / model-supplied position so autoLayout leaves it
      // alone; only nodes without finite coordinates get auto-placed.
      x: typeof o.x === 'number' && Number.isFinite(o.x) ? o.x : undefined,
      y: typeof o.y === 'number' && Number.isFinite(o.y) ? o.y : undefined
    })
  }
  // force every generated trigger to MANUAL: a cron trigger would be auto-armed by the scheduler
  // (~20s) before the user reviews the workflow the editor is about to open. The user can switch
  // it to cron in the editor once they've vetted the (model-authored) agent/shell nodes.
  for (const n of nodes) if (n.type === 'trigger') n.config = { mode: 'manual' }

  // guarantee an entry trigger: if the model produced none, prepend one wired to the first node
  if (nodes.length && !nodes.some((n) => n.type === 'trigger')) {
    const first = nodes[0]
    const trig: WorkflowNode = { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } }
    nodes.unshift(trig)
    ;(raw.edges as unknown[]) = [{ source: 'trigger', target: first.id }, ...(Array.isArray(raw.edges) ? raw.edges : [])]
  }

  const ids = new Set(nodes.map((n) => n.id))
  const edges: WorkflowEdge[] = []
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : []
  let ei = 0
  const edgeSeen = new Set<string>()
  for (const r of rawEdges) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const source = String(o.source)
    const target = String(o.target)
    if (!ids.has(source) || !ids.has(target)) continue
    const sourceHandle = typeof o.sourceHandle === 'string' && o.sourceHandle ? o.sourceHandle : undefined
    const key = `${source}->${target}:${sourceHandle ?? ''}`
    if (edgeSeen.has(key)) continue // drop duplicate edges
    edgeSeen.add(key)
    edges.push({ id: `e${++ei}_${source}_${target}`, source, target, sourceHandle })
  }

  autoLayout(nodes, edges)
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Generierter Workflow'
  const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 300) : undefined
  return { id, name, description, nodes, edges, createdAt: now, updatedAt: now }
}
