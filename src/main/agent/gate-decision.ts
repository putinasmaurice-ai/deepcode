import { ApprovalPolicy } from './policy'

// The PURE tool-approval decision tree, lifted out of the engine so the intricate
// policy × danger × MCP × unattended × allowlist branching is unit-testable in isolation. The
// engine computes the side-effectful inputs (settings autoApprove, allowlist lookup, the
// unattended screen) and feeds them here; this returns ONLY the decision. Order is significant and
// mirrors the original engine logic exactly — changing it changes the security posture.

export interface GateInput {
  policy: ApprovalPolicy
  toolName: string
  mutating: boolean // tool.permission is 'write' | 'bash'
  dangerous: boolean // a catastrophic shell command (isDangerousCommand)
  isMcp: boolean // an mcp__* tool (irreversible remote action — never silent-auto)
  isCmd: boolean // run_command
  unattendedBlock: string | null // screenUnattendedCall result (null = allowed), only when unattended
  autoApproved: boolean // this.autoApproved(tool.permission)
  commandApproved: boolean // interactive-only allowlist hit for THIS command in THIS cwd
}

export type GateDecision =
  | { kind: 'deny'; reason: string } // refuse and tell the model why
  | { kind: 'allow' } // auto-approved (full / autoApprove bucket)
  | { kind: 'allowlist' } // a previously-blessed command — allow, but emit a status first
  | { kind: 'prompt' } // fall through to an interactive approval prompt

// Mirrors AgentEngine.gateToolCall's branching EXACTLY (same order, same messages).
export function gateDecision(i: GateInput): GateDecision {
  // 1. unattended: high-blast-radius tools are blocked outright (no user to approve)
  if (i.unattendedBlock) return { kind: 'deny', reason: i.unattendedBlock }
  // 2. plan mode never executes a mutating tool
  if (i.policy === 'plan' && i.mutating) {
    return { kind: 'deny', reason: `Plan mode: "${i.toolName}" was NOT executed. Describe this change as part of your plan instead.` }
  }
  // 3. a catastrophic shell command NEVER auto-runs outside interactive (full/safe/trusted/unattended)
  if (i.dangerous && i.policy !== 'interactive') {
    return {
      kind: 'deny',
      reason: `Blocked: „${i.toolName}" wurde als gefährlicher Befehl eingestuft und darf unbeaufsichtigt (Modus: ${i.policy}) nicht laufen. Wechsle in den Interaktiv-Modus, um ihn ausdrücklich zu bestätigen.`
    }
  }
  // 4. Auto (full) approves everything EXCEPT MCP (irreversible remote) — dangerous already handled
  if (i.policy === 'full' && !i.isMcp) return { kind: 'allow' }
  // 5. the per-permission auto-approve bucket — never for a dangerous cmd or an MCP tool
  if (i.autoApproved && !i.dangerous && !i.isMcp) return { kind: 'allow' }
  // 6. safe (unattended/restricted): deny anything not pre-approved above; the interactive allowlist
  //    must NOT punch through here
  if (i.policy === 'safe') return { kind: 'deny', reason: `Skipped "${i.toolName}" — not permitted in unattended (safe) mode.` }
  // 7. interactive: a command the user blessed before (this cwd, non-dangerous) runs without a prompt
  if (i.isCmd && !i.dangerous && i.commandApproved) return { kind: 'allowlist' }
  // 8. otherwise prompt the user
  return { kind: 'prompt' }
}
