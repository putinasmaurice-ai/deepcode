import { Tool, ok, fail, ToolContext } from './types'
import { listSecretNames, isSecretNameValid } from '../../workflows/secrets'

// Tools that let the chat agent help set up a workflow's prerequisites: see WHICH secrets already
// exist, and securely CAPTURE a missing one. A secret value never passes through the LLM — the
// agent only asks for a secret by NAME; the value is typed by the user into a secure prompt and
// flows renderer→IPC→setSecret, never back into a tool arg, an event, the transcript, or a log.

const listSecretsTool: Tool = {
  name: 'list_secrets',
  description:
    'Liste die NAMEN aller gespeicherten Secrets (z. B. SMTP_PASS) — niemals deren Werte. Nutze dies, um zu prüfen, welche Voraussetzungen eines Workflows schon erfüllt sind und welche noch fehlen.',
  permission: 'read',
  parameters: { type: 'object', properties: {} },
  summarize: () => 'List secret names',
  async execute() {
    const names = listSecretNames()
    if (!names.length) return ok('Keine Secrets gespeichert.')
    return ok(names.join('\n'), { count: names.length })
  }
}

const requestSecretTool: Tool = {
  name: 'request_secret',
  description:
    'Fordere den Nutzer auf, ein fehlendes Secret SICHER einzugeben (es wird verschlüsselt gespeichert). Du übergibst NUR den Namen (A–Z, 0–9, _) und optional einen Grund — niemals den Wert selbst. Der Wert läuft nur Nutzer→sicherer Speicher und erscheint NIE in der Antwort, im Verlauf oder in einem Log.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name des Secrets, z. B. SMTP_PASS (A–Z, 0–9, _; max 64).' },
      reason: { type: 'string', description: 'Optionaler Grund, der dem Nutzer erklärt, wofür das Secret gebraucht wird.' }
    },
    required: ['name']
  },
  summarize: (a) => `Request secret ${a?.name ?? ''}`,
  async execute(args, ctx: ToolContext) {
    const name = typeof args?.name === 'string' ? args.name : ''
    if (!isSecretNameValid(name)) return fail('Ungültiger Secret-Name — erlaubt: A–Z, 0–9, _ (max 64).')
    if (!ctx.requestSecret) return fail('Sichere Secret-Eingabe ist hier nicht verfügbar (kein Nutzer anwesend).')
    const reason = typeof args?.reason === 'string' ? args.reason : undefined
    const r = await ctx.requestSecret(name, reason)
    if (r.set) return ok(`Secret ${name} wurde sicher gespeichert.`)
    // Distinguish a REJECTED value (too short / no OS encryption — r.error is a static constraint
    // message from setSecret, never the value) from a genuine cancel, so the agent can re-prompt
    // with the real reason instead of assuming the user declined.
    return ok(r.error ? `Secret ${name} NICHT gespeichert: ${r.error}` : `Eingabe für ${name} abgebrochen.`)
  }
}

export const secretTools: Tool[] = [listSecretsTool, requestSecretTool]
