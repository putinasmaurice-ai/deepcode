import { WorkflowDef, WorkflowNode, WorkflowRun, AgentEvent } from '@shared/types'
import { validateWorkflow, hasBlockingErrors } from '@shared/workflows'
import { WorkflowDeps, runWorkflow } from './executor'
import { saveWorkflow } from './store'

// Self-healing: when a workflow node fails, hand the IN-PROCESS coder the failed node's config
// + error + (masked) input, let it patch the node config OR fix a referenced project file, then
// REPLAY from that node with the exact live input the node saw (run.healSeed). Bounded by
// maxAttempts and the daily spend cap. The repair agent runs through deps.runAgent — the same
// unattended-gated path as a workflow agent node (MCP/claude_code/task/git-push stay blocked).

const LAST_CAP = 4000
const VAR_CAP = 300

// Extract a node-config object from the agent's free-form answer: a ```json block first, then a
// bare {...}. Returns null when the agent fixed a file instead (no JSON) or output isn't an object.
export function parseConfigPatch(text: string): Record<string, unknown> | null {
  if (!text) return null
  const candidates: string[] = []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim())
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

// Build the repair prompt from STATIC structure + MASKED var values — a prior tool/shell node
// may have stuffed a secret into {{last}}; deps.mask redacts real secret values while leaving
// ordinary data (HTML, JSON) intact for the agent to grep.
export function buildRepairPrompt(
  node: WorkflowNode,
  errorMsg: string,
  vars: Record<string, string>,
  mask?: (s: string) => string
): string {
  const m = mask ?? ((s: string) => s)
  const cfg = JSON.stringify(node.config ?? {}, null, 2)
  // mask the error too: a failed http/tool node's LIVE error can echo an expanded secret
  // (e.g. a 401 body or a resolved {{secret.*}}), and the prompt is persisted on disk.
  const err = m(String(errorMsg || ''))
  const last = m(String(vars.last ?? '')).slice(0, LAST_CAP)
  const others = Object.entries(vars)
    .filter(([k]) => k !== 'last' && k !== 'input')
    .map(([k, v]) => `${k} = ${m(String(v)).slice(0, VAR_CAP)}`)
    .join('\n')
  return `Ein Knoten in einem Automatisierungs-Workflow ist fehlgeschlagen. Du bist der Coder dieses Projekts und sollst ihn reparieren.

Knoten-Typ: ${node.type}
Knoten-Label: ${node.label ?? node.id}
Aktuelle Konfiguration (mit {{Platzhaltern}}):
${cfg}

Fehlermeldung:
${err || '(keine)'}

Eingabe, die der Knoten sah ({{last}}, evtl. gekürzt/maskiert):
${last || '(LEER — die Eingabe war leer. Die Ursache liegt dann oft NICHT in diesem Knoten, sondern weiter oben: ein vorheriger Knoten lieferte nichts. Prüfe die Upstream-Quelle, bevor du nur diesen Knoten anpasst.)'}

Weitere Variablen:
${others || '(keine)'}

Prüfe mit deinen Tools (grep/read/edit) den echten Code bzw. die echten Daten im Projekt. Dann WÄHLE GENAU EINE Reparatur:
(A) Liegt der Fehler in der KNOTEN-KONFIGURATION (veralteter Selektor/Regex/Pfad/URL, falsches Feld), gib die KORRIGIERTE komplette Konfiguration als JSON in EINEM \`\`\`json … \`\`\`-Block zurück (gleiche Felder, nur fehlerhafte Werte korrigiert).
(B) Liegt der Fehler in einer PROJEKTDATEI, behebe ihn direkt mit deinen Edit-Tools und gib KEIN JSON zurück (antworte kurz, was du geändert hast).

Ändere nur das Nötigste. Gib niemals echte {{secret.*}}-Werte aus.`
}

export interface HealOptions {
  maxAttempts: number
  overCap: () => boolean // daily spend cap — heal must re-check before each attempt
  makeReplayDeps: (runId: string) => WorkflowDeps // fresh deps for each replay run
  newRunId: () => string
}

