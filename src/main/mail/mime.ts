import { randomUUID } from 'node:crypto'

// A small MIME reader and writer for Gmail over IMAP/SMTP (mail/imap.ts, mail/smtp.ts): no dependencies.
// Reading: headers (folded lines, RFC 2047 encoded words, RFC 2231 parameters), multipart/alternative and
// mixed (nested), quoted-printable and base64, charsets through TextDecoder; text/plain is preferred, HTML
// is turned into plain text when it is all there is, and attachments are listed by name and size.
// Writing: an RFC 5322 message with Date, Message-ID, In-Reply-To/References, UTF-8 headers as encoded
// words, quoted-printable text, an optional HTML alternative and base64 attachments. CRLF throughout.

export interface MimeAttachment { index: number; filename: string; contentType: string; size: number; content: Buffer }

export interface ParsedMail {
  headers: Map<string, string[]>
  subject: string
  from: string
  to: string[]
  cc: string[]
  date: string
  messageId: string
  inReplyTo: string
  references: string
  text: string
  /** The HTML part, when there was one (raw HTML: never shown as is). */
  html?: string
  attachments: MimeAttachment[]
}

// ------------------------------------------------------------------ charsets and encodings

/** Bytes in a charset, as text. Unknown charsets fall back to UTF-8 (then Latin-1 for invalid bytes). */
export function decodeCharset(bytes: Buffer, charset = 'utf-8'): string {
  const cs = charset.trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8'
  const name = cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs === 'latin1' ? 'iso-8859-1' : cs
  try { return new TextDecoder(name, { fatal: false }).decode(bytes) } catch { /* unknown label */ }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return bytes.toString('latin1') }
}

/** Quoted-printable to bytes (soft line breaks removed, =XX decoded). */
export function decodeQuotedPrintable(s: string): Buffer {
  const t = s.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c === 0x3d && /^[0-9a-f]{2}$/i.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2 }
    else out.push(c & 0xff)
  }
  return Buffer.from(out)
}

