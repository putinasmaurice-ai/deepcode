# DeepCode vs Claude Code vs Codex — Vergleich

| Feature | Claude Code | Codex | DeepCode |
|---|---|---|---|
| **Core agent** | | | |
| Agentic tool loop (read/write/shell) | ✅ | ✅ | ✅ |
| Plan mode (propose before execute) | ✅ | 🟡 | ❌ |
| Todo / task list tracking | ✅ | ✅ | ❌ |
| Subagents (delegated restricted agents) | ✅ | ❌ | ✅ |
| Skills system | ✅ | 🟡 | ✅ |
| Hooks (lifecycle events) | ✅ | ❌ | ✅ |
| Plugins (local) | ✅ | ❌ | ✅ |
| MCP support | ✅ | ✅ | ✅ |
| Custom slash commands | ✅ | 🟡 | ✅ |
| Built-in commands (/cost /model /compact) | ✅ | 🟡 | ✅ (in flight) |
| Project instruction files (CLAUDE.md/AGENTS.md) | ✅ | ✅ | ✅ |
| Global user-level instructions file | ✅ | ✅ | 🟡 |
| Persistent memory system | ✅ | 🟡 | ✅ |
| **Safety & control** | | | |
| Permission/approval modes | ✅ | ✅ | 🟡 (global only) |
| Per-project trust levels | ✅ | ✅ | ❌ |
| Checkpoint / rewind | ✅ | ❌ | ❌ |
| Prominent approval dialog UX | ✅ | ✅ | 🟡 |
| Audit log | 🟡 | 🟡 | 🟡 (logged, no UI) |
| Secure API key storage | ✅ | ✅ | ✅ (safeStorage) |
| **Sessions & projects** | | | |
| Projects / workspaces (first-class) | ✅ | 🟡 | ✅ (in flight) |
| Goals system (/goal, progress) | ✅ | ❌ | ✅ (in flight) |
| Session resume / continue | ✅ | ✅ | 🟡 |
| Session compaction (manual + auto) | ✅ | ✅ | ✅ |
| Session export (MD/JSON) | ✅ | 🟡 | ✅ (in flight) |
| Session rename / search / archive | ✅ | 🟡 | ❌ (rename API unwired) |
| Full-text history search | ✅ | 🟡 | ❌ |
| Cloud sync / handoff | ✅ | ✅ | ❌ |
| **Cost & models** | | | |
| Cost tracking per session | ✅ | ❌ | ✅ |
| Cost dashboard (per chat/project/total) | 🟡 | ❌ | ✅ (in flight) |
| Cost budgeting / projections | ❌ | ❌ | ❌ (opportunity) |
| Context-window % indicator | ✅ | 🟡 | ❌ |
| Mid-session model switching | ✅ | ✅ | ✅ (/model in flight) |
| Cost-optimized prompt routing | 🟡 | ❌ | ❌ (opportunity) |
| Model A/B comparison | ❌ | ❌ | ❌ (opportunity) |
| Reasoning / thinking display | ✅ | 🟡 | ✅ |
| Retry / backoff on API errors | ✅ | ✅ | 🟡 (pre-stream only) |
| **Execution & integrations** | | | |
| Web search / fetch | ✅ | ✅ | ❌ |
| Image / vision input | ✅ | ✅ | ❌ (provider blocked) |
| Background shell tasks | ✅ | 🟡 | ❌ |
| Parallel tasks / worktree isolation | ✅ | ✅ | ❌ |
| Queued messages mid-turn | ✅ | ✅ | ❌ |
| Scheduled automations (cron) | 🟡 | ❌ | ✅ |
| Trigger-based automations | 🟡 | ❌ | ❌ |
| Git scaffolding (branch/commit/PR) | ✅ | ✅ | 🟡 (branch topbar in flight) |
| Embedded browser / computer use | ✅ | 🟡 | ❌ |
| Voice input | 🟡 | ❌ | ❌ |
| Marketplace (plugins/skills/MCP discovery) | ✅ | ❌ | ❌ |
| **Chat & editor UX** | | | |
| @-file mentions with autocomplete | ✅ | ✅ | ❌ |
| Drag-drop / paste attachments | ✅ | ✅ | ❌ (buttons only) |
| Attachment preview | ✅ | 🟡 | 🟡 (chips only) |
| Syntax highlighting (code + diffs) | ✅ | ✅ | ❌ |
| Diff view | ✅ | ✅ | 🟡 (plain unified) |
| Interactive diff approval (per-hunk) | ✅ | 🟡 | ❌ |
| Code-block / message copy buttons | ✅ | ✅ | ❌ |
| Regenerate / edit-and-resend | 🟡 | ✅ | ❌ |
| Continue after truncation | ✅ | ✅ | ✅ (in flight) |
| Full markdown rendering (tables, links, quotes) | ✅ | ✅ | 🟡 (regex renderer, no links) |
| Keyboard shortcuts suite | ✅ | ✅ | 🟡 (Ctrl+N in flight) |
| **App shell & polish** | | | |
| Design system / theming | ✅ | ✅ | ✅ (CSS upgrade in flight) |
| Light/dark mode toggle | ✅ | ✅ | ❌ (dark only) |
| Toasts / desktop notifications | ✅ | ✅ | 🟡 (static banner) |
| Onboarding / first-run flow | ✅ | ✅ | ❌ |
| Window state persistence | ✅ | ✅ | ❌ |
| Tray, app menu, About, auto-update | ✅ | ✅ | ❌ |
| Accessibility (WCAG AA) | 🟡 | 🟡 | ❌ |
| i18n / localization | ❌ | ❌ | ❌ (hardcoded German) |
