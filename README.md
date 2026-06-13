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
| **Memory** | `~/.deepcode/memory/*.md` (+ `MEMORY.md` index) | Durable knowledge injected into every system prompt. |
| **Automation / Routine** | `~/.deepcode/automations.json` | Cron-scheduled prompts that run the agent headlessly. |
| **Slash Command** | `~/.deepcode/commands/<name>.md` | Prompt template triggered by typing `/name` in chat. |

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

Built-in slash commands: `/help /init /goal /cost /model /compact /rewind /jobs` + file-based custom commands.

**👁 Live preview pane** — a side panel next to the chat that renders the project you're building
(static `index.html` or a dev-server URL, auto-detected) in an isolated webview, like Claude Code's preview.

More: Projects (instructions + goal + trust level), cost dashboard (per chat/project/total),
@-file mentions, drag&drop attachments, edit-and-resend, regenerate, GitHub-flavored
markdown rendering with syntax highlighting, session export, desktop notifications.
Per-command **approval allowlist** ("Immer erlauben" — exact command, scoped to its project dir; managed in Settings).

**Keyboard:** `Ctrl+P` command palette (fuzzy: every view, action & recent chat) ·
`Ctrl+F` in-chat find · `Ctrl+N` new chat · `Ctrl+K` focus composer · `Esc` cancel turn ·
`Y`/`N`/`A` approve / deny / approve-all the pending tool call. The context pill is
model-aware (knows each model's real context window).

Local models: pick any Ollama/LM Studio model with the `local:` prefix (free, offline).
🔓 Uncensored toggle (local unaligned model) and 👁 image analysis — attach a screenshot
and a local vision model describes/analyzes it (auto-routed; DeepSeek text models can't see images).

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
