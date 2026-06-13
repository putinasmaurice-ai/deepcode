import nodemailer from 'nodemailer'

// Thin SMTP sender for the `email` workflow node. Kept out of the executor so the
// executor stays pure/testable (tests inject a mock sendEmail). nodemailer is a
// single zero-dependency package — no transitive bloat — and handles the finicky
// parts (implicit TLS on 465, STARTTLS on 587, AUTH) far more reliably than a
// hand-rolled client would.

export interface EmailOptions {
  host: string
  port: number
  secure: boolean // true => implicit TLS (465); false => STARTTLS upgrade (587/25)
  user?: string
  pass?: string
  from: string
  to: string // comma-separated allowed
  subject: string
  text: string
}

// A connection/handshake must not hang an unattended run forever.
const TIMEOUT_MS = 20_000

export async function sendEmail(o: EmailOptions): Promise<string> {
  const host = String(o.host || '').trim()
  if (!host) throw new Error('email: SMTP-Host fehlt')
  const to = String(o.to || '').trim()
  if (!to) throw new Error('email: kein Empfänger (To) gesetzt')
  const from = String(o.from || '').trim() || o.user || ''
  if (!from) throw new Error('email: kein Absender (From) gesetzt')

  const port = Number(o.port) || (o.secure ? 465 : 587)
  const auth = o.user ? { user: o.user, pass: o.pass ?? '' } : undefined
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: o.secure === true,
    auth,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS
  })

  try {
    const info = await transporter.sendMail({
      from,
      to,
      // cap subject/body so an unattended run can't build a multi-MB SMTP payload from {{last}}
      subject: String(o.subject || '(kein Betreff)').slice(0, 1000),
      text: String(o.text ?? '').slice(0, 200_000)
    })
    const accepted = Array.isArray(info.accepted) ? info.accepted.join(', ') : to
    return `gesendet an ${accepted}${info.messageId ? ` (${info.messageId})` : ''}`
  } finally {
    transporter.close()
  }
}
