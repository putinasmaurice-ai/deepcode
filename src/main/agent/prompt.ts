import { platform, homedir } from 'os'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { SkillDef } from '@shared/types'
import { memoryIndex } from '../systems/memory'
import { PATHS } from '../paths'

// Global user-level instructions: ~/.deepcode/DEEPCODE.md (applies to every project).
function globalInstructions(): string {
  const p = join(PATHS.root, 'DEEPCODE.md')
  if (!existsSync(p)) return ''
  try {
    return readFileSync(p, 'utf8').slice(0, 6000)
  } catch {
    return ''
  }
}

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

// Task-scoped project BLUEPRINT (PROJECT.md): a plan-first source of truth for the current effort.
// Read from cwd just like projectInstructions, so it reaches EVERY execution path that has a cwd —
// the main turn, delegated subagents, AND workflow agent nodes — keeping them aligned (no drift).
function projectBlueprint(cwd: string): string {
  for (const name of ['PROJECT.md', '.deepcode/PROJECT.md']) {
    const p = join(cwd, name)
    if (existsSync(p)) {
      try {
        const body = readFileSync(p, 'utf8').slice(0, 8000).trim()
        if (body) return body
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
  project?: { name: string; instructions?: string; goal?: string } | null
  sessionGoal?: string
  planMode?: boolean
  // pre-computed, project-scoped + semantically-narrowed memory index lines. When absent,
  // falls back to the full memoryIndex() (legacy behaviour / embeddings unavailable).
  memoryText?: string
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
- When a task has 3+ steps, call todo_write FIRST with the step list, then keep it updated (doing/done) as you work — the user sees it live.
- Use web_fetch for current documentation, APIs, or error messages when local context is not enough.
- Match the surrounding code style. Don't add comments unless they add value.
- Never invent file contents — read first. Report failures honestly with the actual output.`
  )

  sections.push(
    `# Workflows (Automationen)
Du hast DeepCode-Workflow-Tools: list_workflows, get_workflow, create_workflow, update_workflow, run_workflow, validate_workflow. Ein Workflow ist ein Knoten-Graph im n8n-Stil (Trigger → Schritte → Output, z. B. "jeden Tag News holen und per E-Mail senden").
Wenn der User eine Automation/einen Workflow ERSTELLEN, BAUEN, BEARBEITEN oder REPARIEREN will, MUSST du diese Tools nutzen — NICHT den Code durchsuchen und KEINE Quelldateien schreiben. Entwirf den Knoten-Graphen selbst, rufe create_workflow auf, dann validate_workflow, dann run_workflow, prüfe die Ergebnisse pro Knoten und passe mit update_workflow an — iteriere, bis er sauber läuft.

## Setup-Assistent (nach dem Bauen/Bearbeiten)
Ein Workflow ist erst fertig, wenn er WIRKLICH lauffähig ist — lass NIEMALS Platzhalter wie your-email@example.com, smtp.example.com oder DEIN_TOKEN stehen. Hilf dem User aktiv, die Voraussetzungen einzurichten:
- Nicht-geheime, nutzerspezifische Werte (z. B. E-Mail-Adresse, SMTP-Host/Port, Empfänger, Absender, Provider/Region): FRAG den User direkt im Chat, was er nutzen will, und trage die Antworten dann via update_workflow in die Knoten-Config ein. Keine Dummy-Werte.
- SECRETS / Passwörter / API-Tokens (z. B. SMTP_PASS, Bot-Token): Bitte den User NIEMALS, sie in den Chat zu tippen — sie dürfen nicht durch das LLM oder den Verlauf laufen. Nutze das Tool request_secret (sichere, separate Eingabe-Abfrage), um sie zu erfassen. Mit list_secrets siehst du, welche Secrets bereits gesetzt sind; sag dem User dann GENAU, welche noch fehlen, und erfasse jedes fehlende per request_secret. Den Wert selbst bekommst und brauchst du nie.
- Zeit-/Cron-Trigger: ERKLÄRE, dass DeepCodes Scheduler in-process läuft — es gibt keinen Server, die App muss zur geplanten Zeit GEÖFFNET sein und der PC darf nicht schlafen. Ein täglicher 04:00-Job feuert also nur, wenn DeepCode dann läuft. Schlag bei Bedarf eine realistischere Zeit oder einen manuellen/Event-Trigger vor.
- DENK BEI ABHÄNGIGKEITEN MIT — prüfe pro Knoten, ob etwas konfiguriert sein muss, BEVOR der Workflow laufen kann: (a) ein agent-Knoten (KI-Schritt) nutzt standardmäßig den bereits eingerichteten Provider — KEIN extra Key nötig; setzt der Knoten aber ein Modell mit Präfix (openai:/together:/google:/deepinfra:/local:), muss DESSEN Key bzw. lokaler Endpoint in den Einstellungen stehen — weise den User darauf hin, falls er fehlt. (b) ein http-Knoten gegen eine externe (KI-)API braucht den API-Key als Header, z. B. {{secret.OPENAI_API_KEY}} → per request_secret erfassen. (c) channel/email-Knoten brauchen ihr Token/Passwort als {{secret.*}}. Nenne dem User proaktiv die nötigen Voraussetzungen, statt ihn in einen Laufzeitfehler laufen zu lassen.
Führe den User Schritt für Schritt durch diese Punkte und bestätige mit validate_workflow (und ggf. run_workflow), dass der Workflow lauffähig ist, bevor du ihn für fertig erklärst.`
  )

  sections.push(
    `# Environment
- Working directory: ${parts.cwd}
- OS: ${platform()}  Shell: ${shell}
- Home: ${homedir()}`
  )

  if (parts.planMode) {
    sections.push(
      `# PLAN MODE (active)
You are in plan mode: write/shell tools are disabled. Investigate the codebase with read-only tools (read_file, grep, glob, list_dir, web_fetch), then present a precise, step-by-step implementation plan: files to change, exact edits, risks, and how to verify. Use todo_write to outline the steps. Do NOT attempt modifications.`
    )
  }

  const globalInstr = globalInstructions().trim()
  if (globalInstr) {
    sections.push(`# Global user instructions (~/.deepcode/DEEPCODE.md)\n${globalInstr}`)
  }

  if (parts.project) {
    const p = parts.project
    const projLines = [`# Project: ${p.name}`]
    if (p.instructions?.trim()) projLines.push(p.instructions.trim())
    sections.push(projLines.join('\n'))
  }

  const goal = parts.project?.goal || parts.sessionGoal
  if (goal?.trim()) {
    sections.push(
      `# Active goal\nThe user's standing goal for this work is:\n"${goal.trim()}"\nKeep every action aligned with this goal. If a request conflicts with it, point that out.`
    )
  }

  // The PROJECT.md blueprint is the authoritative plan for the current effort. Inject it high
  // (right after the goal) and in EVERY path (main/subagent/workflow-agent) so delegated work
  // stays aligned with the plan instead of drifting.
  const blueprint = projectBlueprint(parts.cwd)
  if (blueprint) {
    sections.push(
      `# Project blueprint / plan (PROJECT.md)\nThis is the source of truth for the current effort — architecture, decisions, conventions, and the plan. Keep all work (including delegated steps) aligned with it; if you must deviate, say why.\n\n${blueprint}`
    )
  }

  // cap: accumulating memories (error solutions, arena votes) must not bloat
  // every request — the index stays small, details load on demand
  const mem = (parts.memoryText ?? memoryIndex().trim()).slice(0, 4000)
  if (mem) {
    sections.push(
      `# Memory (persistent knowledge from past sessions)\n${mem}\n` +
        `(Only the index is shown above. Call use_memory(name) to load the full content of an entry when it is relevant.)`
    )
  }

  if (parts.skills.length) {
    // Token diet: long skill descriptions would dominate the prompt (some
    // imported ones are 800+ chars). Truncate hard, prefer user/project skills
    // with a one-liner, and list overflow plugin skills as names only.
    const MAX_DESC = 90
    const MAX_DESCRIBED = 40
    const trunc = (s: string): string => {
      const clean = s.replace(/\s+/g, ' ').trim()
      return clean.length > MAX_DESC ? clean.slice(0, MAX_DESC - 1) + '…' : clean
    }
    const ordered = [...parts.skills].sort(
      (a, b) => Number(a.source === 'plugin') - Number(b.source === 'plugin')
    )
    const described = ordered.slice(0, MAX_DESCRIBED)
    const rest = ordered.slice(MAX_DESCRIBED)
    const lines = described.map((s) => `- ${s.name}: ${trunc(s.description)}`)
    if (rest.length) {
      lines.push(`- (more, by name): ${rest.map((s) => s.name).join(', ')}`)
    }
    sections.push(
      `# Available skills
When one matches the task, call use_skill with its name to load full instructions BEFORE doing the work:
${lines.join('\n')}`
    )
  }

  const proj = projectInstructions(parts.cwd)
  if (proj) sections.push(proj)

  if (parts.customInstructions.trim()) {
    sections.push(`# User custom instructions\n${parts.customInstructions.trim()}`)
  }

  return sections.join('\n\n')
}
