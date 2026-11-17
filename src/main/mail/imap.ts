import { connect as tlsConnect } from 'node:tls'
import type { Duplex } from 'node:stream'

// A minimal IMAP4rev1 client for Gmail with an app password (imap.gmail.com:993, TLS), no dependencies:
// LOGIN, LIST, SELECT/EXAMINE, UID SEARCH (Gmail's X-GM-RAW search syntax), UID FETCH of headers and
// bodies with BODY.PEEK (reading never marks a message read unless asked), UID STORE for read/unread and
// Gmail labels (X-GM-LABELS), and LOGOUT. Literals ({n} + bytes) are read and sent properly; every
// command has a timeout. One command at a time. The password is never put in an error or a log.

export const GMAIL_IMAP = { host: 'imap.gmail.com', port: 993 }

export class ImapError extends Error {
  constructor(message: string, readonly kind: 'NO' | 'BAD' | 'BYE' | 'TIMEOUT' | 'NET' | 'PROTOCOL', readonly serverText = '') { super(message); this.name = 'ImapError' }
}

/** An IMAP value: atom/quoted string, NIL, literal bytes, or a parenthesized list. */
export type ImapValue = string | Buffer | null | ImapValue[]

/** One server response line with its literals: `{n}` placeholders became \u0001i\u0001 markers. */
interface Resp { line: string; literals: Buffer[] }

const LIT = (i: number): string => `\u0001${i}\u0001`

/** Parses a response's text (after "* 12 FETCH ", say) into values. Bracketed sections stay one atom ("BODY[HEADER.FIELDS (FROM)]<0>"). */
export function parseImapValues(text: string, literals: Buffer[] = []): ImapValue[] {
  let i = 0
  const readList = (): ImapValue[] => {
    const out: ImapValue[] = []
    while (i < text.length) {
      const c = text[i]
      if (c === ' ' || c === '\r' || c === '\n') { i++; continue }
      if (c === ')') { i++; return out }
      if (c === '(') { i++; out.push(readList()); continue }
      if (c === '"') {
        i++
        let s = ''
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\' && i + 1 < text.length) i++; s += text[i++] }
        i++
        out.push(s)
        continue
      }
      if (c === '\u0001') {
        const end = text.indexOf('\u0001', i + 1)
        out.push(literals[Number(text.slice(i + 1, end))] ?? Buffer.alloc(0))
        i = end + 1
        continue
      }
      let s = ''
      let depth = 0
      while (i < text.length) {
        const ch = text[i]
        if (ch === '[') depth++
        else if (ch === ']') depth = Math.max(0, depth - 1)
        else if (!depth && (ch === ' ' || ch === '(' || ch === ')' || ch === '\u0001')) break
        s += ch
        i++
      }
      out.push(s.toUpperCase() === 'NIL' ? null : s)
    }
    return out
  }
  return readList()
}

/** Modified UTF-7 (RFC 3501 §5.1.3) for mailbox names. */
export function encodeMailbox(name: string): string {
  let out = ''
  let pending = ''
  const flush = (): void => {
    if (!pending) return
    const b = Buffer.alloc(pending.length * 2)
    for (let k = 0; k < pending.length; k++) b.writeUInt16BE(pending.charCodeAt(k), k * 2)
    out += `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`
    pending = ''
  }
  for (const ch of name) {
    const code = ch.codePointAt(0)!
    if (code >= 0x20 && code <= 0x7e) { flush(); out += ch === '&' ? '&-' : ch }
    else pending += ch
  }
  flush()
  return out
}

export function decodeMailbox(name: string): string {
  return name.replace(/&([^-]*)-/g, (_m, b64: string) => {
    if (!b64) return '&'
    const b = Buffer.from(b64.replace(/,/g, '/'), 'base64')
    let s = ''
    for (let k = 0; k + 1 < b.length; k += 2) s += String.fromCharCode(b.readUInt16BE(k))
    return s
  })
}

/** A string as an IMAP quoted string, or null when it needs a literal (8-bit, CR/LF, very long). */
function quoted(s: string): string | null {
  if (/[\r\n\0]/.test(s) || /[^\x20-\x7e]/.test(s) || s.length > 1000) return null
  return `"${s.replace(/(["\\])/g, '\\$1')}"`
}

