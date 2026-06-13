import { WorkflowDef, WorkflowNode } from './types'

// Pure, dependency-free workflow validation shared by the editor (block/highlight before
// a run) and the main process (guard a triggered run). Keeps "why won't it run?" answerable
// in plain language instead of a silent dead-end — part of the "clearer than n8n" promise.

export interface WorkflowIssue {
  nodeId?: string // present → highlight this node; absent → whole-workflow issue
  severity: 'error' | 'warn'
  message: string
}

// the one config field each node type cannot run without
const REQUIRED_FIELD: Partial<Record<WorkflowNode['type'], { key: string; label: string }>> = {
  agent: { key: 'prompt', label: 'Prompt' },
  tool: { key: 'tool', label: 'Tool-Name' },
  shell: { key: 'command', label: 'Befehl' },
  http: { key: 'url', label: 'URL' },
  condition: { key: 'expression', label: 'Ausdruck' },
  subworkflow: { key: 'workflowId', label: 'Workflow-ID' }
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null
}

export function validateWorkflow(def: WorkflowDef): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const nodes = Array.isArray(def.nodes) ? def.nodes : []
  const edges = Array.isArray(def.edges) ? def.edges : []
  if (!nodes.length) {
    issues.push({ severity: 'error', message: 'Workflow hat keine Knoten.' })
    return issues
  }
  const ids = new Set(nodes.map((n) => n.id))
  const start = nodes.find((n) => n.type === 'trigger') ?? nodes[0]
  if (!nodes.some((n) => n.type === 'trigger')) {
    issues.push({ severity: 'warn', message: 'Kein Trigger-Knoten — der erste Knoten wird als Start genutzt.' })
  }

  // dangling edges (always a real problem regardless of reachability)
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      issues.push({ severity: 'error', message: `Kante „${e.id}" zeigt auf einen gelöschten Knoten.` })
    }
  }

  // reachability FIRST — a node the start can't reach is never executed, so its missing
  // config must NOT block the whole run (a half-built orphan node is a normal editing state).
  // Such issues are downgraded to 'warn'; only reachable nodes produce blocking errors.
  const adj = new Map<string, string[]>()
  for (const e of edges) (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target)
  const seen = new Set<string>([start.id])
  const stack = [start.id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const t of adj.get(cur) ?? []) if (!seen.has(t)) (seen.add(t), stack.push(t))
  }

  for (const n of nodes) {
    const cfg = n.config || {}
    const reachable = n.id === start.id || seen.has(n.id)
    if (!reachable) {
      issues.push({ nodeId: n.id, severity: 'warn', message: 'Nicht mit dem Start verbunden — wird nie ausgeführt.' })
    }
    // a config problem on an UNREACHABLE node is only a warning (it can't break the run)
    const sev: 'error' | 'warn' = reachable ? 'error' : 'warn'
    const req = REQUIRED_FIELD[n.type]
    if (req && !nonEmpty(cfg[req.key])) {
      issues.push({ nodeId: n.id, severity: sev, message: `${req.label} fehlt.` })
    }
    // a cron trigger that never fires looks "armed" but silently does nothing — block it
    if (n.type === 'trigger' && cfg.mode === 'cron') {
      const cron = String(cfg.cron ?? '').trim()
      if (!cron) issues.push({ nodeId: n.id, severity: sev, message: 'Cron-Zeitplan fehlt.' })
      else if (cron.split(/\s+/).length !== 5)
        issues.push({ nodeId: n.id, severity: sev, message: 'Ungültiger Cron-Ausdruck (5 Felder: Min Std Tag Mon Wochentag).' })
    }
    // transform: the field the chosen mode actually needs
    if (n.type === 'transform') {
      const mode = String(cfg.mode || 'template')
      if (mode === 'extract') {
        if (!nonEmpty(cfg.pattern)) issues.push({ nodeId: n.id, severity: sev, message: 'Transform (extract): Regex fehlt.' })
        else
          try {
            new RegExp(String(cfg.pattern))
          } catch {
            issues.push({ nodeId: n.id, severity: sev, message: 'Transform: ungültiger regulärer Ausdruck.' })
          }
      } else if (mode === 'set' && !nonEmpty(cfg.value)) {
        issues.push({ nodeId: n.id, severity: sev, message: 'Transform (set): Wert fehlt.' })
      } else if (mode !== 'extract' && mode !== 'set' && !nonEmpty(cfg.template)) {
        issues.push({ nodeId: n.id, severity: 'warn', message: 'Transform (template): Template leer — Ergebnis wird leer sein.' })
      }
    }
    if (n.type === 'delay' && cfg.seconds !== undefined && !Number.isFinite(Number(cfg.seconds))) {
      issues.push({ nodeId: n.id, severity: sev, message: 'Warten: Sekunden muss eine Zahl sein.' })
    }
    // condition must wire BOTH branches, else a taken branch dead-ends the run silently (warn)
    if (n.type === 'condition') {
      const out = edges.filter((e) => e.source === n.id)
      if (!out.length) issues.push({ nodeId: n.id, severity: 'warn', message: 'Bedingung hat keine ausgehende Kante (true/false).' })
      else {
        if (!out.some((e) => e.sourceHandle === 'true')) issues.push({ nodeId: n.id, severity: 'warn', message: 'Bedingung: kein true-Zweig — endet hier, wenn sie zutrifft.' })
        if (!out.some((e) => e.sourceHandle === 'false')) issues.push({ nodeId: n.id, severity: 'warn', message: 'Bedingung: kein false-Zweig — endet hier, wenn sie nicht zutrifft.' })
      }
    }
  }
  return issues
}

export function hasBlockingErrors(issues: WorkflowIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}
