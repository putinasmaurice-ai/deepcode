import { randomUUID } from 'crypto'
import { MissionTask } from '@shared/types'

// Turn a high-level goal into a LINEAR plan of 3-8 tasks (title + instruction) via an LLM.
// Pure logic over a `complete(system, user)` callback — no electron/engine imports — so the
// risky parse/coerce path can be unit-tested against synthetic model output. Tolerant JSON
// extraction mirrors @shared/workflow-gen (fenced / braced / raw candidates).

const MAX_TASKS = 8

const SYSTEM = `You are a planning assistant for an autonomous coding agent.
Decompose the user's high-level GOAL into a LINEAR, ordered list of 3 to 8 concrete tasks.
Each task is one self-contained step the coding agent will execute as a single turn, in order.
Output STRICT JSON only — no prose, no code fences — of this exact shape:
{"tasks": [{"title": string, "instruction": string}]}
Rules: keep it linear (no branching, no parallelism). Order tasks so each builds on the previous.
"title" is a short label (a few words). "instruction" is a precise, standalone description of what
to do in that step. Do NOT include verification/testing as separate tasks — a machine verify gate
runs automatically after every task. Aim for 3-6 tasks unless the goal truly needs more.`

interface RawTask {
  title?: unknown
  instruction?: unknown
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

// Coerce raw model tasks into MissionTask[]: drop empties, cap at MAX_TASKS, mint ids, default
// the title from the instruction when the model omits it.
export function coercePlan(raw: RawTask[]): MissionTask[] {
  const tasks: MissionTask[] = []
  for (const r of raw) {
    if (tasks.length >= MAX_TASKS) break
    if (!r || typeof r !== 'object') continue
    const instruction = typeof r.instruction === 'string' ? r.instruction.trim() : ''
    if (!instruction) continue
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 80) : instruction.slice(0, 60)
    tasks.push({ id: randomUUID(), title, instruction, status: 'pending', attempts: 0 })
  }
  return tasks
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
