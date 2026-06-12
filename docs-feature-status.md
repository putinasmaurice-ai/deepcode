## Feature-Inventar (dedupliziert)

### Agent-Core
| Feature | Status | Note |
|---|---|---|
| Turn-Loop | ✅ | engine.runTurn mit Session-Locking, 60-Step-Limit, Quality-Loop (review→verify), sauberes Signal-Handling |
| read_file | ✅ | offset+limit (1-based), 2MB-Check, Zeilennummern |
| write_file | ✅ | Diff via lineDiff(), Snapshot vor Write, mkdir-p |
| edit_file | ✅ | Exact-Match mit Uniqueness-Check, replace_all, gute Fehlermeldungen |
| apply_patch | ✅ | Atomar: validate→snapshot→apply→rollback, all-or-nothing |
| glob | ✅ | **, *, ?, {a,b}, Standard-Ignores, 500-Datei-Limit |
| grep | 🟡 | Funktioniert, aber keine Context-Lines (-A/-B/-C) — erzwingt read_file-Roundtrips (fs.ts:296-350, verifiziert) |
| list_dir | ✅ | Sortiert, Verzeichnisse markiert, bewusst nicht-rekursiv |
| run_command | ✅ | bash/PowerShell, 120s-Timeout, 200KB-Cap, Exit-Code-Unterscheidung |
| web_fetch | ✅ | HTML→Text, 20-80KB, 30s-Timeout, Redirects (Doppeleintrag im Inventar zusammengeführt) |
| run_background_command | ✅ | Job-ID sofort, 10-Job-Cap, nicht-blockierend |
| job_status | 🟡 | Nur Tail (4000 Zeichen), kein inkrementelles/strukturiertes Log-Streaming |
| kill_job | ✅ | Prozessbaum-Teardown via taskkill, Sync-Fallback beim Shutdown |
| todo_write | ✅ | Live-Taskliste open/doing/done, UI rendert live |
| use_skill | ✅ | Lädt volle Skill-Instruktionen, Prompt-Liste auf 90 Zeichen gekürzt |
| task (Subagent) | ✅ | Eigener System-Prompt, Tool-Filterung, 60-Step-Loop, keine Rekursion |
| Approval-Gates | ✅ | 3 Policies, isDangerousCommand-Heuristik (rm -rf, dd, force-push) |
| Plan-Mode | ✅ | Mutierende Tools an gateToolCall blockiert, klare Refusal-Meldung |
| Trust-Level | ✅ | Pro-Projekt trusted/restricted, korrekt auf Policy angewendet |
| Checkpoints+ | ✅ | Per-Turn-Snapshots unter ~/.deepcode/checkpoints/, recordSnapshot vor jedem Write |
| Rewind | 🟡 | Nur Undo des letzten Turns; keine Liste/Auswahl historischer Checkpoints |
| Verify-Loop | ✅ | verifyCommand, 3min-Cap, max 2 Fix-Versuche, in Quality-Loop integriert |
| Self-Review | ✅ | Reviewt geänderte Dateien einmal pro Turn |
| Error-Memory | ✅ | Fehler→Fix-Paare (max 30) als Memory, in alle Prompts injiziert |
| Background-Jobs | 🟡 | Spawn/Poll/Kill ok; kein Live-Streaming, keine Timestamps (überschneidet mit job_status) |
| Tool Descriptions | 🟡 | Meist klar; grep-Limitierung und task-Permission-Modell unerwähnt |
| Prompt Quality | ✅ | Klare Sektionen, Skill-Liste gegen Bloat gekürzt |
| Subagent Isolation | ✅ | Tool-Subset, includeTask=false, signal-respektierend |
| Token Diet (api-messages) | ✅ | RECENT_TOOL_TURNS=3, ältere Tool-Outputs auf 220-Zeichen-Stub |

### Extensions
| Feature | Status | Note |
|---|---|---|
| Skills (124) | ✅ | User/Projekt/Plugin-Loading, sauberes Frontmatter-Parsing |
| Slash-Commands (+arg-hints) | 🟡 | Funktional, aber keine Parameter-Hints im UI (zwei Inventar-Zeilen zusammengeführt) |
| Subagent-Definitionen | ✅ | Tool-Filterung + Model-Override korrekt geparst |
| Hooks | 🔴 | SessionStart in types.ts:265 deklariert, wird aber NIE gefeuert (verifiziert: nur UserPromptSubmit/Pre/PostToolUse/Stop in engine.ts) |
| Plugins (21) | ✅ | Loading/Merging korrekt, Plugin-MCPs default disabled |
| MCP-Manager + Marketplace | 🟡 | Kein Reconnect-Retry bei stdio-Failures; Katalog-Eintrag fetch ist entgegen der Analyse KORREKT (uvx mcp-server-fetch, verifiziert) |
| Memory-System | 🟡 | description in saveMemory() (memory.ts:61) und distill.ts:55 unquoted → YAML-Parse-Risiko (verifiziert); kein Edit-UI |
| Skill-Matching | 🟡 | 90-Zeichen-Truncation kann Nuance kosten; voller Body wird bei use_skill geladen |

