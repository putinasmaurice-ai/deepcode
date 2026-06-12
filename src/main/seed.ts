import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'

// Seeds example content for each feature system on first run, so the panels
// are populated and the user can see how Skills / Commands / Subagents / Hooks /
// MCP / Plugins / Automations work. Only writes files that don't already exist.

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) return
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

export function seedStarterContent(): void {
  // --- Skill ---
  writeIfMissing(
    join(PATHS.skills, 'code-review', 'SKILL.md'),
    `---
name: code-review
description: Systematically review code changes for bugs, style and security issues
---

# Code Review

When asked to review code or a diff:

1. Run \`git diff\` (or \`git diff --staged\`) to see the changes. If not a git repo, read the relevant files.
2. For each changed file, evaluate:
   - **Correctness**: logic errors, off-by-one, null/undefined handling, edge cases.
   - **Security**: injection, unsafe input handling, secrets, path traversal.
   - **Style**: matches surrounding conventions, naming, dead code.
   - **Tests**: is the change covered? Are there obvious missing cases?
3. Report findings grouped by severity (Critical / Warning / Nit), each with file:line and a concrete fix.
4. Offer to apply the fixes.
`
  )

  // --- Slash commands ---
  writeIfMissing(
    join(PATHS.commands, 'plan.md'),
    `---
name: plan
description: Produce a step-by-step implementation plan without writing code yet
---

Create a detailed implementation plan for the following task. Investigate the codebase first (read relevant files), identify the files that must change, list concrete steps in order, and call out risks and tests. Do NOT write code yet — just the plan.

Task: $ARGUMENTS
`
  )
  writeIfMissing(
    join(PATHS.commands, 'review.md'),
    `---
name: review
description: Review the current changes for bugs and issues
---

Use the code-review skill to review the current uncommitted changes in this repository. $ARGUMENTS
`
  )
  writeIfMissing(
    join(PATHS.commands, 'fix.md'),
    `---
name: fix
description: Diagnose and fix a bug, then verify with tests
---

Diagnose the following bug. Reproduce it if possible, find the root cause by reading the relevant code, implement a fix, and run the tests to verify. Report what was wrong and what you changed.

Bug: $ARGUMENTS
`
  )

  writeIfMissing(
    join(PATHS.commands, 'branch.md'),
    `---
name: branch
description: Create a feature branch for the current task and switch to it
---

Create a new git branch for the following task and switch to it. Derive a short kebab-case branch name (e.g. feature/fix-login-bug) from the task. If there are uncommitted changes, ask whether to stash, commit, or bring them along. Confirm the result with \`git status\`.

Task: $ARGUMENTS
`
  )
  writeIfMissing(
    join(PATHS.commands, 'pr.md'),
    `---
name: pr
description: Commit current work and open a pull request (gh CLI)
---

Prepare a pull request for the current branch: review the changes (git status, git diff), stage and commit them with a clear conventional-commits message, push the branch, and open a PR with \`gh pr create\` including a concise title and a summary body. Show me the PR description before creating it. If \`gh\` is not installed or not authenticated, explain how to set it up instead.

$ARGUMENTS
`
  )

  // --- Subagent ---
  writeIfMissing(
    join(PATHS.agents, 'code-reviewer.md'),
    `---
name: code-reviewer
description: Independent reviewer that audits a diff or file for bugs and security issues
tools: [read_file, grep, glob, run_command]
---

You are a meticulous senior code reviewer. You are read-only: you investigate and report, you do not modify files. Given a task, inspect the relevant code and return a concise, prioritized list of concrete issues (with file:line) and recommended fixes. Be skeptical and specific.
`
  )

  // --- Hooks (example, no-op friendly) ---
  if (!existsSync(PATHS.hooks)) {
    writeFileSync(
      PATHS.hooks,
      JSON.stringify(
        {
          PreToolUse: [
            {
              matcher: 'run_command',
              command:
                "echo Hook: about to run a shell command"
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    )
  }

  // --- MCP (example, disabled so it doesn't auto-connect) ---
  if (!existsSync(PATHS.mcp)) {
    writeFileSync(
      PATHS.mcp,
      JSON.stringify(
        {
          mcpServers: {
            filesystem: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
              enabled: false
            }
          }
        },
        null,
        2
      ),
      'utf8'
    )
  }

  // --- Example plugin (bundle of a skill + a command) ---
  const pluginRoot = join(PATHS.plugins, 'starter-pack')
  writeIfMissing(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify(
      {
        name: 'starter-pack',
        version: '1.0.0',
        description: 'Example plugin bundling a documentation skill and a /commit command.'
      },
      null,
      2
    )
  )
  writeIfMissing(
    join(pluginRoot, 'skills', 'write-docs', 'SKILL.md'),
    `---
name: write-docs
description: Generate clear README / usage documentation for code
---

# Write Docs

Read the relevant source, infer the public API and how it is used, and produce concise documentation with: overview, install/setup, usage examples, and API reference. Match the project's existing doc style if any.
`
  )
  writeIfMissing(
    join(pluginRoot, 'commands', 'commit.md'),
    `---
name: commit
description: Stage changes and write a conventional commit message
---

Review the current changes with \`git status\` and \`git diff\`, stage the relevant files, and create a git commit with a clear conventional-commits message summarizing the change. Show me the message before committing.
`
  )

  // --- README in the config dir ---
  writeIfMissing(
    join(PATHS.root, 'README.md'),
    `# DeepCode configuration

This folder holds everything that extends DeepCode:

- **skills/** — task playbooks (SKILL.md with frontmatter). Loaded on demand.
- **commands/** — slash-command prompt templates (/name).
- **agents/** — subagent definitions DeepCode can delegate to.
- **hooks.json** — shell commands run on events (PreToolUse, PostToolUse, UserPromptSubmit, Stop).
- **mcp.json** — Model Context Protocol connectors.
- **plugins/** — installable bundles of the above.
- **memory/** — durable knowledge kept across sessions (MEMORY.md is the index).
- **automations.json** — cron-scheduled routines.
- **settings.json** — provider keys, model, permissions.
`
  )
}
