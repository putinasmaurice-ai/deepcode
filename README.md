# DeepCode

An agentic coding **desktop app** powered by **DeepSeek** — a Claude-Code / Codex-style
assistant that understands large codebases, reads/creates/modifies files, runs terminal
commands, analyzes and fixes bugs, implements features across a project, runs tests, and
plans refactors.

Built with **Electron + React + TypeScript**. Works against any OpenAI-compatible endpoint;
set your model id (`deepseek-chat`, `deepseek-reasoner`, or your "v4 PRO" id) in Settings.

## Run it

```bash
npm install
npm run dev          # development with hot reload
# or
npm run build && npm run start   # run the production build
npm run package:win  # build a Windows installer (NSIS) into ./release
```

On first launch, open **Settings** and paste your DeepSeek API key + model.

## Feature map (your requested concepts)

| Concept | Where it lives | What it does |
| --- | --- | --- |
| **Plugin** | `~/.deepcode/plugins/<name>/` (`plugin.json` + skills/commands/agents/hooks/mcp) | Installable bundle of several capabilities. Toggle in the Plugins panel. |
| **Skill** | `~/.deepcode/skills/<name>/SKILL.md` | A task playbook. The agent calls `use_skill` to load it when it matches. |
| **MCP / Connector** | `~/.deepcode/mcp.json` | Connect external tools/data via Model Context Protocol; their tools become callable. |
| **Subagent** | `~/.deepcode/agents/<name>.md` | A specialized assistant the agent delegates to via the `task` tool. |
| **Hook** | `~/.deepcode/hooks.json` | Shell command run automatically on events (PreToolUse, PostToolUse, UserPromptSubmit, Stop). |
| **Memory** | `~/.deepcode/memory/*.md` (+ `MEMORY.md` index) | Durable knowledge. **Semantically retrieved** (only the most relevant entries injected per turn, via local embeddings — scales past a flat index), **project-scoped** (a memory can apply to one project or globally), and **auto-distilled** on demand with `/remember`. |
| **Automation / Routine** | `~/.deepcode/automations.json` | Cron-scheduled prompts that run the agent headlessly. |
| **Slash Command** | `~/.deepcode/commands/<name>.md` | Prompt template triggered by typing `/name` in chat. |
| **Workflow** | `~/.deepcode/workflows/<id>.json` (runs under `workflows/runs/`) | Visual node-graph automation (n8n-style): wire Agent/Tool/Shell/HTTP/Condition/Transform/Sub-workflow/Output nodes on a canvas, run them, watch per-node status live. |

Everything is file-based and editable — use **Open config folder** in any panel.

## Core capabilities

The agent runs a streaming tool-calling loop with these built-in tools:

- `read_file`, `write_file`, `edit_file`, `apply_patch` (atomic multi-file), `list_dir`, `glob`, `grep`
- `run_command` — shell (PowerShell on Windows); `run_background_command`/`job_status`/`kill_job` for long-running jobs
- `web_fetch` — read documentation/APIs from the internet
- `task` — delegate to a subagent · `use_skill` — load skill instructions · `use_memory` — load a stored memory entry · `todo_write` — visible task list
- `claude_code` — *optional* helper: delegate a sub-task to the Claude Code CLI (read-only by default). DeepSeek stays the orchestrator; Claude costs bill to your Anthropic account. Enable in Settings.
- any tools exposed by connected MCP connectors

**🧪 Provable changes** — the quality loop now reads your test runner's *structured* output
(vitest/jest/pytest/mocha JSON) and feeds the agent the **one failing test** (name + message),
not a 5000-char wall — far higher-signal auto-fixes. And when a project has **no** verify command,
opt-in "Beweisbare Änderungen" makes the agent synthesize a focused test and **prove it red-first**:
the test must FAIL against the reverted (old) code and PASS against the new — proof, not a claim.
(The revert is an in-memory swap with disk backups + a guaranteed, retried restore, so your work is
never left reverted; on a persistent restore failure it stops loudly and keeps the backups.)

Modes: **Interaktiv** (asks before changes), **Plan** (read-only, proposes a plan), **Auto** (approves everything).
File changes are checkpointed — `/rewind` undoes the last turn. Dangerous commands always require approval.