/** UTF-8 text as quoted-printable, lines ≤ 76 characters, CRLF line ends. */
export function encodeQuotedPrintable(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return lines.map((line) => {
    const bytes = Buffer.from(line, 'utf8')
    let enc = ''
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      const last = i === bytes.length - 1
      enc += (b === 0x3d || b < 0x20 && b !== 0x09 || b > 0x7e || ((b === 0x20 || b === 0x09) && last)) ? `=${b.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(b)
    }
    // Soft breaks at 75 characters, never inside an =XX escape.
    const parts: string[] = []
    while (enc.length > 76) {
      let cut = 75
      const eq = enc.lastIndexOf('=', cut)
      if (eq > cut - 3) cut = eq
      parts.push(`${enc.slice(0, cut)}=`)
      enc = enc.slice(cut)
    }
    parts.push(enc)
    return parts.join('\r\n')
  }).join('\r\n')
}

/** RFC 2047 encoded words in a header ("=?UTF-8?B?…?=", "=?iso-8859-1?Q?…?="); whitespace between two of them goes. */
export function decodeWords(value: string): string {
  const joined = value.replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?[^?]+\?[bq]\?)/gi, '$1')
  return joined.replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bq])\?([^?]*)\?=/gi, (_m, cs: string, enc: string, data: string) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : decodeQuotedPrintable(data.replace(/_/g, ' '))
      return decodeCharset(bytes, cs)
    } catch { return data }
  })
}

/** A header value as an encoded word when it isn't plain ASCII (B encoding, chunks under 76 characters). */
export function encodeWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  const chunks: string[] = []
  let cur = ''
  for (const ch of text) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 42) { chunks.push(cur); cur = '' }
    cur += ch
  }
  if (cur) chunks.push(cur)
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ')
}

// ------------------------------------------------------------------ headers

/** Splits raw header text (latin1 string of the bytes) into lower-cased names → values, unfolded. */
export function parseHeaders(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    // Header bytes are often raw UTF-8 too (RFC 6532): reread them as UTF-8, then decode encoded words.
    const value = decodeWords(decodeCharset(Buffer.from(line.slice(i + 1).trim(), 'latin1'), 'utf-8'))
    out.set(name, [...(out.get(name) ?? []), value])
  }
  return out
}

/** "text/plain; charset=utf-8; name*=UTF-8''r%C3%A9sum%C3%A9.pdf" → value and parameters (RFC 2231 included). */
export function parseParams(v: string): { value: string; params: Record<string, string> } {
  const parts: string[] = []
  let cur = '', q = false
  for (const ch of v) {
    if (ch === '"') q = !q
    if (ch === ';' && !q) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  const params: Record<string, string> = {}
  const continued: Record<string, Array<[number, string, boolean]>> = {}
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=')
    if (i < 0) continue
    const key = p.slice(0, i).trim().toLowerCase()
    let val = p.slice(i + 1).trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1')
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(key)
    if (m) { (continued[m[1]] ??= []).push([Number(m[2] ?? 0), val, !!m[3] || (!m[2] && key.endsWith('*'))]); continue }
    params[key] = val
  }
  for (const [k, segs] of Object.entries(continued)) {
    segs.sort((a, b) => a[0] - b[0])
    let charset = 'utf-8'
    const bytes: Buffer[] = []
    segs.forEach(([n, val, enc], i) => {
      let v = val
      if (i === 0 && enc && n === 0) { const m2 = /^([^']*)'[^']*'(.*)$/.exec(v); if (m2) { charset = m2[1] || 'utf-8'; v = m2[2] } }
      bytes.push(enc ? Buffer.from(v.replace(/%([0-9a-f]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1') : Buffer.from(v, 'latin1'))
    })
    params[k] = decodeCharset(Buffer.concat(bytes), charset)
  }
  return { value: parts[0].trim().toLowerCase(), params }
}

/** Addresses in a header value, split on commas outside quotes and angle brackets. */
export function splitAddresses(v: string | undefined): string[] {
  if (!v) return []
  const out: string[] = []
  let cur = '', q = false, angle = 0
  for (const ch of v) {
    if (ch === '"') q = !q
    else if (!q && ch === '<') angle++
    else if (!q && ch === '>') angle = Math.max(0, angle - 1)
    if (ch === ',' && !q && !angle) { if (cur.trim()) out.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** The bare address in "Name <addr>" (lowercased), or the text itself when it has no brackets. */
export const bareAddress = (v: string): string => (/<([^<>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase()

// ------------------------------------------------------------------ bodies

/** HTML as readable plain text: no scripts or styles, block tags as line breaks, entities decoded. */
export function htmlToText(html: string): string {
  const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => (label.replace(/<[^>]+>/g, '').trim() && !/^(https?:|mailto:)/i.test(label.trim()) ? `${label} (${href})` : label))
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+[0-9]*);/gi, (m, e: string) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
      return ENT[e.toLowerCase()] ?? m
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function transferDecode(body: Buffer, enc: string): Buffer {
  const e = enc.trim().toLowerCase()
  if (e === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (e === 'quoted-printable') return decodeQuotedPrintable(body.toString('latin1'))
  return body
}

/** Splits a part into its header text and body bytes at the first blank line. */
function splitPart(raw: Buffer): { head: string; body: Buffer } {
  const s = raw.toString('latin1')
  const m = /\r?\n\r?\n/.exec(s)
  if (!m) return { head: s, body: Buffer.alloc(0) }
  return { head: s.slice(0, m.index), body: raw.subarray(m.index + m[0].length) }
}

/** The parts of a multipart body between its boundary lines (preamble and epilogue dropped). */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const s = body.toString('latin1')
  const marker = `--${boundary}`
  const out: Buffer[] = []
  let pos = s.indexOf(marker)
  while (pos >= 0) {
    const lineEnd = s.indexOf('\n', pos)
    if (s.startsWith(`${marker}--`, pos) || lineEnd < 0) break
    const next = s.indexOf(`\n${marker}`, lineEnd)
    const end = next < 0 ? s.length : next
    let chunk = s.slice(lineEnd + 1, end)
    if (chunk.endsWith('\r')) chunk = chunk.slice(0, -1)
    out.push(Buffer.from(chunk, 'latin1'))
    if (next < 0) break
    pos = next + 1
  }
  return out
}

/** A whole message (bytes as fetched with BODY[]) parsed into headers, a text body and attachments. */
export function parseMail(raw: Buffer | string): ParsedMail {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'latin1') : raw
  const { head, body } = splitPart(bytes)
  const headers = parseHeaders(head)
  const texts: string[] = []
  const htmls: string[] = []
  const attachments: MimeAttachment[] = []
  const walk = (h: Map<string, string[]>, b: Buffer, depth: number): void => {
    const ct = parseParams(h.get('content-type')?.[0] ?? 'text/plain; charset=us-ascii')
    const disp = parseParams(h.get('content-disposition')?.[0] ?? '')
    const enc = h.get('content-transfer-encoding')?.[0] ?? '7bit'
    if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 12) {
      for (const part of splitMultipart(b, ct.params.boundary)) {
        const p = splitPart(part)
        walk(parseHeaders(p.head), p.body, depth + 1)
      }
      return
    }
    if (ct.value === 'message/rfc822' && depth < 12) {
      // A forwarded message: its text joins the body; its own attachments are listed too.
      const inner = parseMail(transferDecode(b, enc))
      texts.push(`---------- Forwarded message ----------\nFrom: ${inner.from}\nSubject: ${inner.subject}\n\n${inner.text}`)
      for (const a of inner.attachments) attachments.push({ ...a, index: attachments.length })
      return
    }
    const filename = disp.params.filename ?? ct.params.name ?? ''
    const isAttachment = disp.value === 'attachment' || (!!filename && !ct.value.startsWith('text/')) || (!ct.value.startsWith('text/') && ct.value !== '')
    const data = transferDecode(b, enc)
    if (isAttachment) {
      attachments.push({ index: attachments.length, filename: filename || `attachment-${attachments.length + 1}`, contentType: ct.value, size: data.length, content: data })
      return
    }
    const text = decodeCharset(data, ct.params.charset ?? 'utf-8')
    if (ct.value === 'text/html') htmls.push(text)
    else texts.push(text)
  }
  walk(headers, body, 0)
  const one = (k: string): string => headers.get(k)?.[0] ?? ''
  const html = htmls.length ? htmls.join('\n') : undefined
  const text = (texts.length ? texts.join('\n\n') : html ? htmlToText(html) : '').replace(/\r\n/g, '\n').trim()
  return {
    headers, subject: one('subject'), from: one('from'), to: splitAddresses(headers.get('to')?.join(', ')), cc: splitAddresses(headers.get('cc')?.join(', ')),
    date: one('date'), messageId: one('message-id'), inReplyTo: one('in-reply-to'), references: one('references'), text, ...(html ? { html } : {}), attachments
  }
}

// ------------------------------------------------------------------ writing

export interface OutgoingMail {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  text: string
  html?: string
  inReplyTo?: string
  references?: string
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>
  date?: Date
  messageId?: string
}

/** An RFC 5322 date: "Tue, 17 Nov 2026 09:05:00 +0000". */
export function rfc5322Date(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
}

/** "Name <addr>" with a non-ASCII name as an encoded word; a bare address as it is. */
function encodeAddress(a: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(a)
  if (!m || !m[1].trim()) return bareAddress(a)
  const name = m[1].trim()
  return `${/^[\x20-\x7e]*$/.test(name) ? (/[(),.:;<>@[\]\\"]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name) : encodeWord(name)} <${m[2].trim()}>`
}

/** Header-safe: no CR/LF smuggling extra headers in. */
const oneLine = (s: string): string => String(s ?? '').replace(/[\r\n]+/g, ' ').trim()

/** The full message text (CRLF), ready for SMTP DATA (dot-stuffing is the transport's job). Bcc is never written. */
export function buildMail(m: OutgoingMail): string {
  const domain = /@([^>\s]+)>?\s*$/.exec(m.from)?.[1] ?? 'sahilbot.local'
  const id = m.messageId ?? `<${randomUUID()}@${domain}>`
  const head: string[] = [
    `From: ${encodeAddress(oneLine(m.from))}`,
    `To: ${m.to.map((x) => encodeAddress(oneLine(x))).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map((x) => encodeAddress(oneLine(x))).join(', ')}`] : []),
    `Subject: ${encodeWord(oneLine(m.subject))}`,
    `Date: ${rfc5322Date(m.date ?? new Date())}`,
    `Message-ID: ${id}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${oneLine(m.references)}`] : []),
    'MIME-Version: 1.0'
  ]
  const textPart = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', encodeQuotedPrintable(m.text)].join('\r\n')
  const htmlPart = m.html ? ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', encodeQuotedPrintable(m.html)].join('\r\n') : ''
  const boundary = (k: string): string => `=_sahilbot_${k}_${randomUUID().replace(/-/g, '')}`
  let body = textPart
  if (m.html) {
    const b = boundary('alt')
    body = [`Content-Type: multipart/alternative; boundary="${b}"`, '', `--${b}`, textPart, `--${b}`, htmlPart, `--${b}--`].join('\r\n')
  }
  if (m.attachments?.length) {
    const b = boundary('mix')
    const files = m.attachments.map((a) => {
      const name = oneLine(a.filename).replace(/"/g, '')
      const encName = /^[\x20-\x7e]*$/.test(name) ? `"${name}"` : `"${encodeWord(name)}"`
      const b64 = a.content.toString('base64').replace(/.{76}/g, '$&\r\n')
      return [`Content-Type: ${a.contentType ?? 'application/octet-stream'}; name=${encName}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename=${encName}`, '', b64].join('\r\n')
    })
    body = [`Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, body, ...files.flatMap((f) => [`--${b}`, f]), `--${b}--`].join('\r\n')
  }
  // The body's own Content-Type line belongs with the message headers.
  const split = body.indexOf('\r\n\r\n')
  return `${head.join('\r\n')}\r\n${body.slice(0, split)}\r\n\r\n${body.slice(split + 4)}\r\n`
}

/** Re: once (not "Re: Re:"). */
export const replySubjectLine = (s: string): string => (/^\s*re:/i.test(s) ? s.trim() : `Re: ${s.trim()}`)