export interface ImapOptions {
  user: string
  pass: string
  host?: string
  port?: number
  /** Opens the byte stream (tests connect to a local fake server; default: TLS to Gmail). */
  connect?: () => Duplex
  timeoutMs?: number
}

export interface FetchedMessage {
  uid: number
  flags: string[]
  labels: string[]
  size: number
  internalDate: string
  /** Header bytes (headers fetch) or the whole message (body fetch). */
  raw: Buffer
}

/** A literal part of a command: sent as {n} after the server's go-ahead. */
class Literal { constructor(readonly data: Buffer) {} }

export class ImapClient {
  private sock: Duplex | null = null
  private buf: Buffer = Buffer.alloc(0)
  private tagN = 0
  private queue: Promise<unknown> = Promise.resolve()
  private onResp: ((r: Resp) => void) | null = null
  private onEnd: ((e: Error) => void) | null = null
  private closed = false
  private pending: Resp[] = []
  private literals: Buffer[] = []
  private partial = ''
  /** The mailbox selected now and whether it is read-write. */
  selected: { name: string; write: boolean } | null = null
  capabilities = new Set<string>()

  constructor(private o: ImapOptions) {}

  private get timeout(): number { return this.o.timeoutMs ?? 30_000 }

  /** Connects, reads the greeting and logs in. */
  async open(): Promise<void> {
    const sock = this.o.connect ? this.o.connect() : tlsConnect({ host: this.o.host ?? GMAIL_IMAP.host, port: this.o.port ?? GMAIL_IMAP.port, servername: this.o.host ?? GMAIL_IMAP.host })
    this.sock = sock
    sock.on('data', (d: Buffer) => this.feed(d))
    const fail = (e: Error): void => { this.closed = true; const f = this.onEnd; this.onEnd = null; f?.(e) }
    sock.on('error', (e) => fail(new ImapError(`Couldn't reach Gmail (${(e as NodeJS.ErrnoException).code ?? e.message}). Check the internet connection.`, 'NET')))
    sock.on('close', () => fail(new ImapError('Gmail closed the connection.', 'NET')))
    const greet = await this.next(this.timeout)
    if (/^\* BYE/i.test(greet.line)) throw new ImapError(`Gmail refused the connection: ${greet.line.slice(6)}`, 'BYE', greet.line)
    if (!/^\* (OK|PREAUTH)/i.test(greet.line)) throw new ImapError('That server didn\'t greet like an IMAP server.', 'PROTOCOL', greet.line)
    const cap = /\[CAPABILITY ([^\]]+)\]/i.exec(greet.line)
    if (cap) this.capabilities = new Set(cap[1].toUpperCase().split(/\s+/))
    await this.run(['LOGIN ', this.arg(this.o.user), ' ', this.arg(this.o.pass)])
  }

  private arg(s: string): string | Literal {
    return quoted(s) ?? new Literal(Buffer.from(s, 'utf8'))
  }

  /** Bytes in: split into responses (lines plus their literals). */
  private feed(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    for (;;) {
      const nl = this.buf.indexOf('\r\n')
      if (nl < 0) return
      const line = this.buf.subarray(0, nl).toString('utf8')
      const lit = /\{(\d+)\+?\}$/.exec(line)
      if (lit) {
        const n = Number(lit[1])
        if (this.buf.length < nl + 2 + n) return
        this.literals.push(Buffer.from(this.buf.subarray(nl + 2, nl + 2 + n)))
        this.partial += line.slice(0, lit.index) + LIT(this.literals.length - 1)
        this.buf = this.buf.subarray(nl + 2 + n)
        continue
      }
      const r: Resp = { line: this.partial + line, literals: this.literals }
      this.partial = ''
      this.literals = []
      this.buf = this.buf.subarray(nl + 2)
      if (this.onResp) this.onResp(r)
      else this.pending.push(r)
    }
  }

  private next(timeoutMs: number): Promise<Resp> {
    const queued = this.pending.shift()
    if (queued) return Promise.resolve(queued)
    if (this.closed) return Promise.reject(new ImapError('Gmail closed the connection.', 'NET'))
    return new Promise((ok, fail) => {
      const t = setTimeout(() => { this.onResp = null; this.onEnd = null; this.destroy(); fail(new ImapError('Gmail didn\'t answer in time. Try again.', 'TIMEOUT')) }, timeoutMs)
      this.onResp = (r) => { clearTimeout(t); this.onResp = null; this.onEnd = null; ok(r) }
      this.onEnd = (e) => { clearTimeout(t); this.onResp = null; fail(e) }
    })
  }

  private write(data: string | Buffer): void {
    if (!this.sock || this.closed) throw new ImapError('Not connected to Gmail.', 'NET')
    this.sock.write(data)
  }

  /** Runs one command (parts: text and literals); resolves with its untagged responses. */
  run(parts: Array<string | Literal>, timeoutMs = this.timeout): Promise<Resp[]> {
    const job = this.queue.catch(() => undefined).then(async () => {
      const tag = `S${++this.tagN}`
      const untagged: Resp[] = []
      let text = `${tag} `
      for (const p of parts) {
        if (typeof p === 'string') { text += p; continue }
        this.write(`${text}{${p.data.length}}\r\n`)
        text = ''
        // Wait for the go-ahead ("+ …") before the literal's bytes.
        for (;;) {
          const r = await this.next(timeoutMs)
          if (r.line.startsWith('+')) break
          if (r.line.startsWith(`${tag} `)) throw this.failure(r.line.slice(tag.length + 1))
          untagged.push(r)
        }
        this.write(p.data)
      }
      this.write(`${text}\r\n`)
      for (;;) {
        const r = await this.next(timeoutMs)
        if (r.line.startsWith(`${tag} `)) {
          const rest = r.line.slice(tag.length + 1)
          if (/^OK\b/i.test(rest)) return untagged
          throw this.failure(rest)
        }
        if (/^\* BYE/i.test(r.line) && !/^LOGOUT/i.test(String(parts[0]))) { this.destroy(); throw new ImapError(`Gmail ended the session: ${r.line.slice(6)}`, 'BYE', r.line) }
        untagged.push(r)
      }
    })
    this.queue = job
    return job
  }

  private failure(rest: string): ImapError {
    const kind = /^BAD\b/i.test(rest) ? 'BAD' : 'NO'
    const msg = rest.replace(/^(NO|BAD)\s*/i, '')
    const safe = this.o.pass ? msg.split(this.o.pass).join('••••') : msg
    return new ImapError(safe, kind, safe)
  }

  /** Mailboxes: name (decoded), flags (\All, \Sent, \Trash…). */
  async list(): Promise<Array<{ name: string; raw: string; flags: string[] }>> {
    const rs = await this.run(['LIST "" "*"'])
    return rs.filter((r) => /^\* LIST /i.test(r.line)).map((r) => {
      const v = parseImapValues(r.line.slice(7), r.literals)
      const flags = (Array.isArray(v[0]) ? v[0] : []).map(String)
      const raw = typeof v[2] === 'string' ? v[2] : Buffer.isBuffer(v[2]) ? v[2].toString('utf8') : ''
      return { name: decodeMailbox(raw), raw, flags }
    })
  }

  /** The mailbox with Gmail's \All flag ("[Gmail]/All Mail", localized), else INBOX. */
  async allMail(): Promise<string> {
    const boxes = await this.list()
    return boxes.find((b) => b.flags.some((f) => /^\\All$/i.test(f)))?.raw ?? 'INBOX'
  }

  /** SELECT (read-write) or EXAMINE (read-only) a mailbox by its raw (encoded) name. */
  async select(raw: string, write = false): Promise<{ exists: number }> {
    if (this.selected?.name === raw && (this.selected.write || !write)) return { exists: -1 }
    const rs = await this.run([write ? 'SELECT ' : 'EXAMINE ', this.arg(raw)])
    this.selected = { name: raw, write }
    const ex = rs.map((r) => /^\* (\d+) EXISTS/i.exec(r.line)).find(Boolean)
    return { exists: ex ? Number(ex[1]) : 0 }
  }

  /** UIDs matching a Gmail search ("from:amy newer_than:7d", "in:inbox is:unread"), ascending. */
  async search(gmailQuery: string): Promise<number[]> {
    const q = gmailQuery.trim() || 'in:inbox'
    const plain = quoted(q)
    const rs = await this.run(plain ? ['UID SEARCH X-GM-RAW ', plain] : ['UID SEARCH CHARSET UTF-8 X-GM-RAW ', new Literal(Buffer.from(q, 'utf8'))], 60_000)
    const uids: number[] = []
    for (const r of rs) {
      const m = /^\* SEARCH\b(.*)$/i.exec(r.line)
      if (m) for (const n of m[1].trim().split(/\s+/)) if (/^\d+$/.test(n)) uids.push(Number(n))
    }
    return [...new Set(uids)].sort((a, b) => a - b)
  }

  /** UID FETCH: headers only (`what: 'headers'`) or the whole message up to `maxBytes`, never setting \Seen. */
  async fetch(uids: number[], what: 'headers' | 'full', maxBytes = 10 * 1024 * 1024): Promise<FetchedMessage[]> {
    if (!uids.length) return []
    const set = uids.map((u) => Math.floor(u)).filter((u) => u > 0).join(',')
    const item = what === 'headers' ? 'BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)]' : `BODY.PEEK[]<0.${Math.max(1024, Math.floor(maxBytes))}>`
    const rs = await this.run([`UID FETCH ${set} (UID FLAGS INTERNALDATE RFC822.SIZE X-GM-LABELS ${item})`], 120_000)
    const out: FetchedMessage[] = []
    for (const r of rs) {
      const m = /^\* \d+ FETCH /i.exec(r.line)
      if (!m) continue
      const v = parseImapValues(r.line.slice(m[0].length), r.literals)
      const items = Array.isArray(v[0]) ? v[0] : []
      const msg: FetchedMessage = { uid: 0, flags: [], labels: [], size: 0, internalDate: '', raw: Buffer.alloc(0) }
      for (let k = 0; k + 1 < items.length; k += 2) {
        const key = String(items[k]).toUpperCase()
        const val = items[k + 1]
        if (key === 'UID') msg.uid = Number(val)
        else if (key === 'FLAGS') msg.flags = (Array.isArray(val) ? val : []).map(String)
        else if (key === 'X-GM-LABELS') msg.labels = (Array.isArray(val) ? val : []).map((x) => decodeMailbox(Buffer.isBuffer(x) ? x.toString('utf8') : String(x)))
        else if (key === 'RFC822.SIZE') msg.size = Number(val) || 0
        else if (key === 'INTERNALDATE') msg.internalDate = String(val ?? '')
        else if (key.startsWith('BODY[')) msg.raw = Buffer.isBuffer(val) ? val : Buffer.from(String(val ?? ''), 'latin1')
      }
      if (msg.uid) out.push(msg)
    }
    return out
  }

  /** UID STORE: flags (+/-FLAGS.SILENT) or Gmail labels (+/-X-GM-LABELS; Gmail answers with FETCH lines, ignored). Needs a read-write selection. */
  async store(uids: number[], op: '+' | '-', kind: 'flags' | 'labels', values: string[]): Promise<void> {
    if (!uids.length || !values.length) return
    const set = uids.map((u) => Math.floor(u)).filter((u) => u > 0).join(',')
    const vals = values.map((v) => (/^\\[A-Za-z]+$/.test(v) ? v : quoted(encodeMailbox(v)) ?? `"${encodeMailbox(v)}"`)).join(' ')
    await this.run([`UID STORE ${set} ${op}${kind === 'flags' ? 'FLAGS.SILENT' : 'X-GM-LABELS'} (${vals})`])
  }

  async logout(): Promise<void> {
    if (!this.sock || this.closed) return
    try { await this.run(['LOGOUT'], 5_000) } catch { /* closing anyway */ }
    this.destroy()
  }

  destroy(): void {
    this.closed = true
    try { this.sock?.destroy() } catch { /* gone */ }
  }
}

/** Opens a logged-in client, runs `fn`, and always logs out. */
export async function withImap<T>(o: ImapOptions, fn: (c: ImapClient) => Promise<T>): Promise<T> {
  const c = new ImapClient(o)
  try {
    await c.open()
    return await fn(c)
  } finally {
    await c.logout().catch(() => undefined)
  }
}