**📁 Arbeitsplatz pro Chat** — beim Start eines **neuen Chats** (Strg+N / Palette / Sidebar-`+`)
fragt DeepCode zuerst, in welchem Ordner der Agent arbeiten soll: vorhandenen **wählen**, leer
lassen (Standard-Ordner) oder **„＋ Neuer Ordner…"** für einen frischen, leeren Projektordner — so
landet ein neues Projekt in seinem eigenen Ordner (wie in Claude Code Desktop). Auch im laufenden
Chat wechselt der `📁`-Anzeiger im Header das Arbeitsverzeichnis, und der Button **„＋ Ordner"**
legt direkt einen neuen an. Dasselbe **„Neu…"** gibt es im **Projekte**-Panel beim Anlegen eines
Projekts. (Auto-Chats beim Start und projektgebundene Chats starten ohne Nachfrage.)

**🗂️ Multi-Session-Tabs** — mehrere Chats gleichzeitig offen, als Browser-artige **Tab-Leiste**
über dem Chat. Wechsle per Klick oder **Strg+Tab / Strg+Umschalt+Tab**, schließe einen Tab mit `✕`
oder Mittelklick (der Chat bleibt in der Seitenleiste, wird nicht gelöscht). Bei vielen Tabs
**scrollt die Leiste horizontal** (Trackpad/Mausrad) statt zu zerquetschen, der aktive Tab wird
beim Wechsel automatisch in den sichtbaren Bereich geholt, und Tabs lassen sich **per Drag &
Drop umsortieren** (die Reihenfolge bleibt über Neustarts erhalten). Da das Backend jede
Session **unabhängig pro ID** ausführt, laufen **Hintergrund-Tabs weiter**: ein pulsierender Punkt
markiert einen Tab, dessen Agent gerade arbeitet, und ein Toast meldet, wenn ein Hintergrund-Chat
fertig ist. Offene Tabs + aktiver Tab werden über Neustarts hinweg gemerkt.

