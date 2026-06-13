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
  // example skill tests (run with /skill-test code-review) — both use `mock` so they pass
  // offline/zero-token and demonstrate the format; omit "mock" to run the real model.
  writeIfMissing(
    join(PATHS.skills, 'code-review', 'tests.json'),
    JSON.stringify(
      {
        scenarios: [
          {
            name: 'flags a SQL injection and proposes a fix',
            prompt: "Review: db.query('SELECT * FROM users WHERE id = ' + req.params.id)",
            expect: ['injection', 'fix'],
            forbid: ['looks good', 'no issues'],
            mock: 'Critical (security): SQL injection — user input is concatenated into the query. Fix: use a parameterized query, e.g. db.query("... WHERE id = ?", [req.params.id]).'
          },
          {
            name: 'groups findings by severity',
            prompt: 'Review a function that ignores its return value and has an off-by-one loop.',
            expect: ['critical', 'nit'],
            mock: 'Critical: off-by-one in the loop bound (use < length). Warning: return value ignored. Nit: name the magic number.'
          }
        ]
      },
      null,
      2
    )
  )

  // --- Skill: skill-creator (how to author good skills) ---
  writeIfMissing(
    join(PATHS.skills, 'skill-creator', 'SKILL.md'),
    `---
name: skill-creator
description: Author effective, well-scoped skills for DeepCode — progressive disclosure, sharp triggers, testable
---

# Skill creator

A skill is \`skills/<name>/SKILL.md\` with frontmatter (\`name\`, \`description\`) + a markdown playbook. The model is shown only name+description until it decides the skill applies, then the full body is injected.

1. **Trigger lives in the description**, not the body: write a crisp \`description\` that says WHEN to use it (the model matches on this). Don't bury the trigger in prose.
2. **Progressive disclosure / keep it tight**: aim well under ~500 lines. State the procedure as numbered, generalized steps with concrete commands/patterns — not an essay. Small local models have tight context budgets.
3. **One job per skill**: split unrelated procedures into separate skills.
4. **Make it testable**: add a \`tests.json\` next to SKILL.md with scenarios — \`prompt\`, \`expect\` (substrings the response should contain), \`forbid\` (must not contain), and an optional \`mock\` response so the test runs offline/zero-token. Validate with \`/skill-test <name>\`.
5. Avoid session-specific paths/secrets; reference tools by name (read_file, run_command, use_skill, web_request, …).
`
  )

  // --- Skill: ast-grep structural search/rewrite (CLI via run_command) ---
  writeIfMissing(
    join(PATHS.skills, 'ast-grep', 'SKILL.md'),
    `---
name: ast-grep
description: Structural (AST-aware) code search and safe codemods with ast-grep — precise where text grep is noisy
---

# ast-grep (structural code search & rewrite)

Use this for *structural* code queries and safe, project-wide refactors — far more precise than text \`grep\` because it matches the syntax tree, not characters.

Prerequisite: the \`ast-grep\` (alias \`sg\`) CLI. Check with \`ast-grep --version\`; if missing, install via \`npm i -g @ast-grep/cli\` (ask first).

1. **Search by pattern** — metavariables (\`$VAR\`, \`$$$ARGS\`) match any node:
   - \`ast-grep run -p 'console.log($$$)' -l ts\` — find all console.log calls.
   - \`ast-grep run -p 'useEffect($CB, [])' -l tsx\` — find mount-only effects.
2. **Rewrite (codemod)** — preview first, then apply:
   - \`ast-grep run -p 'var $X = $Y' -r 'const $X = $Y' -l js\` (preview)
   - add \`-U\` (or \`--update-all\`) to write the changes once the preview looks right.
3. Prefer ast-grep over regex when matching code shapes (calls, imports, JSX elements, function signatures). Use plain \`grep\`/\`semantic_search\` for free-text or natural-language queries.
4. Always show the matches/diff before applying a rewrite, and re-run tests afterwards.
`
  )

  // --- Skill: webapp testing via the Playwright MCP (closes the build->run->verify loop) ---
  writeIfMissing(
    join(PATHS.skills, 'webapp-testing', 'SKILL.md'),
    `---
name: webapp-testing
description: Drive and verify a running web app (click, fill, screenshot, read console) via the Playwright MCP — confirm a change actually works in the browser
---

# Webapp testing (Playwright)

Use this to VERIFY a frontend change in the real browser, not just by reading code.

Prerequisite: the **Playwright** MCP connector (Marketplace → 1-click activate, or it's in mcp.json). Its tools appear as \`mcp__*\` (navigate, click, fill, snapshot/screenshot, read console/network).

1. Make sure the app is running (start the dev server with a background command if needed, e.g. \`npm run dev\`).
2. Navigate to the page, then reproduce the user flow with the Playwright tools: click, fill forms, submit.
3. Verify the result: read the visible text / DOM snapshot, check for the expected element, and read the **browser console + network** for errors.
4. On a failure, capture a screenshot and the console output, form a hypothesis, fix the code, and re-run the flow until it passes.
5. Report what you exercised and the outcome (pass/fail + evidence).
`
  )

  // --- Skill: frontend-design ---
  writeIfMissing(
    join(PATHS.skills, 'frontend-design', 'SKILL.md'),
    `---
name: frontend-design
description: Build distinctive, production-grade UIs (sites, landing pages, dashboards, React/HTML-CSS) that avoid the generic AI look
---

# Frontend design

When building or restyling any web UI, aim for a polished, intentional result — not the default AI aesthetic.

1. **Set a direction** before coding: pick a real visual concept (typography pairing, a restrained palette with one confident accent, spacing scale, a motif). State it in one sentence.
2. **Avoid AI-generic tells**: no centered everything, no purple-blue gradients by default, no equal-weight cards. Use deliberate hierarchy, asymmetry where it helps, and generous whitespace.
3. **Type & color**: choose distinctive web fonts; define a small token set (bg/surface/text/muted/accent) as CSS variables and use them consistently. Ensure WCAG-AA contrast.
4. **Detail**: hover/focus states, smooth but subtle motion, empty/loading/error states, responsive at real breakpoints.
5. Match the project's existing stack/conventions; ship semantic, accessible HTML.
`
  )

  // --- Skill: mcp-builder ---
  writeIfMissing(
    join(PATHS.skills, 'mcp-builder', 'SKILL.md'),
    `---
name: mcp-builder
description: Scaffold a high-quality MCP server (TypeScript MCP SDK or Python FastMCP) — research, implement, review
---

# MCP builder

To build a Model Context Protocol server DeepCode (or any MCP client) can connect to:

1. **Pick the stack**: TypeScript (\`@modelcontextprotocol/sdk\`) or Python (\`fastmcp\`). Prefer the one matching the target API's SDK.
2. **Design tools first**: each tool = a clear name, a JSON-schema input, and a focused description. Keep tools small and composable; return concise, structured text.
3. **Implement** over stdio transport. Validate inputs, handle errors as tool results (don't crash), and never block on unbounded I/O.
4. **Secrets** via environment variables, never hardcoded. Document required env keys in the README.
5. **Test** with a dev MCP client; verify each tool's schema + a happy path + an error path.
6. Ship a README with the exact \`npx\`/\`uvx\` run command so it drops straight into a catalog/mcp.json.
`
  )

  // --- Skill: xlsx ---
  writeIfMissing(
    join(PATHS.skills, 'xlsx', 'SKILL.md'),
    `---
name: xlsx
description: Create, read and edit spreadsheets (.xlsx/.xlsm/.csv) — formulas, formatting, charts, data cleaning — via Python
---

# Spreadsheets (xlsx/csv)

Use Python via the shell tool. Ensure libs: \`pip install openpyxl pandas\` (ask before installing).

- **Read/analyze**: \`pandas.read_excel\`/\`read_csv\` → inspect with \`.head()\`, \`.describe()\`, group/pivot.
- **Create/edit .xlsx**: \`openpyxl\` for cell values, formulas (\`ws['C2'] = '=A2*B2'\`), number formats, column widths, and charts (\`openpyxl.chart\`).
- **Clean messy data**: fix headers, types, dedupe, handle NaNs before writing back.
- Write a short Python script, run it with \`python script.py\`, then confirm the output file. Don't hand-edit the binary.
`
  )

  // --- Skill: pdf ---
  writeIfMissing(
    join(PATHS.skills, 'pdf', 'SKILL.md'),
    `---
name: pdf
description: Work with PDFs — extract text/tables, merge/split/rotate, fill forms, watermark, OCR — via Python
---

# PDF toolkit

Use Python via the shell tool. Libs by task (ask before installing): \`pypdf\` (merge/split/rotate/encrypt), \`pdfplumber\` (extract text + tables), \`reportlab\` (create), \`pytesseract\`+\`pdf2image\` (OCR scanned PDFs).

1. **Extract**: \`pdfplumber\` page-by-page for text and \`.extract_tables()\` for tables.
2. **Manipulate**: \`pypdf.PdfWriter\` to merge/split/rotate/watermark/encrypt.
3. **Create**: \`reportlab\` canvas/platypus for generated reports.
4. **Scanned/no text layer**: rasterize with \`pdf2image\`, OCR with \`pytesseract\`.
Write a script, run it, verify the result file + a sample of the extracted content.
`
  )

  // --- Skill: docx ---
  writeIfMissing(
    join(PATHS.skills, 'docx', 'SKILL.md'),
    `---
name: docx
description: Create, read and edit Word .docx — headings, tables, TOC, page numbers, find/replace — via Python
---

# Word documents (.docx)

Use Python (\`pip install python-docx\`) via the shell tool.

- **Create**: \`docx.Document()\` → add headings (\`add_heading\`), paragraphs, tables, page breaks; set styles for a consistent look.
- **Read/extract**: iterate \`doc.paragraphs\` and \`doc.tables\` to pull text/structure.
- **Edit/find-replace**: walk runs to preserve formatting while replacing text.
- For TOC/letterheads/complex layout, build from styles; for PDF output, convert via LibreOffice (\`soffice --headless --convert-to pdf\`) if available.
Write a script, run it, verify the output document.
`
  )

  // --- Skill: postgres-best-practices ---
  writeIfMissing(
    join(PATHS.skills, 'postgres-best-practices', 'SKILL.md'),
    `---
name: postgres-best-practices
description: Vendor-neutral Postgres optimization — query tuning, indexing, schema design, security
---

# Postgres best practices

When designing or tuning Postgres (via the sqlite/postgres MCP or shell \`psql\`):

1. **Tune queries with \`EXPLAIN (ANALYZE, BUFFERS)\`** — read the plan; fix seq-scans on big tables, bad row estimates (ANALYZE/stats), and N+1 access patterns.
2. **Index deliberately**: B-tree for equality/range, composite in selectivity order, partial/expression indexes for filtered queries, GIN for jsonb/full-text. Don't over-index writes.
3. **Schema**: correct types (timestamptz, numeric for money, jsonb over json), NOT NULL + sensible defaults, FKs with the right ON DELETE, normalize then denormalize only with evidence.
4. **Concurrency/safety**: short transactions, explicit lock awareness, online DDL (\`CREATE INDEX CONCURRENTLY\`), RLS for multi-tenant.
5. **Connections**: pool (pgbouncer) rather than many direct connections.
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