// Drive bounded heal+replay starting from an already-failed run. Returns the final run (healed
// or still failed). `agentDeps` supplies runAgent / mask / cwd / emit / signal for the repair step.
export async function healRun(
  def: WorkflowDef,
  failedRun: WorkflowRun,
  agentDeps: WorkflowDeps,
  opts: HealOptions
): Promise<WorkflowRun> {
  let run = failedRun
  let working = def
  let failedNodeId: string | undefined = failedRun.healSeed?.fromNodeId
  const emitHeal = (
    status: Extract<AgentEvent, { type: 'workflow_heal' }>['status'],
    nodeId?: string,
    message?: string
  ): void => agentDeps.emit({ type: 'workflow_heal', workflowId: def.id, runId: run.id, status, nodeId, message })

  for (let attempt = 0; attempt < Math.max(1, opts.maxAttempts); attempt++) {
    if (run.status !== 'failed' || !run.healSeed) break
    if (agentDeps.signal.aborted) break
    const seed = run.healSeed
    failedNodeId = seed.fromNodeId
    const node = (Array.isArray(working.nodes) ? working.nodes : []).find((n) => n.id === seed.fromNodeId)
    if (!node) break
    if (opts.overCap()) {
      emitHeal('failed', node.id, 'Tagesbudget erreicht — Selbstheilung übersprungen.')
      break
    }

    emitHeal('start', node.id, `Repariere Knoten „${node.label || node.id}"…`)
    emitHeal('agent', node.id)
    let answer = ''
    try {
      answer = await agentDeps.runAgent(buildRepairPrompt(node, run.error || '', seed.vars, agentDeps.mask), agentDeps.cwd)
    } catch (e) {
      emitHeal('failed', node.id, `Reparatur-Agent fehlgeschlagen: ${(e as Error).message}`)
      break
    }

    // (A) a returned config patch → validate the candidate def, persist only if it stays valid.
    const patch = parseConfigPatch(answer)
    if (patch) {
      const candidate: WorkflowDef = {
        ...working,
        nodes: working.nodes.map((n) => (n.id === node.id ? { ...n, config: patch } : n))
      }
      if (!hasBlockingErrors(validateWorkflow(candidate))) {
        working = candidate
        try {
          saveWorkflow(working)
        } catch {
          /* a persist failure must not abort the replay attempt */
        }
        emitHeal('patched', node.id, 'Knoten-Konfiguration angepasst.')
      } else {
        emitHeal('patched', node.id, 'Vorgeschlagene Konfiguration war ungültig — versuche Replay mit etwaigem Datei-Fix.')
      }
    }

    // re-check the daily cap right before the replay too: a single replay (agent nodes /
    // sub-workflows) can spend on its own, so the once-per-attempt agent check isn't enough.
    if (opts.overCap()) {
      emitHeal('failed', node.id, 'Tagesbudget erreicht — Replay übersprungen.')
      break
    }
    // replay from the failed node with the exact live input snapshot + upstream outputs
    emitHeal('replay', node.id, 'Wiederhole ab dem Knoten…')
    const replayId = opts.newRunId()
    run = await runWorkflow(working, opts.makeReplayDeps(replayId), {
      fromNodeId: seed.fromNodeId,
      vars: seed.vars,
      seedOutputs: seed.seedOutputs,
      runId: replayId
    })
    if (run.status !== 'failed') break
  }

  // status-accurate terminal event: only a genuinely completed run is 'healed'; a cancelled
  // replay (deadline/Stop) must not read as a successful repair. A green run whose previously
  // failed node now produced EMPTY output is flagged — it may be a vacuous fix over no data.
  if (run.status === 'done') {
    const fixed = failedNodeId ? run.nodes.find((n) => n.nodeId === failedNodeId) : undefined
    const vacuous = fixed && !(fixed.output && fixed.output.trim())
    emitHeal('healed', failedNodeId, vacuous ? 'Repariert — aber die Ausgabe ist leer. Bitte prüfen.' : 'Workflow repariert ✅')
  } else if (run.status === 'cancelled') {
    emitHeal('failed', failedNodeId, 'Reparatur abgebrochen.')
  } else {
    emitHeal('failed', failedNodeId, 'Selbstheilung erschöpft — bitte manuell prüfen.')
  }
  return run
}