**🐝 Swarm mode** — `/swarm <task>` plans the task into independent sub-tasks and runs them **in
parallel, each in its own isolated git worktree + branch**, so their edits can't collide — then
reports the branches for you to review and merge. A first-class orchestrator (not the `task` tool):
workers are unattended-gated and **sandboxed to file edits only** (read/edit/grep/glob — no
shell/git/network), and the run is bounded by the wall-clock ceiling AND a **hard total-cost cap**
(the day's budget): once the workers' accumulated spend crosses it, no further workers are launched
— so a single parallel run can't overshoot the daily budget — while the workers that already
finished still commit. Every worktree is torn down even on Stop/timeout (a worker whose commit
fails is preserved, not discarded).
Great for "migrate all N modules" — parallel instead of a serial grind. A **🐝 Schwarm** panel
then lists the resulting `swarm/*` branches: review each diff and **merge** it into your current
branch with one click (a dirty tree is refused and a conflicting merge is safely aborted so the
repo is never left half-merged) or discard it.

Built-in slash commands: `/help /init /goal /cost /model /compact /rewind /jobs /learn /remember /wf /swarm /skill-test /blueprint` + file-based custom commands.

**📋 Project blueprint** — a `PROJECT.md` in the project root (set with `/blueprint <plan>`, or
`/blueprint generate` to have the agent write one) is a plan-first source of truth that is injected
into **every** execution path that has the project's cwd — the main chat, **delegated sub-agents**,
and **workflow agent steps** — so delegated work stays aligned with the plan instead of drifting.

**🕸️ Visual workflow builder** — a graphical canvas (React Flow) where you wire nodes into an
automation and run it: **Agent** (a full DeepSeek tool-loop turn), **Tool** (any built-in tool),
**Shell**, **HTTP** (GET/POST/headers/body), **Condition** (true/false), **Switch** (multi-way
branch), **Transform** (template/regex/set), **Code** (sandboxed JS over the vars), **Parse**
(JSON-path / CSV / HTML→text), **Store** (persistent key/value state across runs — counters, dedup),
**Channel** (Telegram / Slack / Discord / webhook), **Email** (send over SMTP — password from an
encrypted secret), **Loop / forEach** (run a body workflow per list
item, sequential or bounded-parallel), **Parallel** (run N branch workflows at once) + **Merge**,
**Delay** (wait), **Notify** (desktop notification), **Sub-workflow**, **Output**.
Connections are visible and animated; each node shows live ⏳/✅/❌ status **and the data/error it
produced** while the run streams; results flow between nodes via `{{variables}}` (click a variable chip to insert one).
- **Cron triggers** — set a trigger node to a schedule and the workflow runs unattended (`0 9 * * *`).
- **🩹 Self-healing** — when a node fails, the in-process coder gets the node's config + error +
  (secret-masked) input, diagnoses with grep/read/edit on the actual project, patches the node
  config **or** fixes a referenced file, then **replays from the failed node** with the exact input
  it saw (no upstream re-run) — the same agent that would write the automation fixes it. One click
  "Reparieren" in the run history, or opt-in **Auto-Heilung** for unattended cron/file-watch/chat
  runs (bounded by attempts + the daily spend cap; the repair agent stays unattended-gated, so
  MCP/claude_code/git-push remain blocked). Something no standalone n8n/Zapier can do.
- **File-watch triggers** — set the trigger to `filewatch` with a path/glob (e.g. `src` + `*.ts`) and
  the workflow fires whenever a matching file under the project changes (debounced, throttled, and
  suppressed while the agent itself is writing — no self-trigger loops). Event-driven automation, not
  just scheduled.
- **Pre-run validation** — disconnected nodes, missing config and dangling edges are caught and
  highlighted *before* a run, with a plain-language issue list (click an issue to jump to the node).
- **Run history** — inspect every past run: per-node input/output, errors, duration, final result.
- **Per-node error handling** — retries (with delay) and *continue-on-error* so one flaky step
  doesn't kill the whole run.
- **Rich expressions** — beyond `{{var}}`: read another node's output and JSON-path into it
  (`{{node.fetch.user.name}}`, `{{item[0]}}`) — pure, safe, no `eval`.
- **Encrypted secrets** — store API tokens once (OS-encrypted) and use `{{secret.NAME}}` in
  tool/shell/http args; values are masked out of every run record, event and log, and barred
  from agent prompts.
- **Run from chat** — `/wf` lists your workflows and `/wf <Name> [Eingabe]` runs one inline: the
  text becomes `{{input}}`, **each node's progress shows live** in the chat, the run is **cancellable
  with Stop/Escape**, and its result (`output`/`result`/`last`, secret-masked) is posted back into
  the chat. The coding app and the automation tool, fused in one prompt.
- **Starter templates** — a "Aus Vorlage" picker spins up ready-to-run workflows in one click
  (Code-Review, run-tests-and-summarize, URL→summary, git→changelog, project overview, a daily
  cron dependency check). Each is self-contained, so you can run it from chat immediately, then
  tweak it on the canvas.
- **Generate from a description** — "✨ Aus Beschreibung": describe what you want in a sentence and
  DeepSeek builds the graph for you. The result is validated (and auto-repaired once) before it's
  saved, then opened on the canvas to review and tweak. You describe the automation; you don't draw it.
- **Outbound HTTP (POST/PUT/headers/body/auth)** — the HTTP node does real API calls now, not just
  GET — so a workflow can hit a **Telegram bot, a webhook, Slack/Discord, or an email API**. Bot
  tokens live in encrypted `{{secret.NAME}}`; same SSRF guard (private/loopback blocked) as web_fetch.
  Starter templates included: **Telegram-Nachricht**, **Webhook senden**, **Täglicher Reminder**,
  **Wöchentliche Zusammenfassung** (cron timers), **Bei Datei-Änderung → E-Mail** (file-watch +
  SMTP) and **Projekt-Report per E-Mail**.
- **Import / Export** — share or back up a workflow as a single `.json` file.
- **Safe unattended** — every unattended entry point (workflow agent node, tool node, cron
  trigger, **and delegated sub-agents**) shares ONE screen: no dangerous shell (`rm -rf`,
  `format`, fork-bombs, `git push -f`), no MCP / Claude Code / sub-agent delegation, no outward
  `git push` / `gh pr create` — whether issued as a structured call or a raw shell command.
  Loops, step counts and a hard wall-clock ceiling bound every run.

It's your KI-coding app and a `/goal` automation tool in one — like n8n, only simpler and clearer.

**👁 Live preview pane** — a side panel next to the chat that renders the project you're building
(static `index.html` or a dev-server URL, auto-detected) in an isolated webview, like Claude Code's preview.
**Closed-loop:** the agent can `preview_probe` the running app — screenshot (→ vision description),
read the console, click and type — so it catches **runtime** errors the compiler can't see, fixes
them, and re-checks, all without you copy-pasting a stack trace. A runtime error in the preview
also surfaces a one-click **"Fix this"** chip that hands the stack to the agent. (Probes run in an
isolated world, are time-bounded, and are blocked in unattended runs.)

**🛒 Marketplace** — a curated, one-click **MCP-connector catalog (30+, searchable, by category)**:
code-intelligence (Serena, ast-grep, Repomix), RAG/vector (Chroma, local-RAG, Qdrant), web/search
(DuckDuckGo, SearXNG, Brave), browser (Chrome DevTools), databases (Postgres/MySQL/MongoDB/DuckDB),
plus time, Notion, Docker and more — activate and connect in a click. Built-in **agent skills**
ship out of the box: code-review, ast-grep, webapp-testing (Playwright), frontend-design,
mcp-builder, xlsx/pdf/docx, postgres-best-practices.

**🔬 Run traces (observability)** — a Traces panel that replays each chat turn as a correlated
**tree**: every LLM call (with its cost + tokens), every tool call (with duration and ok/error),
nested **subagents**, plus verify and context-compaction — so you can see exactly where a turn spent
its time and money. A `write_file`/`edit_file` span carries an **expandable before→after diff**
(`▸ +added/−removed`) right in the tree, so you see *what* a tool changed, not just that it ran
(secret-redacted, capped, collapsed by default). One JSON per turn under `~/.deepcode/traces/`
(kept local), pruned to the newest few hundred; a cancelled or errored turn still produces a complete tree.

More: Projects (instructions + goal + trust level), cost dashboard (per chat/project/total —
accurate to the DeepSeek **off-peak discount** and a **per-vendor price card** for DeepInfra/Google),
@-file mentions, drag&drop attachments, edit-and-resend, regenerate, GitHub-flavored
markdown rendering with syntax highlighting, session export, desktop notifications.
Per-command **approval allowlist** ("Immer erlauben" — exact command, scoped to its project dir; managed in Settings).

**Keyboard:** `Ctrl+P` command palette (fuzzy: every view, action & recent chat) ·
`Ctrl+F` in-chat find · `Ctrl+N` new chat · `Ctrl+K` focus composer · `Esc` cancel turn ·
`Y`/`N`/`A` approve / deny / approve-all the pending tool call. The context pill is
model-aware (knows each model's real context window).

Models: the configured DeepSeek model, any Ollama/LM Studio model via the `local:` prefix
(free, offline), and any **DeepInfra** model via the `deepinfra:` prefix (OpenAI-compatible —
e.g. `deepinfra:deepseek-ai/DeepSeek-V4-Flash`, configured under Settings → ☁️ DeepInfra).
🔓 Uncensored toggle (local unaligned model).

**👁 Bild-Analyse — ONLINE/LOKAL:** DeepSeek can't see images, so when you attach one a
**vision model describes it first** and DeepSeek works from that description. A one-click topbar
toggle (and a Settings card) switches between **ONLINE** — Google **Gemini 2.5 Flash-Lite**
(Google AI Studio, OpenAI-compatible; key stored encrypted) — and **LOKAL** — a local Ollama
vision model (free, offline). Online mode auto-engages Gemini on image attachments and falls
back to the local model with a notice if no Google key is set.

## Architecture

```
src/
  shared/         types + IPC channel names (used by all processes)
  main/           Electron main process
    agent/        DeepSeek client, the agentic engine, prompt builder, tools/
    systems/      skills, commands, subagents, hooks, memory, mcp, plugins, automations
    store.ts      settings + session persistence (~/.deepcode)
    ipc.ts        IPC handlers wiring the renderer to the engine
  preload/        contextBridge API (window.deepcode)
  renderer/       React UI (chat, streaming, tool approvals, all management panels)
test/             vitest tests for the pure logic (pricing, danger heuristic, cron matcher,
                  context-window map, message elision, line-diff) AND real-git/store integration
                  suites for the flagship orchestration (swarm worktree lifecycle, Time Machine
                  timeline correlation + state reconstruction, Mission Control overseer)
```

`npm run typecheck && npm test` gates every push via GitHub Actions CI.
`node scripts/ui-smoke.mjs` launches the built app via Playwright, clicks through every
view/flow and asserts zero console errors / uncaught exceptions. `scripts/ui-approval.mjs`
drives a real tool-call through the live approval card. A headless real-API end-to-end run
(`DEEPCODE_E2E_PROMPT`) exercises the full tool loop against DeepSeek.

File access is confined to the working directory (`confineToCwd`, symlink-resolved); the
renderer-facing read IPCs (`readFileHead`, `imageDataUri`) are likewise confined and
image reads are validated by magic bytes, so untrusted rendered content can't exfiltrate
arbitrary files.

## Notes

- DeepSeek's public API currently exposes `deepseek-chat` and `deepseek-reasoner`. The model
  id and base URL are configurable, so any compatible "v4 PRO" endpoint plugs in without code
  changes.
- Sessions, settings, and all extensions are stored under `~/.deepcode`.
