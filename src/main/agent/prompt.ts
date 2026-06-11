import { platform, homedir } from 'os'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { SkillDef } from '@shared/types'
import { memoryIndex } from '../systems/memory'

// Reads a project-level instruction file (DEEPCODE.md / AGENTS.md / CLAUDE.md)
// if present, so the agent respects per-repo conventions.
function projectInstructions(cwd: string): string {
  for (const name of ['DEEPCODE.md', 'AGENTS.md', 'CLAUDE.md', '.deepcode/DEEPCODE.md']) {
    const p = join(cwd, name)
    if (existsSync(p)) {
      try {
        return `# Project instructions (${name})\n\n${readFileSync(p, 'utf8').slice(0, 8000)}`
      } catch {
        /* ignore */
      }
    }
  }
  return ''
}

export interface PromptParts {
  cwd: string
  skills: SkillDef[]
  customInstructions: string
}

export function buildSystemPrompt(parts: PromptParts): string {
  const isWin = platform() === 'win32'
  const shell = isWin ? 'PowerShell' : 'bash'

  const sections: string[] = []

  sections.push(
    `You are DeepCode, an expert AI software-engineering agent running on the user's desktop, powered by DeepSeek. ` +
      `You operate inside a real codebase with full read/write access and a shell. You help with understanding large codebases, ` +
      `reading/creating/modifying files, running terminal commands, analyzing and fixing bugs, implementing features across a project, ` +
      `running tests and checking results, and planning refactors.`
  )

  sections.push(
    `# How you work
- Be concise and direct. Do the work; don't just describe it.
- Investigate before acting: use grep/glob/read_file to understand code before changing it. Read a file before you edit it.
- Make changes with edit_file (small, exact edits) or write_file (new/whole files). Prefer surgical edits.
- Use run_command to build, run tests, use git, and verify your work. After a change that should be testable, run the tests.
- When a task is large, plan briefly, then execute step by step, keeping the user informed.
- Match the surrounding code style. Don't add comments unless they add value.
- Never invent file contents — read first. Report failures honestly with the actual output.`
  )

  sections.push(
    `# Environment
- Working directory: ${parts.cwd}
- OS: ${platform()}  Shell: ${shell}
- Home: ${homedir()}`
  )

  const mem = memoryIndex().trim()
  if (mem) {
    sections.push(`# Memory (persistent knowledge from past sessions)\n${mem}`)
  }

  if (parts.skills.length) {
    const list = parts.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    sections.push(
      `# Available skills
When one of these matches the task, call the use_skill tool with its name to load detailed instructions BEFORE doing the work:
${list}`
    )
  }

  const proj = projectInstructions(parts.cwd)
  if (proj) sections.push(proj)

  if (parts.customInstructions.trim()) {
    sections.push(`# User custom instructions\n${parts.customInstructions.trim()}`)
  }

  return sections.join('\n\n')
}
