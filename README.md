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

- `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep` — full file access
- `run_command` — shell (PowerShell on Windows) for builds, tests, git, package managers
- `task` — delegate to a subagent
- `use_skill` — load a skill's detailed instructions
- any tools exposed by connected MCP connectors

Tool calls are gated by per-category permissions (read / file-change / shell) that you can
auto-approve or approve inline per call.

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
```

## Notes

- DeepSeek's public API currently exposes `deepseek-chat` and `deepseek-reasoner`. The model
  id and base URL are configurable, so any compatible "v4 PRO" endpoint plugs in without code
  changes.
- Sessions, settings, and all extensions are stored under `~/.deepcode`.
