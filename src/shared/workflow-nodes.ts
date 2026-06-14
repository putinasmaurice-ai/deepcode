// Single source of truth for the node-type + config reference shown to any agent that
// authors a workflow. Kept pure (no imports) so it can be embedded both in the workflow
// generator's SYSTEM prompt (src/main/workflows/generate.ts) and in the chat agent's
// create/update workflow tool descriptions. Copied VERBATIM from generate.ts's SYSTEM.

export const NODE_CATALOG = `Node types and their config:
- trigger  {"mode":"manual"} or {"mode":"cron","cron":"min hour dom mon dow"} — REQUIRED as the first node, exactly one.
- agent    {"prompt": string} — a full AI step WITH tools (read/write files, run commands). Use for anything needing reasoning or file/codebase work.
- shell    {"command": string, "continueOnError"?: true} — run one shell command. Set continueOnError when the command commonly exits non-zero (npm test, npm outdated, linters).
- http     {"url": string, "continueOnError"?: true} — fetch a URL (http/https only).
- transform{"mode":"template","template": string} | {"mode":"set","value": string} | {"mode":"extract","pattern": regex} — string templating / set a var / regex-extract.
- condition{"expression": string} — branch; its outgoing edges MUST use "sourceHandle":"true" and "sourceHandle":"false".
- switch   {"cases":"a,b,c"} — multi-branch; outgoing edges use "sourceHandle" per case plus one "sourceHandle":"default".
- delay    {"seconds": number}
- notify   {"title"?: string, "message"?: string} — desktop notification.
- email    {"host": string, "port": number, "secure"?: bool, "user"?: string, "from": string, "to": string, "subject"?: string, "body"?: string} — SMTP-Versand. Passwort NICHT inline: kommt aus {{secret.SMTP_PASS}}. "body" defaultet auf {{last}}.
- channel  {"channel":"telegram"|"slack"|"discord"|"webhook", "url"?: string, "chatId"?: string, "message"?: string} — Nachricht an einen Kanal. telegram nutzt {{secret.TELEGRAM_BOT_TOKEN}} (+ optional chatId/{{secret.TELEGRAM_CHAT_ID}}); slack/discord/webhook brauchen "url". "message" defaultet auf {{last}}.
- output   {"template"?: string} — emit the final result (defaults to {{last}}).

Variables (in any string config): {{input}} = the text the user passes when running it; {{last}} = previous node's output; {{name}} = a variable a transform set via its config "outputVar". Put the user-facing result in the LAST node.`
