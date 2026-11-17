import { connect as tlsConnect } from 'node:tls'
import { hostname } from 'node:os'
import type { Duplex } from 'node:stream'

// A minimal SMTP client for Gmail with an app password (smtp.gmail.com:465, implicit TLS), no
// dependencies: EHLO, AUTH PLAIN (or LOGIN), MAIL FROM, RCPT TO (each recipient, Bcc included: Bcc is
// never written into the message), DATA with dot-stuffing, QUIT. The message itself comes from
// mime.ts buildMail. The password never appears in an error.

export const GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465 }

export class SmtpError extends Error {
  constructor(message: string, readonly code: number, readonly serverText = '') { super(message); this.name = 'SmtpError' }
}

/** Lines starting with "." get one more (RFC 5321 §4.5.2); line ends become CRLF. */
export function dotStuff(data: string): string {
  return data.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n')
}

export interface SmtpOptions {
  user: string
  pass: string
  host?: string
  port?: number
  connect?: () => Duplex
  timeoutMs?: number
  /** The EHLO name (default: this Mac's host name, tidied). */
  helo?: string
}

/** Sends one message to every recipient (envelope); resolves with the server's queue reply. */
export async function smtpSend(o: SmtpOptions, env: { from: string; to: string[] }, message: string): Promise<{ reply: string; accepted: string[] }> {
  const sock = o.connect ? o.connect() : tlsConnect({ host: o.host ?? GMAIL_SMTP.host, port: o.port ?? GMAIL_SMTP.port, servername: o.host ?? GMAIL_SMTP.host })
  const timeout = o.timeoutMs ?? 30_000
  let buf = ''
  let waiter: ((r: { code: number; text: string }) => void) | null = null
  let failer: ((e: Error) => void) | null = null
  let ended: Error | null = null
  const replies: Array<{ code: number; text: string }> = []
  const lines: string[] = []
  sock.setEncoding?.('utf8')
  sock.on('data', (d: string | Buffer) => {
    buf += typeof d === 'string' ? d : d.toString('utf8')
    for (;;) {
      const nl = buf.indexOf('\r\n')
      if (nl < 0) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      lines.push(line)
      // "250-…" continues, "250 …" ends a reply.
      if (/^\d{3}(?: |$)/.test(line)) {
        const r = { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join('\n') }
        lines.length = 0
        if (waiter) { const w = waiter; waiter = null; failer = null; w(r) } else replies.push(r)
      }
    }
  })
  const end = (e: Error): void => { ended = e; if (failer) { const f = failer; failer = null; waiter = null; f(e) } }
  sock.on('error', (e) => end(new SmtpError(`Couldn't reach Gmail's mail server (${(e as NodeJS.ErrnoException).code ?? e.message}). Check the internet connection.`, 0)))
  sock.on('close', () => end(new SmtpError('Gmail\'s mail server closed the connection.', 0)))
  const reply = (): Promise<{ code: number; text: string }> => {
    const r = replies.shift()
    if (r) return Promise.resolve(r)
    if (ended) return Promise.reject(ended)
    return new Promise((ok, fail) => {
      const t = setTimeout(() => { waiter = null; failer = null; sock.destroy(); fail(new SmtpError('Gmail\'s mail server didn\'t answer in time.', 0)) }, timeout)
      waiter = (x) => { clearTimeout(t); ok(x) }
      failer = (e) => { clearTimeout(t); fail(e) }
    })
  }
  const safe = (t: string): string => (o.pass ? t.split(o.pass).join('••••') : t)
  const expect = async (ok: number[], what: string): Promise<{ code: number; text: string }> => {
    const r = await reply()
    if (!ok.includes(r.code)) throw new SmtpError(`${what}: ${r.code} ${safe(r.text)}`, r.code, safe(r.text))
    return r
  }
  const send = (line: string): void => { sock.write(`${line}\r\n`) }
  try {
    await expect([220], 'Greeting')
    const helo = (o.helo ?? hostname()).replace(/[^A-Za-z0-9.-]/g, '').slice(0, 60) || 'sahilbot.local'
    send(`EHLO ${helo}`)
    const ehlo = await expect([250], 'EHLO')
    const auth = /^AUTH\s+(.*)$/im.exec(ehlo.text)?.[1]?.toUpperCase().split(/\s+/) ?? ['PLAIN', 'LOGIN']
    if (auth.includes('PLAIN') || !auth.includes('LOGIN')) {
      send(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass}`, 'utf8').toString('base64')}`)
      await expect([235], 'Sign-in')
    } else {
      send('AUTH LOGIN')
      await expect([334], 'Sign-in')
      send(Buffer.from(o.user, 'utf8').toString('base64'))
      await expect([334], 'Sign-in')
      send(Buffer.from(o.pass, 'utf8').toString('base64'))
      await expect([235], 'Sign-in')
    }
    const addr = (a: string): string => (/<([^<>]+)>/.exec(a)?.[1] ?? a).trim()
    send(`MAIL FROM:<${addr(env.from)}>`)
    await expect([250], 'Sender')
    const accepted: string[] = []
    for (const r of env.to) {
      const a = addr(r)
      if (/[\r\n<>]/.test(a)) throw new SmtpError(`"${a}" isn't a valid address.`, 0)
      send(`RCPT TO:<${a}>`)
      await expect([250, 251], `Recipient ${a}`)
      accepted.push(a)
    }
    send('DATA')
    await expect([354], 'DATA')
    const body = dotStuff(message.replace(/(\r?\n)+$/, ''))
    sock.write(`${body}\r\n.\r\n`)
    const done = await expect([250], 'Sending')
    send('QUIT')
    await reply().catch(() => undefined)
    return { reply: done.text, accepted }
  } finally {
    try { sock.destroy() } catch { /* gone */ }
  }
}
