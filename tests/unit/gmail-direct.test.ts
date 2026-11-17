import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildMail, decodeQuotedPrintable, decodeWords, encodeQuotedPrintable, encodeWord, htmlToText, parseMail, parseParams, rfc5322Date } from '../../src/main/mail/mime'
import { decodeMailbox, encodeMailbox, parseImapValues } from '../../src/main/mail/imap'
import { dotStuff } from '../../src/main/mail/smtp'
import { appPasswordProblem, explainGmailError, GMAIL_APP_PASSWORD_SECRET, normalizeAppPassword, replyRecipients, verifyGmail } from '../../src/main/mail/gmail-direct'
import { GoogleConnect, googleMailAccounts } from '../../src/main/mail/google-connect'
import { MailNotRunning } from '../../src/main/mail/runner'
import { gmailImapTool } from '../../src/main/agent/tools/gmail-imap'
import { sendRecipients } from '../../src/main/agent/trusted'
import type { ToolContext } from '../../src/main/agent/types'
import { GOOD, fakeImap, fakeSmtp, type FakeMessage } from '../fixtures/fake-gmail'

// Gmail with an app password: the MIME reader/writer, the IMAP and SMTP clients against local fake servers
// (plain TCP through the clients' connect seam: Google is never contacted), the gmail_imap tool, and the
// three-ways Google connect service.

const CRLF = '\r\n'
const alt = [
  'From: Amy <amy@example.com>', 'To: Sam <sam@gmail.com>', 'Cc: kim@example.com', 'Subject: =?UTF-8?B?Q2Fmw6kgdG9tb3Jyb3c/?=', 'Date: Tue, 17 Nov 2026 09:00:00 +0000',
  'Message-ID: <m11@example.com>', 'Reply-To: Amy Work <amy@work.example.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"', '',
  'preamble', '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
  'Caf=C3=A9 at 10? It=E2=80=99s on me. This line is long enough that it was wrapped with a soft line=', ' break.', '--b1',
  'Content-Type: text/html; charset=utf-8', '', '<p>Café at 10?</p>', '--b1--', ''
].join(CRLF)
const mixed = [
  'From: Bob <bob@example.com>', 'To: sam@gmail.com', 'Subject: Q3 report', 'Date: Tue, 17 Nov 2026 10:00:00 +0000', 'Message-ID: <m12@example.com>', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mix"', '', '--mix', 'Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'R=E9sum=E9 attached.', '--mix',
  'Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", '', Buffer.from('%PDF-1.4 fake').toString('base64'), '--mix--', ''
].join(CRLF)
const htmlOnly = [
  'From: news@shop.example', 'To: sam@gmail.com', 'Subject: Sale', 'Date: Mon, 16 Nov 2026 08:00:00 +0000', 'Message-ID: <m13@shop.example>', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('<html><head><style>p{}</style></head><body><p>Big&nbsp;sale &amp; more</p><a href="https://shop.example/x">See deals</a><script>evil()</script></body></html>').toString('base64'), ''
].join(CRLF)

