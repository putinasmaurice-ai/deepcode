import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS, projectConfigDir } from '../paths'
import { parseFrontmatter, str } from './frontmatter'
import { SkillDef } from '@shared/types'

// A Skill is a folder (or single .md) containing SKILL.md with frontmatter:
//   ---
//   name: pdf-extract
//   description: Extract text and tables from PDF files
//   ---
//   <detailed instructions...>
//
// Skills are advertised to the model by name+description. When the model
// decides a skill applies, the engine injects the full body into context.

function loadSkillDir(dir: string, source: SkillDef['source']): SkillDef[] {
  const out: SkillDef[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    let file: string | null = null
    if (entry.isDirectory()) {
      const candidate = join(dir, entry.name, 'SKILL.md')
      if (existsSync(candidate)) file = candidate
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
      file = join(dir, entry.name)
    }
    if (!file) continue
    try {
      const text = readFileSync(file, 'utf8')
      const { data, body } = parseFrontmatter(text)
      const name = str(data.name) || entry.name.replace(/\.md$/, '')
      out.push({
        name,
        description: str(data.description) || '(no description)',
        path: file,
        source,
        body
      })
    } catch {
      /* skip */
    }
  }
  return out
}

export function loadSkills(cwd?: string): SkillDef[] {
  const skills = loadSkillDir(PATHS.skills, 'user')
  if (cwd) {
    const projDir = join(projectConfigDir(cwd), 'skills')
    skills.push(...loadSkillDir(projDir, 'project'))
  }
  // plugin skills are merged by the plugin loader
  return skills
}

export function getSkillBody(name: string, cwd?: string): string | null {
  const skill = loadSkills(cwd).find((s) => s.name === name)
  return skill?.body ?? null
}

export function skillExists(name: string, cwd?: string): boolean {
  return loadSkills(cwd).some((s) => s.name === name)
}
