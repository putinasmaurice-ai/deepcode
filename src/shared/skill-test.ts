// Skill testing: a skill folder may contain a tests.json next to SKILL.md describing scenarios.
// Each scenario runs the skill against a prompt and asserts the response. A `mock` response makes
// the check deterministic, OFFLINE and zero-token (validates the harness + assertions); without
// `mock`, the engine runs a real no-tools turn with the skill body as guidance.
//
// tests.json shape:
//   { "scenarios": [
//       { "name": "...", "prompt": "...",
//         "expect": ["substring it SHOULD contain", ...],   // case-insensitive
//         "forbid": ["substring it must NOT contain", ...],
//         "mock": "optional canned response → offline/free" }
//   ] }

export interface SkillScenario {
  name?: string
  prompt: string
  expect?: string[]
  forbid?: string[]
  mock?: string
}

export interface SkillTestResult {
  name: string
  pass: boolean
  usedMock: boolean
  missingExpect: string[] // expected substrings that were absent
  hitForbid: string[] // forbidden substrings that were present
}

// Pure: does `response` satisfy the scenario's expect/forbid assertions? Case-insensitive
// substring matching (no regex → no surprises from user-supplied patterns).
export function evaluateScenario(response: string, scenario: SkillScenario): Omit<SkillTestResult, 'name' | 'usedMock'> {
  const hay = String(response ?? '').toLowerCase()
  const expect = Array.isArray(scenario.expect) ? scenario.expect : []
  const forbid = Array.isArray(scenario.forbid) ? scenario.forbid : []
  const missingExpect = expect.filter((p) => typeof p === 'string' && p && !hay.includes(p.toLowerCase()))
  const hitForbid = forbid.filter((p) => typeof p === 'string' && p && hay.includes(p.toLowerCase()))
  return { pass: missingExpect.length === 0 && hitForbid.length === 0, missingExpect, hitForbid }
}

// Coerce parsed JSON into a clean scenario list (tolerant of malformed entries).
export function parseScenarios(raw: unknown): SkillScenario[] {
  const arr = raw && typeof raw === 'object' && Array.isArray((raw as { scenarios?: unknown }).scenarios)
    ? (raw as { scenarios: unknown[] }).scenarios
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []
  const out: SkillScenario[] = []
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.prompt !== 'string' || !o.prompt.trim()) continue
    out.push({
      name: typeof o.name === 'string' ? o.name : undefined,
      prompt: o.prompt,
      expect: Array.isArray(o.expect) ? o.expect.filter((x): x is string => typeof x === 'string') : undefined,
      forbid: Array.isArray(o.forbid) ? o.forbid.filter((x): x is string => typeof x === 'string') : undefined,
      mock: typeof o.mock === 'string' ? o.mock : undefined
    })
  }
  return out
}