describe('MIME', () => {
  test('multipart/alternative: QP plain text preferred, encoded-word subject, addresses', () => {
    const m = parseMail(alt)
    expect(m.subject).toBe('Café tomorrow?')
    expect(m.text).toBe('Café at 10? It’s on me. This line is long enough that it was wrapped with a soft line break.')
    expect(m.html).toContain('<p>')
    expect(m.from).toBe('Amy <amy@example.com>')
    expect(m.to).toEqual(['Sam <sam@gmail.com>'])
    expect(m.cc).toEqual(['kim@example.com'])
    expect(m.attachments).toEqual([])
  })
  test('multipart/mixed: Latin-1 text, a base64 attachment with an RFC 2231 name', () => {
    const m = parseMail(mixed)
    expect(m.text).toBe('Résumé attached.')
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0]).toMatchObject({ index: 0, filename: 'résumé.pdf', contentType: 'application/pdf' })
    expect(m.attachments[0].content.toString()).toBe('%PDF-1.4 fake')
  })
  test('HTML only: stripped to text (no scripts or styles), links kept', () => {
    expect(parseMail(htmlOnly).text).toBe('Big sale & more\nSee deals (https://shop.example/x)')
    expect(htmlToText('<li>one</li><li>two</li>')).toBe('• one\n• two')
  })
  test('the small pieces', () => {
    expect(decodeWords('=?ISO-8859-1?Q?Andr=E9?= =?UTF-8?B?IOKcjA==?=')).toBe('André ✌')
    expect(decodeQuotedPrintable('a=3Db=\r\nc').toString()).toBe('a=bc')
    expect(parseParams('text/plain; charset="utf-8"; name=a.txt')).toEqual({ value: 'text/plain', params: { charset: 'utf-8', name: 'a.txt' } })
    expect(parseParams("attachment; filename*0*=UTF-8''%C3%A9t%C3%A9; filename*1=.txt").params.filename).toBe('été.txt')
    const qp = encodeQuotedPrintable(`${'é'.repeat(60)} ${'x'.repeat(100)}`)
    expect(qp.split(CRLF).every((l) => l.length <= 76)).toBe(true)
    expect(decodeQuotedPrintable(qp).toString('utf8')).toBe(`${'é'.repeat(60)} ${'x'.repeat(100)}`)
    expect(encodeWord('plain')).toBe('plain')
    expect(decodeWords(encodeWord('Re: Ünïcödé subject that is quite long indeed ✓'))).toBe('Re: Ünïcödé subject that is quite long indeed ✓')
    expect(rfc5322Date(new Date(Date.UTC(2026, 10, 17, 9, 5, 0)))).toBe('Tue, 17 Nov 2026 09:05:00 +0000')
    expect(dotStuff('a\n.b\n..c')).toBe('a\r\n..b\r\n...c')
  })
  test('writing: RFC 5322 headers, UTF-8 subject, reply threading, attachments; never a Bcc header; no header injection', () => {
    const raw = buildMail({ from: 'Sam <sam@gmail.com>', to: ['Amy <amy@example.com>'], subject: 'Re: Café\r\nBcc: eve@evil.com', text: 'Sounds good.\n.\nSam', inReplyTo: '<m11@example.com>', references: '<m11@example.com>', attachments: [{ filename: 'notes.txt', content: Buffer.from('hi') }], date: new Date(Date.UTC(2026, 10, 17)) })
    expect(raw).toMatch(/^From: Sam <sam@gmail\.com>\r\nTo: Amy <amy@example\.com>\r\n/)
    expect(raw).toMatch(/\r\nSubject: =\?UTF-8\?B\?/)
    expect(raw).toMatch(/\r\nMessage-ID: <[0-9a-f-]+@gmail\.com>\r\n/)
    expect(raw).toContain('\r\nIn-Reply-To: <m11@example.com>\r\nReferences: <m11@example.com>\r\n')
    expect(raw).toContain('Date: Tue, 17 Nov 2026 00:00:00 +0000')
    expect(raw).not.toMatch(/^Bcc:/im)
    const back = parseMail(raw)
    expect(back.subject).toBe('Re: Café Bcc: eve@evil.com')
    expect(back.text).toBe('Sounds good.\n.\nSam')
    expect(back.attachments[0]).toMatchObject({ filename: 'notes.txt', size: 2 })
    expect(back.inReplyTo).toBe('<m11@example.com>')
  })
})

