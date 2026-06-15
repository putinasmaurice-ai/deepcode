import { randomUUID } from 'crypto'
import { MissionTask } from '@shared/types'

// Turn a high-level goal into a branching DAG plan of 3-8 tasks (title + instruction + deps) via an
// LLM, and — when a task exhausts its retries — REPLAN remediation tasks that run before the failed
// goal is re-attempted. Pure logic over a `complete(system, user)` callback — no electron/engine
// imports — so the risky parse/coerce path can be unit-tested against synthetic model output.
// Tolerant JSON extraction mirrors @shared/workflow-gen (fenced / braced / raw candidates).

const MAX_TASKS = 8
const MAX_REMEDIATION = 4 // a single replan can propose at most this many fix steps

const SYSTEM = `You are a planning assistant for an autonomous coding agent.
Decompose the user's high-level GOAL into a list of 3 to 8 concrete tasks forming a dependency DAG.
Each task is one self-contained step the coding agent will execute as a single turn.
Output STRICT JSON only — no prose, no code fences — of this exact shape:
{"tasks": [{"id": string, "title": string, "instruction": string, "deps": string[]}]}
Rules: "id" is a short stable string YOU assign (e.g. "t1"). "deps" lists the ids of tasks that
MUST finish before this one (use [] for a starting task). The graph MUST be acyclic and every dep
MUST reference an id that exists. Order matters only through deps — independent tasks may have none.
"title" is a short label (a few words). "instruction" is a precise, standalone description of what
to do in that step. Do NOT include verification/testing as separate tasks — a machine verify gate
runs automatically after every task. Aim for 3-6 tasks unless the goal truly needs more.`

const REPLAN_SYSTEM = `You are a remediation planner for an autonomous coding agent.
A task FAILED its automatic machine-verify gate after retries. Propose a SHORT ordered list of 1 to
${MAX_REMEDIATION} concrete REMEDIATION tasks that, once done, will let the failed task pass. These
run BEFORE the failed task is re-attempted. If the goal is genuinely UNSATISFIABLE or you have no
useful remediation, output an EMPTY tasks array — do NOT pad with no-op steps.
Output STRICT JSON only — no prose, no code fences — of this exact shape:
{"tasks": [{"id": string, "title": string, "instruction": string, "deps": string[]}]}
Rules: "id" is a short stable string YOU assign for these remediation tasks only (e.g. "fix1").
"deps" may only reference OTHER remediation ids you list here (to chain fixes); use [] otherwise.
The remediation MUST be acyclic. "instruction" must be a precise, standalone fix step.`

interface RawTask {
  id?: unknown
  title?: unknown
  instruction?: unknown
  deps?: unknown
}

// Tolerant JSON extraction from a model response (may be fenced, or wrapped in prose).
export function parsePlanJson(text: string): RawTask[] | null {
  if (typeof text !== 'string') return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const braced = text.match(/\{[\s\S]*\}/)
  const bracketed = text.match(/\[[\s\S]*\]/)
  const candidates = [fenced?.[1], braced?.[0], bracketed?.[0], text].filter((c): c is string => !!c)
  for (const c of candidates) {
    try {
      const o = JSON.parse(c)
      const arr = Array.isArray(o) ? o : Array.isArray((o as { tasks?: unknown }).tasks) ? (o as { tasks: unknown[] }).tasks : null
      if (arr) return arr as RawTask[]
    } catch {
      /* try next candidate */
    }
  }
  return null
}

// Coerce raw model tasks into MissionTask[]: drop empties, cap at `cap`, mint OUR ids (never trust
// model ids as task ids — they collide across replans and could clash with existing UUIDs), default
// the title from the instruction when the model omits it, and REMAP deps from the model's local ids
// to our minted ids (dropping any dep that points at an unknown / dropped task). `kind` tags the
// provenance ('task' for a plan, 'remediation' for a replan) so the report + replan caps can tell
// them apart.
export function coercePlan(raw: RawTask[], cap = MAX_TASKS, kind: 'task' | 'remediation' = 'task'): MissionTask[] {
  // first pass: keep the usable rows + remember the model's local id → our minted id mapping.
  const idMap = new Map<string, string>()
  const rows: { id: string; title: string; instruction: string; rawDeps: string[] }[] = []
  for (const r of raw) {
    if (rows.length >= cap) break
    if (!r || typeof r !== 'object') continue
    const instruction = typeof r.instruction === 'string' ? r.instruction.trim() : ''
    if (!instruction) continue
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 80) : instruction.slice(0, 60)
    const minted = randomUUID()
    const localId = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : ''
    if (localId && !idMap.has(localId)) idMap.set(localId, minted)
    const rawDeps = Array.isArray(r.deps) ? r.deps.filter((d): d is string => typeof d === 'string') : []
    rows.push({ id: minted, title, instruction, rawDeps })
  }
  // second pass: remap deps to our minted ids, dropping unknown / self refs (kept acyclic-safe).
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    instruction: row.instruction,
    status: 'pending' as const,
    attempts: 0,
    kind,
    deps: row.rawDeps.map((d) => idMap.get(d)).filter((d): d is string => !!d && d !== row.id)
  }))
}

export async function generatePlan(
  goal: string,
  complete: (system: string, user: string) => Promise<string>
): Promise<MissionTask[]> {
  const g = String(goal || '').trim()
  if (!g) throw new Error('Bitte beschreibe das Ziel der Mission.')
  const content = await complete(SYSTEM, `GOAL: ${g}`)
  const raw = parsePlanJson(content)
  if (!raw) throw new Error('Konnte keinen Plan erzeugen — die Antwort war kein gültiges Plan-JSON. Bitte das Ziel konkreter formulieren.')
  const tasks = coercePlan(raw)
  if (tasks.length < 1) throw new Error('Konnte keinen brauchbaren Plan erzeugen — bitte das Ziel konkreter formulieren.')
  return tasks
}

// REPLAN: a task failed its verify gate after retries. Ask the model for remediation tasks that run
// BEFORE the failed goal is re-attempted. Returns [] when the goal is unsatisfiable / no useful fix
// — the overseer treats [] as "give up" and HALTS. The overseer owns all budget caps + the actual
// reset of the failed task's deps; this just proposes the fix steps. Coerced as 'remediation'.
export async function replan(
  goal: string,
  tasks: MissionTask[],
  failedTask: MissionTask,
  failure: string,
  complete: (system: string, user: string) => Promise<string>
): Promise<MissionTask[]> {
  const planSummary = tasks
    .map((t) => `- [${t.status}] ${t.title}${t.id === failedTask.id ? '  <-- FAILED' : ''}`)
    .join('\n')
  const user = [
    `GOAL: ${String(goal || '').trim()}`,
    '',
    'CURRENT PLAN:',
    planSummary,
    '',
    `FAILED TASK: ${failedTask.title}`,
    `INSTRUCTION: ${failedTask.instruction}`,
    '',
    'VERIFY / FAILURE OUTPUT:',
    String(failure || '').slice(0, 2000)
  ].join('\n')
  let content: string
  try {
    content = await complete(REPLAN_SYSTEM, user)
  } catch {
    return [] // a planner error is treated as "no remediation" → the overseer halts loudly
  }
  const raw = parsePlanJson(content)
  if (!raw) return [] // unparseable → give up (halt), never loop
  return coercePlan(raw, MAX_REMEDIATION, 'remediation')
}
