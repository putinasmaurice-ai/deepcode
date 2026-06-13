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
  /\bgit\s+push\b.*--force/i
]

export function isDangerousCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  return DANGER_PATTERNS.some((re) => re.test(cmd))
}