describe('IMAP pieces', () => {
  test('response values: lists, quoted strings, NIL, bracketed section atoms, literals', () => {
    const v = parseImapValues('(UID 7 FLAGS (\\Seen \\Flagged) X-GM-LABELS (\\Inbox "My Label") BODY[HEADER.FIELDS (FROM SUBJECT)] \u00010\u0001 INTERNALDATE "17-Nov-2026 09:00:00 +0000" X NIL)', [Buffer.from('From: a')])
    const items = v[0] as unknown[]
    expect(items.slice(0, 6)).toEqual(['UID', '7', 'FLAGS', ['\\Seen', '\\Flagged'], 'X-GM-LABELS', ['\\Inbox', 'My Label']])
    expect(items[6]).toBe('BODY[HEADER.FIELDS (FROM SUBJECT)]')
    expect((items[7] as Buffer).toString()).toBe('From: a')
    expect(items[11]).toBeNull()
  })
  test('modified UTF-7 mailbox names', () => {
    expect(encodeMailbox('Entwürfe')).toBe('Entw&APw-rfe')
    expect(decodeMailbox('Entw&APw-rfe')).toBe('Entwürfe')
    expect(encodeMailbox('A&B')).toBe('A&-B')
    expect(decodeMailbox(encodeMailbox('日本語 mail'))).toBe('日本語 mail')
  })
  test('app passwords: 16 letters, spaces optional', () => {
    expect(normalizeAppPassword('abcd efgh ijkl mnop')).toBe('abcdefghijklmnop')
    expect(appPasswordProblem('ABCD EFGH IJKL MNOP')).toBeNull()
    expect(appPasswordProblem('abcd efgh ijkl')).toMatch(/16 letters.*12/)
    expect(appPasswordProblem('abcd efgh ijkl mn0p')).toMatch(/not only letters/)
    expect(explainGmailError(new Error('[ALERT] Application-specific password required'))).toMatch(/app password/)
    expect(explainGmailError(new Error('[AUTHENTICATIONFAILED] Invalid credentials (Failure)'))).toMatch(/IMAP is on/)
    expect(explainGmailError(new Error('535 5.7.8 Username and Password not accepted'))).toMatch(/didn't accept/)
  })
})

describe('gmail_imap against fake Gmail servers', () => {
  const messages: FakeMessage[] = [
    { uid: 11, raw: alt, flags: [], labels: ['\\Inbox'] },
    { uid: 12, raw: mixed, flags: ['\\Seen'], labels: ['\\Inbox', 'Work'] },
    { uid: 13, raw: htmlOnly, flags: [], labels: [] }
  ]
  const imap = fakeImap(messages)
  const smtp = fakeSmtp()
  const ws = mkdtempSync(join(tmpdir(), 'gmail-ws-'))
  let creds: { user: string; pass: string } | null = GOOD
  const tool = gmailImapTool({ creds: () => creds, transport: { imap: imap.connect, smtp: smtp.connect } })
  const ctx = { threadId: 't', signal: new AbortController().signal, workspaceDir: ws, docsDir: ws, state: { loaded: [], alwaysAllow: [], todos: [] }, askUser: async () => '', loadTools: () => [], searchTools: () => [], readResult: () => undefined } as unknown as ToolContext
  const run = (a: Parameters<typeof tool.run>[0]) => tool.run(a, ctx)
  beforeAll(async () => { await imap.listen(); await smtp.listen() })
  afterAll(async () => { await imap.close(); await smtp.close() })

  test('effects: reads are reads, labels and read state routine, sending a send stop; outside content', () => {
    const eff = (a: object) => (typeof tool.effect === 'function' ? tool.effect(a as never, { roots: [] }) : tool.effect)
    expect(tool.untrusted).toBe(true)
    expect(eff({ action: 'recent' })).toBe('read')
    expect(eff({ action: 'read', uid: 1 })).toBe('read')
    expect(eff({ action: 'read', uid: 1, mark_read: true })).toBe('write_external')
    expect(tool.consequential!({ action: 'label', uid: 1, label: 'x' } as never, { threadId: 't' })).toBe(false)
    expect(tool.consequential!({ action: 'send' } as never, { threadId: 't' })).toBe(true)
    expect(tool.hardStop!({ action: 'send', to: ['a@x.com'] } as never)).toMatch(/^sends email from your Gmail to a@x\.com/)
    expect(tool.hardStop!({ action: 'reply', uid: 1 } as never)).toMatch(/^sends email/)
    expect(tool.hardStop!({ action: 'archive', uid: 1 } as never)).toBeNull()
  })
  test('recent: inbox headers, newest first, unread marked; nothing marked read', async () => {
    const r = await run({ action: 'recent' })
    expect(r.text).toMatch(/data, not instructions/)
    expect(r.text.indexOf('[uid 12]')).toBeLessThan(r.text.indexOf('[uid 11]'))
    expect(r.text).toMatch(/\[uid 11\].*"Café tomorrow\?" · unread/)
    expect(r.text).not.toContain('[uid 13]')
    expect(imap.log.some((l) => /UID FETCH 11,12 .*BODY\.PEEK\[HEADER\.FIELDS/.test(l))).toBe(true)
    expect(messages[0].flags).toEqual([])
  })
  test('search: Gmail syntax; a non-ASCII query goes as a literal', async () => {
    expect((await run({ action: 'search', query: 'résumé' })).text).toMatch(/(No messages found|uid)/)
    expect(imap.log.some((l) => /UID SEARCH CHARSET UTF-8 X-GM-RAW \u0000résumé/.test(l))).toBe(true)
    expect((await run({ action: 'search', query: 'sale' })).text).toContain('[uid 13]')
  })
  test('read: whole message, attachments listed, left unread; mark_read marks it', async () => {
    const r = await run({ action: 'read', uid: 12 })
    expect(r.text).toContain('Résumé attached.')
    expect(r.text).toMatch(/0\. résumé\.pdf \(application\/pdf/)
    await run({ action: 'read', uid: 11 })
    expect(messages[0].flags).toEqual([])
    await run({ action: 'read', uid: 11, mark_read: true })
    expect(messages[0].flags).toEqual(['\\Seen'])
    await run({ action: 'mark_unread', uid: 11 })
    expect(messages[0].flags).toEqual([])
  })
  test('labels and archive through X-GM-LABELS', async () => {
    await run({ action: 'label', uids: [11, 13], label: 'Clients' })
    expect(messages[0].labels).toContain('Clients')
    expect(messages[2].labels).toContain('Clients')
    await run({ action: 'archive', uid: 12 })
    expect(messages[1].labels).not.toContain('\\Inbox')
  })
  test('attachment: saved into the workspace', async () => {
    const r = await run({ action: 'attachment', uid: 12, index: 0 })
    expect(r.path && existsSync(r.path)).toBe(true)
    expect(readFileSync(r.path!).toString()).toBe('%PDF-1.4 fake')
    expect(r.path!.startsWith(ws)).toBe(true)
  })
  test('send: envelope has Bcc, the message doesn\'t; dot-stuffed; the password never shows', async () => {
    smtp.mails.length = 0
    const r = await run({ action: 'send', to: ['amy@example.com'], bcc: ['boss@example.com'], subject: 'Plan', body: 'Hi Amy,\n.\nSee you' })
    expect(r.text).toMatch(/Sent from sam@gmail\.com to amy@example\.com, boss@example\.com/)
    expect(smtp.mails[0].from).toBe('sam@gmail.com')
    expect(smtp.mails[0].to).toEqual(['amy@example.com', 'boss@example.com'])
    expect(smtp.mails[0].data).not.toMatch(/^Bcc:/im)
    expect(smtp.mails[0].data).toContain('\r\n..\r\n')
    expect(r.text).not.toContain(GOOD.pass)
    // Who it reaches is known up front, so the trusted-recipient rule can apply; a reply's isn't.
    expect(sendRecipients('gmail_imap', { action: 'send', to: ['amy@example.com'], bcc: ['boss@example.com'] })).toEqual(['e:amy@example.com', 'e:boss@example.com'])
  })
  test('reply: to Reply-To, threaded with In-Reply-To and References, Re: once', async () => {
    smtp.mails.length = 0
    await run({ action: 'reply', uid: 11, body: 'Yes!', all: true })
    const d = smtp.mails[0].data
    expect(smtp.mails[0].to).toEqual(['amy@work.example.com', 'kim@example.com'])
    expect(d).toContain('In-Reply-To: <m11@example.com>')
    expect(d).toContain('References: <m11@example.com>')
    expect(parseMail(d).subject).toBe('Re: Café tomorrow?')
    expect(replyRecipients(parseMail(alt), 'sam@gmail.com', false)).toEqual({ to: ['Amy Work <amy@work.example.com>'], cc: [] })
  })
  test('sign-in errors in plain words; nothing connected means a clear message', async () => {
    creds = { user: GOOD.user, pass: 'wrongwrongwrongw' }
    await expect(run({ action: 'recent' })).rejects.toThrow(/didn't accept that address and app password/)
    creds = { user: 'needs-app@gmail.com', pass: GOOD.pass }
    await expect(run({ action: 'send', to: ['a@x.com'], body: 'x' })).rejects.toThrow(/app password here, not your regular Google password/)
    creds = null
    await expect(run({ action: 'recent' })).rejects.toThrow(/Connect apps → Gmail/)
    creds = GOOD
    await expect(verifyGmail({ user: GOOD.user, pass: 'nopenopenopenope' }, { imap: imap.connect })).rejects.toThrow(/IMAP is on/)
    // The password never reaches the IMAP log in another form than the LOGIN it was sent with.
    expect(imap.log.filter((l) => l.includes(GOOD.pass)).every((l) => /^S\d+ LOGIN /.test(l))).toBe(true)
  })

  test('Connect Google: Mail app detection, app password (verified, Keychain only), disconnect', async () => {
    expect(googleMailAccounts([
      { name: 'Google', emails: ['Sam@Gmail.com'], type: 'imap', server: 'imap.gmail.com' },
      { name: 'Work', emails: ['sam@acme.com'], type: 'imap', server: 'imap.gmail.com' },
      { name: 'iCloud', emails: ['sam@icloud.com'], type: 'iCloud', server: 'p01-imap.mail.me.com' },
      { name: 'Old', emails: ['sam@gmail.com'], enabled: false }
    ])).toEqual([{ account: 'Google', address: 'sam@gmail.com' }, { account: 'Work', address: 'sam@acme.com' }])
    const store = new Map<string, unknown>()
    const secrets = new Map<string, string>()
    let mailOpen = true
    const g = new GoogleConnect({
      db: { getSetting: (k) => store.get(k) as never, setSetting: (k, v) => void store.set(k, v) },
      secrets: { get: (k) => secrets.get(k), set: (k, v) => { if (v) secrets.set(k, v); else secrets.delete(k) } },
      runner: { call: async () => { if (!mailOpen) throw new MailNotRunning(); return [{ name: 'Google', emails: ['sam@gmail.com'], server: 'imap.gmail.com' }] as never } },
      oauth: () => ({ builtin: false, ownClient: false, connected: false }),
      transport: { imap: imap.connect }
    })
    expect(await g.status()).toMatchObject({ link: null, mail: [{ address: 'sam@gmail.com' }], mailOpen: true, oauth: { builtin: false } })
    await expect(g.useAppPassword('sam@gmail.com', 'short')).rejects.toThrow(/16 letters/)
    await expect(g.useAppPassword(GOOD.user, 'wron gwro ngwr ongw')).rejects.toThrow(/didn't accept/)
    expect(secrets.size).toBe(0)
    const link = await g.useAppPassword(' Sam@Gmail.com ', 'abcd efgh ijkl mnop')
    expect(link).toMatchObject({ method: 'app-password', address: 'sam@gmail.com' })
    expect(secrets.get(GMAIL_APP_PASSWORD_SECRET)).toBe(GOOD.pass)
    expect(JSON.stringify([...store.values()])).not.toContain(GOOD.pass)
    expect(g.credentials()).toEqual(GOOD)
    expect(JSON.stringify(await g.status())).not.toContain(GOOD.pass)
    // Switching to the Mail app forgets the password.
    expect(await g.useMail('sam@gmail.com')).toMatchObject({ method: 'mail', address: 'sam@gmail.com' })
    expect(secrets.size).toBe(0)
    expect(g.credentials()).toBeNull()
    mailOpen = false
    expect((await g.status()).mailOpen).toBe(false)
    await expect(g.useMail('sam@gmail.com')).rejects.toThrow(/Open the Mail app/)
    g.disconnect()
    expect((await g.status()).link).toBeNull()
  })
})
