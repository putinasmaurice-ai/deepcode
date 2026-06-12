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
  /\b(format|mkfs|fdisk)\b/i,
  /\bdd\s+if=/i,
  /\b(Remove-Item|rmdir)\b.*\b-Recurse\b/i,
  /\b:\(\)\s*\{.*\}\s*;/, // fork bomb
  />\s*\/dev\/sd[a-z]/i,
  /\bgit\s+push\b.*--force/i
]

export function isDangerousCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  return DANGER_PATTERNS.some((re) => re.test(cmd))
}
