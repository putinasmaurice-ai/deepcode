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

Modes: **Interaktiv** (asks before changes), **Plan** (read-only, proposes a plan), **Auto** (approves everything).
File changes are checkpointed — `/rewind` undoes the last turn. Dangerous commands always require approval.

Built-in slash commands: `/help /init /goal /cost /model /compact /rewind /jobs /learn /remember /wf` + file-based custom commands.

**🕸️ Visual workflow builder** — a graphical canvas (React Flow) where you wire nodes into an
automation and run it: **Agent** (a full DeepSeek tool-loop turn), **Tool** (any built-in tool),
**Shell**, **HTTP**, **Condition** (true/false), **Switch** (multi-way branch), **Transform**
(template/regex/set), **Loop / forEach** (run a body workflow per list item, sequential or
bounded-parallel), **Parallel** (run N branch workflows at once) + **Merge**, **Delay** (wait),
**Notify** (desktop notification), **Sub-workflow**, **Output**.
Connections are visible and animated; each node shows live ⏳/✅/❌ status **and the data/error it
produced** while the run streams; results flow between nodes via `{{variables}}` (click a variable chip to insert one).
- **Cron triggers** — set a trigger node to a schedule and the workflow runs unattended (`0 9 * * *`).
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
  **Wöchentliche Zusammenfassung** (cron timers).
- **Import / Export** — share or back up a workflow as a single `.json` file.
- **Safe unattended** — every unattended entry point (workflow agent node, tool node, cron
  trigger, **and delegated sub-agents**) shares ONE screen: no dangerous shell (`rm -rf`,
  `format`, fork-bombs, `git push -f`), no MCP / Claude Code / sub-agent delegation, no outward
  `git push` / `gh pr create` — whether issued as a structured call or a raw shell command.
  Loops, step counts and a hard wall-clock ceiling bound every run.

It's your KI-coding app and a `/goal` automation tool in one — like n8n, only simpler and clearer.

**👁 Live preview pane** — a side panel next to the chat that renders the project you're building
(static `index.html` or a dev-server URL, auto-detected) in an isolated webview, like Claude Code's preview.

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
test/             vitest unit tests for the pure logic (pricing, danger heuristic,
                  cron matcher, context-window map, message elision, line-diff)
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
