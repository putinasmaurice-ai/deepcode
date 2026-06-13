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
  switch: { key: 'cases', label: 'Fälle (kommagetrennt)' },
  subworkflow: { key: 'workflowId', label: 'Workflow-ID' },
  loop: { key: 'bodyWorkflowId', label: 'Body-Workflow' },
  store: { key: 'storeKey', label: 'Schlüssel' },
  code: { key: 'code', label: 'JS-Code' },
  channel: { key: 'channel', label: 'Kanal (telegram/slack/discord/webhook)' },
  email: { key: 'to', label: 'Empfänger (To)' }
}

// single source of truth for node types — imported by the importWorkflow IPC guard too,
// so the renderer, validator and importer can't drift apart.
export const KNOWN_NODE_TYPES = new Set<string>([
  'trigger', 'agent', 'tool', 'shell', 'http', 'condition', 'switch', 'transform', 'subworkflow', 'loop', 'parallel', 'merge', 'delay', 'notify', 'store', 'code', 'parse', 'channel', 'email', 'output'
])

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null
}

// Validate a 5-field cron expression against the matcher's actual domain, so an expression
// that PASSES validation actually FIRES. Counting fields alone let through out-of-range
// (minute 99), bad day (32) and step-0 (*/0 → never matches) — "armed but silent". Bounds:
// minute hour day-of-month month day-of-week (dow allows 7 = Sunday).
const CRON_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]
]
function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    if (part === '') return false
    const [range, stepStr] = part.split('/')
    if (stepStr !== undefined) {
      const step = Number(stepStr)
      if (!Number.isInteger(step) || step < 1) return false
    }
    if (range === '*') continue
    const bounds = range.split('-')
    if (bounds.length > 2) return false
    const lo = Number(bounds[0])
    const hi = bounds[1] !== undefined ? Number(bounds[1]) : lo
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false
    if (lo < min || hi > max || lo > hi) return false
  }
  return true
}
export function isValidCron(expr: string): boolean {
  const fields = String(expr).trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((f, i) => isValidCronField(f, CRON_BOUNDS[i][0], CRON_BOUNDS[i][1]))
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
    if (!KNOWN_NODE_TYPES.has(n.type)) {
      issues.push({ nodeId: n.id, severity: sev, message: `Unbekannter Knotentyp: ${n.type}` })
    }
    const req = REQUIRED_FIELD[n.type]
    if (req && !nonEmpty(cfg[req.key])) {
      issues.push({ nodeId: n.id, severity: sev, message: `${req.label} fehlt.` })
    }
    // secrets are deterministic-arg only (tool/shell/http) — a {{secret.*}} in an agent
    // prompt would be sent to the model + streamed/persisted in plaintext. Block it.
    if (n.type === 'agent' && /\{\{\s*secret\./.test(String(cfg.prompt ?? ''))) {
      issues.push({ nodeId: n.id, severity: 'error', message: '{{secret.*}} ist im Agent-Prompt nicht erlaubt — nutze es nur in Tool/Shell/HTTP-Argumenten.' })
    }
    // a cron trigger that never fires looks "armed" but silently does nothing — block it
    if (n.type === 'trigger' && cfg.mode === 'cron') {
      const cron = String(cfg.cron ?? '').trim()
      if (!cron) issues.push({ nodeId: n.id, severity: sev, message: 'Cron-Zeitplan fehlt.' })
      else if (!isValidCron(cron))
        issues.push({ nodeId: n.id, severity: sev, message: 'Ungültiger Cron-Ausdruck — 5 Felder (Min Std Tag Mon Wochentag) mit gültigen Bereichen/Schritten.' })
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
    // switch: warn on missing case/default edges + a reserved 'default' case name
    if (n.type === 'switch') {
      const cases = [...new Set(String(cfg.cases ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
      if (cases.includes('default')) {
        issues.push({ nodeId: n.id, severity: sev, message: 'Switch: „default" ist reserviert (Fallback-Zweig) — als Fallnamen umbenennen.' })
      }
      const out = edges.filter((e) => e.source === n.id)
      if (!out.length) issues.push({ nodeId: n.id, severity: 'warn', message: 'Switch hat keine ausgehende Kante.' })
      else {
        for (const c of cases.filter((c) => c !== 'default')) {
          if (!out.some((e) => e.sourceHandle === c)) issues.push({ nodeId: n.id, severity: 'warn', message: `Switch: Fall „${c}" ohne Kante — endet hier bei diesem Wert.` })
        }
        if (!out.some((e) => e.sourceHandle === 'default')) issues.push({ nodeId: n.id, severity: 'warn', message: 'Switch: kein default-Zweig — endet hier, wenn kein Fall passt.' })
      }
    }
    if (n.type === 'loop') {
      // compare EFFECTIVE (defaulted) names so item=''(→item) + index='item' is also caught
      const iv = (String(cfg.itemVar ?? '').trim() || 'item')
      const ix = (String(cfg.indexVar ?? '').trim() || 'index')
      if (iv === ix) {
        issues.push({ nodeId: n.id, severity: sev, message: 'Schleife: Item- und Index-Variable müssen unterschiedlich sein.' })
      }
      if (cfg.bodyWorkflowId && cfg.bodyWorkflowId === def.id) {
        issues.push({ nodeId: n.id, severity: 'warn', message: 'Schleife: Body-Workflow ist dieser Workflow selbst (Zyklusgefahr).' })
      }
    }
    if (n.type === 'parallel') {
      const brs = Array.isArray(cfg.branches) ? (cfg.branches as Array<Record<string, unknown>>) : null
      if (!brs || !brs.some((b) => b && nonEmpty(b.workflowId))) {
        issues.push({ nodeId: n.id, severity: sev, message: 'Parallel: keine gültigen Branches (Array mit workflowId).' })
      } else {
        const rvs = brs.map((b) => String(b?.resultVar ?? '')).filter(Boolean)
        if (new Set(rvs).size !== rvs.length) {
          issues.push({ nodeId: n.id, severity: sev, message: 'Parallel: doppelte resultVar — Ergebnisse würden sich überschreiben.' })
        }
      }
    }
    if (n.type === 'merge' && !nonEmpty(cfg.inputs)) {
      issues.push({ nodeId: n.id, severity: 'warn', message: 'Zusammenführen: keine Eingabe-Variablen angegeben.' })
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
