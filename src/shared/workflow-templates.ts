import { WorkflowDef, WorkflowNode, WorkflowEdge } from './types'

// Curated, ready-to-run starter workflows. Each is SELF-CONTAINED (no sub-workflow refs) so it
// runs immediately from the Workflows panel or `/wf <Name> [Eingabe]` — the typed text arrives
// as {{input}}. Pure/dependency-free (shared by renderer + a validation test). Instantiating a
// template mints a FRESH id so the original is never mutated.

export interface WorkflowTemplate {
  key: string
  name: string
  description: string
  category: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

interface NodeSpec {
  id: string
  type: WorkflowNode['type']
  label?: string
  config: Record<string, unknown>
}

// Straight top-to-bottom chain: lays nodes out vertically and wires each to the next.
function chain(specs: NodeSpec[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNode[] = specs.map((s, i) => ({
    id: s.id,
    type: s.type,
    label: s.label,
    config: s.config,
    x: 250,
    y: 60 + i * 120
  }))
  const edges: WorkflowEdge[] = []
  for (let i = 0; i < specs.length - 1; i++) {
    edges.push({ id: `e_${specs[i].id}_${specs[i + 1].id}`, source: specs[i].id, target: specs[i + 1].id })
  }
  return { nodes, edges }
}

function tpl(key: string, name: string, description: string, category: string, specs: NodeSpec[]): WorkflowTemplate {
  return { key, name, description, category, ...chain(specs) }
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  tpl(
    'code-review',
    'Code-Review',
    'Prüft Code unter dem angegebenen Pfad ({{input}}) auf Bugs und Verbesserungen.',
    'Code',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      {
        id: 'review',
        type: 'agent',
        label: 'Review',
        config: {
          prompt:
            'Review den Code unter dem Pfad „{{input}}" (Datei oder Verzeichnis; falls leer: das gesamte Projektverzeichnis). ' +
            'Lies zuerst die relevanten Dateien. Liste konkrete Befunde mit Datei:Zeile — Bugs, riskante Muster, ' +
            'Verbesserungen. Sei knapp und präzise.'
        }
      },
      { id: 'out', type: 'output', label: 'Ergebnis', config: { template: '{{last}}' } }
    ]
  ),
  tpl(
    'run-tests',
    'Tests ausführen & zusammenfassen',
    'Führt `npm test` aus und fasst Bestanden/Fehlgeschlagen verständlich zusammen.',
    'Code',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      // continueOnError: a failing suite (non-zero exit) must still flow to the summary step
      { id: 'tests', type: 'shell', label: 'npm test', config: { command: 'npm test', continueOnError: true } },
      {
        id: 'summary',
        type: 'agent',
        label: 'Zusammenfassen',
        config: {
          prompt:
            'Fasse diese Test-Ausgabe zusammen: Anzahl bestanden/fehlgeschlagen und jeder Fehlschlag mit Grund.\n\n{{last}}'
        }
      },
      { id: 'out', type: 'output', label: 'Ergebnis', config: { template: '{{last}}' } }
    ]
  ),
  tpl(
    'summarize-url',
    'URL zusammenfassen',
    'Holt eine Webseite ({{input}} = URL) und fasst sie in Stichpunkten zusammen.',
    'Web',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      // continueOnError: a blocked/404/unreachable URL (web_fetch returns ok:false) should flow
      // its error text to the summary step, not abort the whole run.
      { id: 'fetch', type: 'http', label: 'Seite holen', config: { url: '{{input}}', continueOnError: true } },
      {
        id: 'summary',
        type: 'agent',
        label: 'Zusammenfassen',
        config: { prompt: 'Fasse den folgenden Webseiten-Inhalt in 5 prägnanten Stichpunkten zusammen:\n\n{{last}}' }
      },
      { id: 'notify', type: 'notify', label: 'Benachrichtigen', config: { title: 'Zusammenfassung', message: '{{last}}' } }
    ]
  ),
  tpl(
    'git-changelog',
    'Changelog aus Git',
    'Wandelt die letzten Commits in ein sauberes, gruppiertes Changelog (Markdown) um.',
    'Code',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      { id: 'log', type: 'shell', label: 'git log', config: { command: 'git log --oneline -30', continueOnError: true } },
      {
        id: 'changelog',
        type: 'agent',
        label: 'Changelog',
        config: {
          prompt:
            'Wandle diese Git-Commits in ein sauberes, gruppiertes Changelog in Markdown um (Features / Fixes / Sonstiges):\n\n{{last}}'
        }
      },
      { id: 'out', type: 'output', label: 'Ergebnis', config: { template: '{{last}}' } }
    ]
  ),
  tpl(
    'project-overview',
    'Projekt-Überblick',
    'Erkundet das Projekt (Struktur, Stack, Einstiegspunkte, Build/Test) und schreibt einen Überblick.',
    'Code',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      {
        id: 'explore',
        type: 'agent',
        label: 'Erkunden',
        config: {
          prompt:
            'Erkunde dieses Projekt: Verzeichnisstruktur, Tech-Stack, Einstiegspunkte, Schlüsselmodule sowie Build-/Test-Befehle. ' +
            'Schreibe danach einen knappen, gut strukturierten Überblick.'
        }
      },
      { id: 'out', type: 'output', label: 'Ergebnis', config: { template: '{{last}}' } }
    ]
  ),
  tpl(
    'daily-dep-check',
    'Täglicher Dependency-Check',
    'Läuft per Cron (09:00), prüft veraltete npm-Pakete und meldet sichere vs. riskante Updates.',
    'Automatisierung',
    [
      { id: 'trigger', type: 'trigger', label: 'Täglich 09:00', config: { mode: 'cron', cron: '0 9 * * *' } },
      // npm outdated exits non-zero when packages are outdated → continueOnError is essential
      { id: 'outdated', type: 'shell', label: 'npm outdated', config: { command: 'npm outdated', continueOnError: true } },
      {
        id: 'assess',
        type: 'agent',
        label: 'Bewerten',
        config: {
          prompt:
            'Das sind veraltete npm-Abhängigkeiten. Fasse zusammen, welche sichere Minor/Patch-Updates sind und welche riskante Majors:\n\n{{last}}'
        }
      },
      { id: 'notify', type: 'notify', label: 'Benachrichtigen', config: { title: 'Dependency-Check', message: '{{last}}' } }
    ]
  ),
  tpl(
    'telegram-nachricht',
    'Telegram-Nachricht senden',
    'Schickt {{input}} an deinen Telegram-Bot. Secrets nötig: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (Settings → Secrets).',
    'Benachrichtigung',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      {
        id: 'send',
        type: 'http',
        label: 'Telegram sendMessage',
        config: {
          url: 'https://api.telegram.org/bot{{secret.TELEGRAM_BOT_TOKEN}}/sendMessage',
          method: 'POST',
          headers: '{"Content-Type":"application/json"}',
          body: '{"chat_id":"{{secret.TELEGRAM_CHAT_ID}}","text":"{{input}}"}'
        }
      },
      { id: 'out', type: 'output', label: 'Ergebnis', config: { template: '{{last}}' } }
    ]
  ),
  tpl(
    'webhook-senden',
    'Webhook senden (POST)',
    'POSTet {{input}} als JSON an einen Webhook. Trage die Ziel-URL im HTTP-Knoten ein (oder nutze {{secret.WEBHOOK_URL}}).',
    'Benachrichtigung',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      {
        id: 'post',
        type: 'http',
        label: 'Webhook POST',
        config: {
          url: 'https://example.com/webhook',
          method: 'POST',
          headers: '{"Content-Type":"application/json"}',
          body: '{"text":"{{input}}"}'
        }
      },
      { id: 'out', type: 'output', label: 'Ergebnis', config: { template: '{{last}}' } }
    ]
  ),
  tpl(
    'taeglicher-reminder',
    'Täglicher Reminder',
    'Läuft täglich um 09:00 und zeigt eine Desktop-Benachrichtigung. Cron im Trigger anpassbar.',
    'Timer',
    [
      { id: 'trigger', type: 'trigger', label: 'Täglich 09:00', config: { mode: 'cron', cron: '0 9 * * *' } },
      { id: 'notify', type: 'notify', label: 'Erinnern', config: { title: 'DeepCode Reminder', message: 'Dein täglicher Reminder ⏰' } }
    ]
  ),
  tpl(
    'woechentliche-zusammenfassung',
    'Wöchentliche Zusammenfassung',
    'Läuft montags 09:00: ein Agent erstellt eine kurze Wochen-Zusammenfassung und benachrichtigt dich.',
    'Timer',
    [
      { id: 'trigger', type: 'trigger', label: 'Mo 09:00', config: { mode: 'cron', cron: '0 9 * * 1' } },
      {
        id: 'summary',
        type: 'agent',
        label: 'Wochen-Report',
        config: {
          prompt:
            'Erstelle eine kurze, motivierende Wochen-Zusammenfassung für mich als Entwickler: was diese Woche anstehen könnte und ein konkreter Fokus-Tipp. Halte es knapp.'
        }
      },
      { id: 'notify', type: 'notify', label: 'Benachrichtigen', config: { title: 'Wochen-Report', message: '{{last}}' } }
    ]
  ),
  tpl(
    'multi-modell-vergleich',
    'Multi-Modell-Vergleich',
    'Stellt {{input}} an zwei Anbieter (Standard + OpenAI) und lässt ein drittes Modell vergleichen. Modelle/Keys pro Agent-Step anpassbar (Settings → OpenAI).',
    'KI',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      // model leer = Standard/Session-Modell (DeepSeek)
      { id: 'a', type: 'agent', label: 'Antwort A (Standard)', config: { prompt: '{{input}}', model: '', outputVar: 'antwortA' } },
      // per-node model override (Settings → OpenAI-Key setzen, oder Modell hier ändern)
      { id: 'b', type: 'agent', label: 'Antwort B (OpenAI)', config: { prompt: '{{input}}', model: 'openai:gpt-4o-mini', outputVar: 'antwortB' } },
      {
        id: 'judge',
        type: 'agent',
        label: 'Vergleich',
        config: {
          prompt:
            'Hier sind zwei KI-Antworten auf dieselbe Frage. Vergleiche sie kurz und sag, welche besser ist und warum:\n\n[A]\n{{antwortA}}\n\n[B]\n{{antwortB}}'
        }
      },
      { id: 'out', type: 'output', label: 'Ergebnis', config: { template: '{{last}}' } }
    ]
  ),
  tpl(
    'datei-aenderung-email',
    'Bei Datei-Änderung → E-Mail',
    'Überwacht src/ auf Änderungen und schickt dir bei jeder Änderung eine E-Mail mit der Dateiliste. SMTP-Daten im E-Mail-Knoten setzen, Passwort als Secret SMTP_PASS.',
    'Trigger',
    [
      { id: 'trigger', type: 'trigger', label: 'Datei-Watch (src)', config: { mode: 'filewatch', path: 'src', glob: '' } },
      {
        id: 'mail',
        type: 'email',
        label: 'E-Mail senden',
        config: {
          host: 'smtp.gmail.com',
          port: '465',
          secure: 'true',
          user: 'dein.name@gmail.com',
          pass: '{{secret.SMTP_PASS}}',
          from: 'dein.name@gmail.com',
          to: 'dein.name@gmail.com',
          subject: 'DeepCode: Dateien geändert',
          body: 'Geänderte Dateien:\n{{input}}'
        }
      }
    ]
  ),
  tpl(
    'projekt-report-email',
    'Projekt-Report per E-Mail',
    'Ein Agent fasst den aktuellen Projektstand zusammen und schickt ihn dir per E-Mail. Manuell oder als Cron. SMTP-Daten im E-Mail-Knoten setzen (Passwort als Secret SMTP_PASS).',
    'E-Mail',
    [
      { id: 'trigger', type: 'trigger', label: 'Start', config: { mode: 'manual' } },
      {
        id: 'report',
        type: 'agent',
        label: 'Report erstellen',
        config: {
          prompt:
            'Fasse den aktuellen Stand dieses Projekts in 5–8 Stichpunkten zusammen: Was wurde zuletzt gemacht, was steht offen, ein konkreter nächster Schritt. Knapp und klar.',
          outputVar: 'report'
        }
      },
      {
        id: 'mail',
        type: 'email',
        label: 'E-Mail senden',
        config: {
          host: 'smtp.gmail.com',
          port: '465',
          secure: 'true',
          user: 'dein.name@gmail.com',
          pass: '{{secret.SMTP_PASS}}',
          from: 'dein.name@gmail.com',
          to: 'dein.name@gmail.com',
          subject: 'DeepCode: Projekt-Report',
          body: '{{report}}'
        }
      },
      { id: 'out', type: 'output', label: 'Ergebnis', config: { template: '{{last}}' } }
    ]
  )
]

// Build a runnable WorkflowDef from a template, with a fresh id + timestamps. FULLY deep-copies
// the nodes/edges (incl. nested config objects/arrays) so editing the created workflow can never
// mutate the shared template constants — a shallow `{...n.config}` would share nested values.
export function instantiateTemplate(key: string, id: string, now: number): WorkflowDef | null {
  const t = WORKFLOW_TEMPLATES.find((x) => x.key === key)
  if (!t) return null
  const clone = <T>(v: T): T =>
    typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T)
  return {
    id,
    name: t.name,
    description: t.description,
    nodes: clone(t.nodes),
    edges: clone(t.edges),
    createdAt: now,
    updatedAt: now
  }
}
