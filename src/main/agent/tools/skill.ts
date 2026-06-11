import { Tool, ok, fail } from './types'
import { SkillDef } from '@shared/types'

// The use_skill tool loads the full instructions for a named skill into context.
// Skills are advertised (name + description) in the system prompt; the model
// calls this when one applies, getting the detailed step-by-step body.
export function makeSkillTool(skills: SkillDef[]): Tool {
  const names = skills.map((s) => s.name)
  return {
    name: 'use_skill',
    description:
      'Load the full instructions for an installed skill by name. Call this when a skill from the ' +
      'available list matches the task, BEFORE doing the work, then follow the returned instructions. ' +
      (names.length ? `Available skills: ${names.join(', ')}.` : 'No skills are installed yet.'),
    permission: 'none',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name to load.' }
      },
      required: ['name']
    },
    summarize: (a) => `Skill: ${a.name}`,
    async execute(args) {
      const skill = skills.find((s) => s.name === args.name)
      if (!skill) return fail(`No skill named "${args.name}". Available: ${names.join(', ') || 'none'}`)
      return ok(`# Skill: ${skill.name}\n\n${skill.body ?? '(empty skill)'}`)
    }
  }
}
