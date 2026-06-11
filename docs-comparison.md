# DeepCode vs Claude Code vs Codex — Vergleich

| Feature | Claude Code | Codex | DeepCode |
|---|---|---|---|
| **Core agent** | | | |
| Agentic tool loop (read/write/shell) | ✅ | ✅ | ✅ |
| Plan mode (propose before execute) | ✅ | 🟡 | ✅ |
| Todo / task list tracking | ✅ | ✅ | ✅ |
| Subagents (delegated restricted agents) | ✅ | ❌ | ✅ |
| Skills system | ✅ | 🟡 | ✅ |
| Hooks (lifecycle events) | ✅ | ❌ | ✅ |
| Plugins (local) | ✅ | ❌ | ✅ |
| MCP support | ✅ | ✅ | ✅ |
| Custom slash commands | ✅ | 🟡 | ✅ |
| Built-in commands (/cost /model /compact) | ✅ | 🟡 | ✅ |
| Project instruction files (CLAUDE.md/AGENTS.md) | ✅ | ✅ | ✅ |
| Global user-level instructions file | ✅ | ✅ | ✅ (~/.deepcode/DEEPCODE.md) |
| Persistent memory system | ✅ | 🟡 | ✅ |
| **Safety & control** | | | |
| Permission/approval modes | ✅ | ✅ | ✅ (Interaktiv/Plan/Auto + Trust) |
| Per-project trust levels | ✅ | ✅ | ✅ |
| Checkpoint / rewind | ✅ | ❌ | ✅ (/rewind) |
| Prominent approval dialog UX | ✅ | ✅ | 🟡 |
| Audit log | 🟡 | 🟡 | 🟡 (logged, no UI) |
| Secure API key storage | ✅ | ✅ | ✅ (safeStorage) |
| **Sessions & projects** | | | |
| Projects / workspaces (first-class) | ✅ | 🟡 | ✅ |
| Goals system (/goal, progress) | ✅ | ❌ | ✅ |
| Session resume / continue | ✅ | ✅ | ✅ (auto-resume) |
| Session compaction (manual + auto) | ✅ | ✅ | ✅ |
| Session export (MD/JSON) | ✅ | 🟡 | ✅ |
| Session rename / search / archive | ✅ | 🟡 | ✅ |
| Full-text history search | ✅ | 🟡 | ❌ |
| Cloud sync / handoff | ✅ | ✅ | ❌ |
| **Cost & models** | | | |
| Cost tracking per session | ✅ | ❌ | ✅ |
| Cost dashboard (per chat/project/total) | 🟡 | ❌ | ✅ |
| Cost budgeting / projections | ❌ | ❌ | ❌ (opportunity) |
| Context-window % indicator | ✅ | 🟡 | ✅ |
| Mid-session model switching | ✅ | ✅ | ✅ (/model in flight) |
| Cost-optimized prompt routing | 🟡 | ❌ | ❌ (opportunity) |
| Model A/B comparison | ❌ | ❌ | ❌ (opportunity) |
| Reasoning / thinking display | ✅ | 🟡 | ✅ |
| Retry / backoff on API errors | ✅ | ✅ | ✅ |
| **Execution & integrations** | | | |
| Web search / fetch | ✅ | ✅ | ✅ |
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
| @-file mentions with autocomplete | ✅ | ✅ | ✅ |
| Drag-drop / paste attachments | ✅ | ✅ | ✅ |
| Attachment preview | ✅ | 🟡 | 🟡 (chips only) |
| Syntax highlighting (code + diffs) | ✅ | ✅ | ❌ |
| Diff view | ✅ | ✅ | ✅ |
| Interactive diff approval (per-hunk) | ✅ | 🟡 | ❌ |
| Code-block / message copy buttons | ✅ | ✅ | ✅ |
| Regenerate / edit-and-resend | 🟡 | ✅ | 🟡 (regenerate ja, edit nein) |
| Continue after truncation | ✅ | ✅ | ✅ |
| Full markdown rendering (tables, links, quotes) | ✅ | ✅ | 🟡 (regex renderer, no links) |
| Keyboard shortcuts suite | ✅ | ✅ | ✅ |
| **App shell & polish** | | | |
| Design system / theming | ✅ | ✅ | ✅ (CSS upgrade in flight) |
| Light/dark mode toggle | ✅ | ✅ | ❌ (dark only) |
| Toasts / desktop notifications | ✅ | ✅ | 🟡 (static banner) |
| Onboarding / first-run flow | ✅ | ✅ | ❌ |
| Window state persistence | ✅ | ✅ | ✅ |
| Tray, app menu, About, auto-update | ✅ | ✅ | ❌ |
| Accessibility (WCAG AA) | 🟡 | 🟡 | ❌ |
| i18n / localization | ❌ | ❌ | ❌ (hardcoded German) |
