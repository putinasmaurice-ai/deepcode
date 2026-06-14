// Approval policies + the dangerous-command heuristic.

// 'interactive' = ask the user; 'safe' = deny anything not pre-approved (headless);
// 'full' = auto-approve everything; 'plan' = read-only — write/shell tools are
// refused so the agent investigates and proposes instead of changing anything.
export type ApprovalPolicy = 'interactive' | 'safe' | 'full' | 'plan'

// Commands that can be catastrophic — always require explicit approval, even when
// shell auto-approve is on. Heuristic, intentionally conservative.
const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?\b/i,
  /\brm\s+-rf?\s+[/~]/i,
  /\b(mkfs(\.\w+)?|fdisk)\b/i, // disk tooling
  // disk FORMAT only in its destructive form — a drive letter (`format C:`), a flag
  // (`format /q`), the .exe/.com form, a quoted drive, or a \\?\ volume device path.
  // NOT the bare word, so build tooling like `dotnet format`, `clang-format`,
  // `npm run format`, `git format-patch` is not falsely blocked.
  /\bformat(\.exe|\.com)?\s+["']?([A-Za-z]:|\/[A-Za-z]|\\\\[?.]\\)/i,
  // canonical destructive Windows/PowerShell disk cmdlets (token form, no drive arg)
  /\b(Format-Volume|Clear-Disk|Initialize-Disk)\b/i,
  /\bdd\s+if=/i,
  /\b(Remove-Item|rmdir)\b.*-Recurse\b/i,
  /:\(\)\s*\{.*\}\s*;/, // fork bomb (no leading \b — ':' is non-word, would never match at line start)
  />\s*\/dev\/sd[a-z]/i,
  // force-push in any flag form: --force, --force-with-lease, and the SHORT flag -f
  // (incl. bundled forms like -uf / -fv). `\s-[a-z]*f` = a flag group containing 'f'.
  /\bgit\s+push\b.*(--force|--force-with-lease|\s-[a-z]*f)/i
]

export function isDangerousCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  return DANGER_PATTERNS.some((re) => re.test(cmd))
}

// Outward source-control operations that publish to a remote — never allowed unattended
// (no user to approve a push/PR). Mirrors the structured `git` tool's push/pr block for the
// case where the same action is issued through the generic shell (run_command).
export function isOutwardScmCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  return /\bgit\s+push\b/i.test(cmd) || /\bgh\s+pr\s+create\b/i.test(cmd) || /\bhub\s+pull-request\b/i.test(cmd)
}

// Single screen for work that runs with NO user present (workflow agent nodes, cron
// automations, delegated subagents). Returns a German block reason, or null to allow.
// Used by BOTH the engine's gateToolCall and the subagent loop so the invariant — no
// dangerous shell, no MCP/claude_code/task, no outward git — can't drift between them.
export function screenUnattendedCall(name: string, parsedArgs: unknown): string | null {
  const a = (parsedArgs ?? {}) as Record<string, unknown>
  if (name.startsWith('mcp__') || name === 'claude_code' || name === 'task') {
    return `Blocked: „${name}" darf unbeaufsichtigt nicht ohne Freigabe laufen.`
  }
  // preview_probe drives the live preview webview (screenshot/click/type) — meaningless and
  // unsafe with no user/preview present (cron/workflow-agent/subagent runs).
  if (name === 'preview_probe') {
    return 'Blocked: „preview_probe" braucht die offene Live-Vorschau und läuft nicht unbeaufsichtigt.'
  }
  // web_request issues arbitrary outbound HTTP (POST/headers/body) — a perfect exfiltration
  // channel unattended (no user to vet the destination), so it's blocked like MCP/task above.
  if (name === 'web_request') {
    return 'Blocked: „web_request" darf unbeaufsichtigt nicht ohne Freigabe laufen.'
  }
  // run_workflow re-enters the workflow engine as a FRESH top-level run (depth 0, new ancestors,
  // new fan-out counter), so an unattended workflow agent node calling it would bypass every
  // recursion guard (cycle/depth/child-run cap) and recurse without bound. The capability is also
  // gated off in engine.ts, but block it here too so the invariant holds at the shared gate used
  // by the engine, the subagent loop AND the workflow tool-node runner — and can't drift.
  if (name === 'run_workflow') {
    return 'Blocked: „run_workflow" darf unbeaufsichtigt nicht laufen.'
  }
  if (name === 'git' && /^(push|pr)$/i.test(String(a.action ?? ''))) {
    return 'Blocked: git push/pr ist unbeaufsichtigt nicht erlaubt.'
  }
  const cmd = name === 'run_command' || name === 'run_background_command' ? a.command : undefined
  if (isDangerousCommand(cmd)) {
    return `Blocked: „${name}" wurde als gefährlicher Befehl eingestuft und darf unbeaufsichtigt nicht laufen.`
  }
  if (isOutwardScmCommand(cmd)) {
    return 'Blocked: „git push" / „gh pr create" über die Shell ist unbeaufsichtigt nicht erlaubt.'
  }
  return null
}
