import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { loadSkills } from './skills'
import { parseScenarios, evaluateScenario, SkillScenario, SkillTestResult } from '@shared/skill-test'

// Load a skill's test scenarios from tests.json sitting next to its SKILL.md.
export function loadSkillScenarios(skillName: string, cwd?: string): { found: boolean; scenarios: SkillScenario[]; body: string } {
  const skill = loadSkills(cwd).find((s) => s.name === skillName)
  if (!skill) return { found: false, scenarios: [], body: '' }
  const testsPath = join(dirname(skill.path), 'tests.json')
  let scenarios: SkillScenario[] = []
  if (existsSync(testsPath)) {
    try {
      scenarios = parseScenarios(JSON.parse(readFileSync(testsPath, 'utf8')))
    } catch {
      /* malformed tests.json → no scenarios */
    }
  }
  return { found: true, scenarios, body: skill.body ?? '' }
}

// Run scenarios: each uses its `mock` response if present (offline/free), else `complete()` runs
// the skill body + prompt through the model. Returns per-scenario pass/fail.
export async function runSkillScenarios(
  body: string,
  scenarios: SkillScenario[],
  complete: (system: string, prompt: string) => Promise<string>
): Promise<SkillTestResult[]> {
  const system =
    "You are an AI coding assistant. Apply the following SKILL to the user's request, then respond as you normally would:\n\n" +
    body
  const results: SkillTestResult[] = []
  for (const sc of scenarios) {
    const usedMock = typeof sc.mock === 'string'
    const response = usedMock ? sc.mock! : await complete(system, sc.prompt)
    const ev = evaluateScenario(response, sc)
    results.push({ name: sc.name || sc.prompt.slice(0, 50), usedMock, ...ev })
  }
  return results
}
