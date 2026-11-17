import { createServer, connect, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

// Local fake Gmail IMAP and SMTP servers over plain TCP (the clients take a `connect` function, so tests
// never open TLS to Google). Just enough of each protocol for SahilBot's clients, with the quirks that
// matter: literals both ways, X-GM-RAW search, X-GM-LABELS, BODY.PEEK not setting \Seen, Gmail's
// sign-in errors.

export interface FakeMessage { uid: number; raw: string; flags: string[]; labels: string[] }

export const GOOD = { user: 'sam@gmail.com', pass: 'abcdefghijklmnop' }

const CRLF = '\r\n'

/** IMAP: one mailbox list, an All Mail of `messages`, and a log of every command (passwords included, for tests to check). */
export function fakeImap(messages: FakeMessage[]) {
  const log: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    let buf = Buffer.alloc(0)
    let need = 0
    let line = ''
    const send = (s: string | Buffer): void => { if (!sock.destroyed) sock.write(s) }
    send(`* OK [CAPABILITY IMAP4rev1 X-GM-EXT-1 UIDPLUS] Gimap ready${CRLF}`)
    const fetchLine = (m: FakeMessage, items: string, seq: number): void => {
      const parts: Array<string | Buffer> = [`* ${seq} FETCH (UID ${m.uid} FLAGS (${m.flags.join(' ')}) INTERNALDATE "17-Nov-2026 09:00:00 +0000" RFC822.SIZE ${Buffer.byteLength(m.raw)} X-GM-LABELS (${m.labels.map((l) => (l.startsWith('\\') ? l : `"${l}"`)).join(' ')})`]
      if (/HEADER\.FIELDS/i.test(items)) {
        const head = m.raw.split(/\r\n\r\n/)[0].split(CRLF).filter((l) => /^(from|to|cc|subject|date|message-id|in-reply-to|references):/i.test(l)).join(CRLF) + CRLF + CRLF
        parts.push(` BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] {${Buffer.byteLength(head)}}${CRLF}`, head)
      } else {
        const cap = Number(/<0\.(\d+)>/.exec(items)?.[1] ?? 1e9)
        const body = Buffer.from(m.raw, 'utf8').subarray(0, cap)
        parts.push(` BODY[]<0> {${body.length}}${CRLF}`, body)
        if (!/PEEK/i.test(items) && !m.flags.includes('\\Seen')) m.flags.push('\\Seen')
      }
      parts.push(`)${CRLF}`)
      for (const p of parts) send(p)
    }
    const handle = (cmd: string): void => {
      log.push(cmd)
      const m = /^(\S+) (.*)$/s.exec(cmd)
      if (!m) return
      const [, tag, rest] = m
      const ok = (t = 'Success'): void => send(`${tag} OK ${t}${CRLF}`)
      if (/^LOGIN /i.test(rest)) {
        const [, u, p] = /^LOGIN "([^"]*)" "([^"]*)"$/i.exec(rest) ?? []
        if (u === 'needs-app@gmail.com') return send(`${tag} NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)${CRLF}`)
        if (u !== GOOD.user || p !== GOOD.pass) return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)${CRLF}`)
        return ok(`${u} authenticated (Success)`)
      }
      if (/^LIST /i.test(rest)) {
        send(`* LIST (\\HasNoChildren) "/" "INBOX"${CRLF}* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"${CRLF}* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"${CRLF}* LIST (\\HasNoChildren) "/" "Entw&APw-rfe"${CRLF}`)
        return ok()
      }
      if (/^(SELECT|EXAMINE) /i.test(rest)) { send(`* ${messages.length} EXISTS${CRLF}`); return ok(/^SELECT/i.test(rest) ? '[READ-WRITE] Success' : '[READ-ONLY] Success') }
      if (/^UID SEARCH /i.test(rest)) {
        const q = (/X-GM-RAW "(.*)"$/i.exec(rest)?.[1] ?? /X-GM-RAW \u0000(.*)$/s.exec(rest)?.[1] ?? '').toLowerCase()
        const hits = messages.filter((x) => (q === 'in:inbox' ? x.labels.includes('\\Inbox') : q.split(/\s+/).every((w) => x.raw.toLowerCase().includes(w))))
        send(`* SEARCH${hits.map((x) => ` ${x.uid}`).join('')}${CRLF}`)
        return ok()
      }
      if (/^UID FETCH /i.test(rest)) {
        const [, set, items] = /^UID FETCH (\S+) \((.*)\)$/i.exec(rest) ?? []
        const uids = (set ?? '').split(',').map(Number)
        messages.forEach((x, i) => { if (uids.includes(x.uid)) fetchLine(x, items ?? '', i + 1) })
        return ok()
      }
      if (/^UID STORE /i.test(rest)) {
        const [, set, op, kind, vals] = /^UID STORE (\S+) ([+-])(FLAGS\.SILENT|FLAGS|X-GM-LABELS) \((.*)\)$/i.exec(rest) ?? []
        const values = (vals ?? '').match(/"[^"]*"|\S+/g)?.map((v) => v.replace(/^"|"$/g, '')) ?? []
        for (const x of messages) {
          if (!(set ?? '').split(',').map(Number).includes(x.uid)) continue
          const list = /LABELS/i.test(kind ?? '') ? x.labels : x.flags
          for (const v of values) {
            const i = list.indexOf(v)
            if (op === '+' && i < 0) list.push(v)
            if (op === '-' && i >= 0) list.splice(i, 1)
          }
        }
        return ok()
      }
      if (/^LOGOUT/i.test(rest)) { send(`* BYE LOGOUT Requested${CRLF}`); ok(); sock.end(); return }
      send(`${tag} BAD Unknown command${CRLF}`)
    }
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (need) {
          if (buf.length < need) return
          line += `\u0000${buf.subarray(0, need).toString('utf8')}`
          buf = buf.subarray(need)
          need = 0
          continue
        }
        const nl = buf.indexOf(CRLF)
        if (nl < 0) return
        const part = buf.subarray(0, nl).toString('utf8')
        buf = buf.subarray(nl + 2)
        const lit = /\{(\d+)\}$/.exec(part)
        if (lit) { line += part.slice(0, lit.index); need = Number(lit[1]); send(`+ go ahead${CRLF}`); continue }
        const cmd = line + part
        line = ''
        // A literal's bytes were marked with \u0000; quoted searches look the same to the handler.
        handle(cmd.replace(/X-GM-RAW \u0000/, 'X-GM-RAW \u0000'))
      }
    })
  })
  return {
    log, server, messages,
    async listen(): Promise<number> { await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r())); return (server.address() as AddressInfo).port },
    connect: () => connect((server.address() as AddressInfo).port, '127.0.0.1'),
    close: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)) }
  }
}

/** SMTP: AUTH PLAIN, the envelope and the DATA of every message accepted. */
export function fakeSmtp() {
  const mails: Array<{ from: string; to: string[]; data: string; auth: string }> = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    let buf = ''
    let data: string | null = null
    let cur = { from: '', to: [] as string[], data: '', auth: '' }
    const send = (s: string): void => { if (!sock.destroyed) sock.write(s + CRLF) }
    send('220 smtp.gmail.com ESMTP ready')
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf(`${CRLF}.${CRLF}`)
          if (end < 0) return
          data += buf.slice(0, end)
          buf = buf.slice(end + 5)
          mails.push({ ...cur, data })
          data = null
          cur = { from: '', to: [], data: '', auth: cur.auth }
          send('250 2.0.0 OK 1700000000 queued')
          continue
        }
        const nl = buf.indexOf(CRLF)
        if (nl < 0) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        if (/^EHLO /i.test(line)) { send('250-smtp.gmail.com at your service'); send('250-SIZE 35882577'); send('250-8BITMIME'); send('250 AUTH LOGIN PLAIN XOAUTH2'); continue }
        if (/^AUTH PLAIN /i.test(line)) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000')
          cur.auth = u
          if (u === 'needs-app@gmail.com') { send('534-5.7.9 Application-specific password required. Learn more at'); send('534 5.7.9 https://support.google.com/mail/?p=InvalidSecondFactor'); continue }
          if (u !== GOOD.user || p !== GOOD.pass) { send('535-5.7.8 Username and Password not accepted.'); send('535 5.7.8 https://support.google.com/mail/?p=BadCredentials'); continue }
          send('235 2.7.0 Accepted')
          continue
        }
        if (/^MAIL FROM:/i.test(line)) { cur.from = /<([^>]*)>/.exec(line)?.[1] ?? ''; send('250 2.1.0 OK'); continue }
        if (/^RCPT TO:/i.test(line)) { cur.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); send('250 2.1.5 OK'); continue }
        if (/^DATA$/i.test(line)) { data = ''; send('354 Go ahead'); continue }
        if (/^QUIT$/i.test(line)) { send('221 2.0.0 closing connection'); sock.end(); continue }
        send('502 5.5.1 Unrecognized command.')
      }
    })
  })
  return {
    mails, server,
    async listen(): Promise<number> { await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r())); return (server.address() as AddressInfo).port },
    connect: () => connect((server.address() as AddressInfo).port, '127.0.0.1'),
    close: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)) }
  }
}