### Sessions & Kosten
| Feature | Status | Note |
|---|---|---|
| Sessions (Cache, atomare Writes) | ✅ | tmp+rename, Cache-Konsistenz, kein Orphaning durch Code-Struktur |
| Projekte | 🟡 | Schema vollständig; deleteProject() löscht zugehörige Sessions NICHT (projects.ts:35, verifiziert) |
| Kompaktierung | ✅ | Ältere Turns summarisiert, ~6 verbatim, Tool-Paare nie getrennt |
| Tool-Elision | ✅ | RECENT_TOOL_TURNS=3 / 30k-Cap, ältere Results als Stub |
| Kosten-Dashboard + /cost + Budget | 🟡 | Berechnung korrekt, aber UsagePanel lädt nur einmal on-mount → stale (verifiziert) |
| Export (Markdown) | 🟡 | Nur eine Markdown-Variante; session.todos fehlen im Export |
| Verlaufs-Suche | ✅ | Case-insensitive Substring, 3-Zeichen-Minimum, nach Recency sortiert |
| Audit-Log | ✅ | Filter nach kind+detail, 200-Einträge-Cap |
| Nachtschicht | 🟡 | Queue+Report funktionieren; Report nur als Pfad-String, kein Open-Button |

### Models
| Feature | Status | Note |
|---|---|---|
| DeepSeek-Client | 🟡 | Streaming+Retry robust; Reasoner-Erkennung via /reason/i zu brittle (qwq/o1 unerkannt) |
| Local-Routing (Ollama/LM Studio) | 🟡 | local:-Präfix ok, aber kein per-Modell num_ctx |
| Modell-Picker | ✅ | model + reasonerModel + local:, Wechsel pro Session |
| Arena+Voting→Memory | 🟡 | Votes persistent, aber votedArena nur im RAM → Re-Voting nach Reload |
| Zweitmeinung | 🟡 | Nutzt reasonerModel auch wenn identisch mit model; kein Feedback während Backoff |
| /learn-Destillation | 🟡 | Funktioniert, aber Slug-Kollision überschreibt stillschweigend (distill.ts:50-57, verifiziert) |
| Preis-/Kostenrechnung | 🟡 | Keine separaten Reasoner-Preise (oft 2-3x teurer), keine Preis-Validierung; local korrekt kostenlos |

### UI/UX
| Feature | Status | Note |
|---|---|---|
| Chat-Rendering | ✅ | Markdown/Highlight/Diff/Tables, Copy-Buttons, sichere minimale Markdown-Surface |
| Composer | 🟡 | Kern ok; Keyboard-Nav-Konflikt Slash-Menü vs @-Mentions (beide Arrow/Tab), Drag-Zone nur .composer |
| Sidebar | ✅ | Gruppierung, Suche ab 3 Zeichen, Inline-Rename |
| Topbar | 🟡 | Überfüllt bei schmalen Breiten, Mode-Konsequenzen unklar |
| Toasts + Actions | ✅ | Auto-Dismiss 4-12s, klare Error/Info-Trennung |
| Shortcuts | 🟡 | Kernshortcuts ok; Tab-Konflikt im Composer |
| Themes (Dark/Light) | ✅ | CSS-Variablen decken alle States ab |
| FirstRunModal | 🔴 | "Später" nicht persistiert (App.tsx:92 useState, verifiziert) → nervt Local-only-Nutzer bei jedem Start |
| TodoStrip & VoteBar | ✅ | Fortschritt klar, Arena-Voting funktional |
| Scroll FAB | ✅ | Korrektes Appear/Dismiss |
| Copy Feedback | 🔴 | Code-Copy zeigt ✓, Message-Copy stumm — inkonsistent |
| Reasoning Auto-Open | 🟡 | Startet collapsed (gut), kein Auto-Open nach Finish |
| Accessibility | 🔴 | Fehlende ARIA-Labels, Copy-Buttons opacity-0 bis Hover |

### Distribution
| Feature | Status | Note |
|---|---|---|
| Auto-Updater | ✅ | Silent Check + Settings-Button; keine Release-Notes in-app |
| Installer/NSIS | ✅ | oneClick=false, Shortcuts, Startmenü |
| PUBLISH.bat | 🟡 | End-to-end ok; kein Auto-Version-Bump, keine Tag-Kollisionsprüfung |
| START_DEEPCODE.bat | 🟡 | Zuverlässig, aber rebuildet immer (~40s) statt frisches out/ zu nutzen |
| E2E Smoke Mode | ✅ | Headless Turn mit Tool/Token/Cost-Checks, CI-tauglich |
| Screenshot Tour | 🟡 | 8 Views x 2 Themes; scheitert an FirstRunModal ohne API-Key |
| Config Importer | ✅ | Idempotente Migration aus ~/.claude und ~/.codex, MCPs default disabled |
| Icon Generation | ✅ | Multi-Size .ico + PNG via sharp |
| Seed Content | ✅ | writeIfMissing, Beispiel-Skill/Commands/Hooks/MCP |
| README | 🟡 | Kern abgedeckt; Distro-Tooling (bat-Scripts, import-config, e2e) undokumentiert |