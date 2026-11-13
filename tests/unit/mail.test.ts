import { describe, expect, test } from 'vitest'
import { resolve } from 'node:path'
import { Script } from 'node:vm'
import {
  buildSearchSpec, chunk, classifyMailError, cleanAddresses, formatMailId, formatMessage, formatPreview, formatSummaries,
  groupPreview, listUnsubscribe, parseMailId, parseMessage, parseScriptReply, parseSearchRows, parseWhen, previewSummary,
  quoteReply, replySubject, validateOrganize, MAIL_PERMISSION_HELP
} from '../../src/main/mail/core'
import { AppleEventQueue, MailNotRunning, mailRunner, type MailRunner } from '../../src/main/mail/runner'
import * as SCRIPTS from '../../src/main/mail/scripts'
import { APPLY, HEADERS, READ, SEARCH, DRAFT, SEND } from '../../src/main/mail/scripts'
import { gmailCodeSource, gmailPolicy, parseGmailSearch, parseGmailThread } from '../../src/main/mail/gmail'
import { mailTool, type MailArgs } from '../../src/main/agent/tools/mail'
import { pickCode, recentEmail, setEmailCodeSource } from '../../src/main/otp'
import { backoffMs, isConnectionError, toolPolicy, validateGoogleClient, GOOGLE_SETUP_NEEDED } from '../../src/main/connectors'
import type { ToolContext } from '../../src/main/agent/types'

// Pure parts of email: no osascript runs here (a fake runner stands in for Mail).

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)

describe('message ids', () => {
  test('round trip, including mailbox paths and accounts that are email addresses', () => {
    const id = formatMailId('sam@gmail.com', '[Gmail]/All Mail', 48213)
    expect(id).toBe('sam@gmail.com/[Gmail]/All Mail#48213')
    expect(parseMailId(id)).toEqual({ account: 'sam@gmail.com', mailbox: '[Gmail]/All Mail', num: 48213 })
    expect(parseMailId('iCloud/Clients/Acme#7')).toEqual({ account: 'iCloud', mailbox: 'Clients/Acme', num: 7 })
  })
  test('rejects ids that did not come from search', () => {
    for (const bad of ['', '48213', 'iCloud#5', '/INBOX#5', 'iCloud/#5', 'iCloud/INBOX#', 'iCloud/INBOX#-3', 'iCloud/INBOX#1.5']) expect(parseMailId(bad), bad).toBeNull()
  })
})

describe('search spec', () => {
  test('defaults, limits and trimming', () => {
    const s = buildSearchSpec({ from: '  jane@acme.com ', limit: 500 }, NOW)
    expect(s).toMatchObject({ from: 'jane@acme.com', limit: 50, scan: 50, unread: false, flagged: false, snippets: true, mailbox: null, since: null })
    expect(buildSearchSpec({}, NOW).limit).toBe(20)
    expect(buildSearchSpec({ limit: 0 }, NOW).limit).toBe(20)
  })
  test('body and recipient filters scan more candidates', () => {
    expect(buildSearchSpec({ text: 'invoice', limit: 10 }, NOW).scan).toBe(120)
    expect(buildSearchSpec({ to: 'bob', limit: 10 }, NOW).scan).toBe(250)
  })
  test('dates: ISO and relative spans; since must be before before', () => {
    expect(parseWhen('7d', NOW)).toBe(new Date(NOW - 7 * 864e5).toISOString())
    expect(parseWhen('24h', NOW)).toBe(new Date(NOW - 864e5).toISOString())
    expect(parseWhen('2026-11-01', NOW)).toBe('2026-11-01T00:00:00.000Z')
    expect(parseWhen('', NOW)).toBeNull()
    expect(() => parseWhen('last tuesday', NOW)).toThrow(/not a date/)
    expect(() => buildSearchSpec({ since: '2026-11-10', before: '2026-11-01' }, NOW)).toThrow(/earlier/)
  })
  test('control characters never reach the script', () => {
    expect(buildSearchSpec({ subject: 'a\u0000b\nc' }, NOW).subject).toBe('a b c')
  })
})

describe('script output', () => {
  test('ok, not running, error and garbage', () => {
    expect(parseScriptReply<number>('{"ok":true,"data":3}')).toEqual({ ok: true, data: 3 })
    expect(parseScriptReply('{"error":"not_running"}')).toMatchObject({ ok: false, notRunning: true })
    expect(parseScriptReply('{"error":"No mailbox named \\"X\\""}')).toEqual({ ok: false, error: 'No mailbox named "X"' })
    expect(parseScriptReply('')).toMatchObject({ ok: false })
    expect(parseScriptReply('execution error: -1743')).toMatchObject({ ok: false })
  })

  const rows = [
    { num: 11, date: '2026-11-12T08:00:00.000Z', from: 'Amazon <ship@amazon.com>', subject: 'Your order shipped', snippet: 'Track your package', unread: true, flagged: false, mailbox: 'INBOX', account: 'iCloud' },
    { num: 12, date: '2026-11-13T09:30:00.000Z', from: 'Jane <jane@acme.com>', subject: '', unread: false, flagged: true, mailbox: 'INBOX', account: 'Work' },
    { num: 'x', date: 'nope', from: 'bad', mailbox: 'INBOX', account: 'iCloud' },
    { num: 13, date: '2026-11-11T10:00:00.000Z', from: 'no account', mailbox: 'INBOX', account: '' },
    null
  ]
  test('search rows: newest first, invalid ones dropped, ids built', () => {
    const r = parseSearchRows(rows)
    expect(r.map((m) => m.id)).toEqual(['Work/INBOX#12', 'iCloud/INBOX#11'])
    expect(r[0]).toMatchObject({ subject: '(no subject)', flagged: true, unread: false })
    expect(r[1].snippet).toBe('Track your package')
    expect(parseSearchRows('nope')).toEqual([])
    const text = formatSummaries(r)
    expect(text).toContain('id: Work/INBOX#12')
    expect(text).toContain('[unread]')
    expect(formatSummaries([])).toBe('No messages match.')
  })

  test('a full message with attachments and unsubscribe options', () => {
    const raw = {
      ...rows[0], body: 'Hi Sam,\r\n\r\n\r\n\r\nYour order is on its way.', to: ['sam@icloud.com'], cc: [], replyTo: 'support@amazon.com',
      attachments: [{ name: 'invoice.pdf', size: 52_000 }, { bad: 1 }],
      headers: 'From: x\nList-Unsubscribe: <mailto:unsub@amazon.com?subject=stop>,\n <https://amazon.com/unsub?id=1>\nSubject: y'
    }
    const m = parseMessage(raw)!
    expect(m.body).toBe('Hi Sam,\n\nYour order is on its way.')
    expect(m.attachments).toEqual([{ name: 'invoice.pdf', size: 52_000 }])
    expect(m.unsubscribe).toEqual(['mailto:unsub@amazon.com?subject=stop', 'https://amazon.com/unsub?id=1'])
    const text = formatMessage(m)
    expect(text).toContain('Attachments: invoice.pdf (51 KB)')
    expect(text).toMatch(/never open them yourself/)
    expect(parseMessage({ ...raw, body: 'x'.repeat(50) }, 10)!.truncated).toBe(true)
    expect(parseMessage(null)).toBeNull()
  })

  test('List-Unsubscribe ignores javascript: and missing headers', () => {
    expect(listUnsubscribe('List-Unsubscribe: <javascript:alert(1)>, <https://ok.example/u>')).toEqual(['https://ok.example/u'])
    expect(listUnsubscribe('Subject: hi')).toEqual([])
  })
})

describe('drafts', () => {
  test('reply quoting', () => {
    const q = quoteReply('Sounds good, Thursday works.', { from: 'Jane <jane@acme.com>', date: '2026-11-12T15:00:00Z', text: 'Can we meet Thursday?\n> earlier quote' })
    expect(q.startsWith('Sounds good, Thursday works.\n\nOn ')).toBe(true)
    expect(q).toContain('Jane <jane@acme.com> wrote:\n> Can we meet Thursday?\n>> earlier quote')
    expect(quoteReply('ok', { from: 'x', date: '', text: 'y'.repeat(20) }, 5)).toContain('> yyyyy\n> […]')
  })
  test('reply subjects', () => {
    expect(replySubject('Hello')).toBe('Re: Hello')
    expect(replySubject('RE: Hello')).toBe('RE: Hello')
    expect(replySubject('')).toBe('Re: (no subject)')
  })
  test('addresses: plain only', () => {
    expect(cleanAddresses(['Jane <jane@acme.com>', 'a@b.co; c@d.org'], 'to')).toEqual(['jane@acme.com', 'a@b.co', 'c@d.org'])
    expect(() => cleanAddresses(['not an address'], 'to')).toThrow(/not an email address/)
    expect(cleanAddresses(undefined, 'cc')).toEqual([])
  })
})

describe('bulk organize', () => {
  const ids = ['iCloud/INBOX#1', 'iCloud/INBOX#2', 'iCloud/INBOX#3', 'Work/INBOX#4', 'Work/INBOX#5']
  test('validation', () => {
    const r = validateOrganize([
      { id: ids[0], action: 'move', target: 'Receipts' },
      { id: ids[1], action: 'move' },
      { id: 'bogus', action: 'archive' },
      { id: ids[2], action: 'explode' },
      { id: ids[0], action: 'archive' },
      { id: ids[3], action: 'delete', target: 'ignored' }
    ])
    expect(r.items).toEqual([{ id: ids[0], action: 'move', target: 'Receipts' }, { id: ids[3], action: 'delete' }])
    expect(r.problems).toHaveLength(4)
    expect(validateOrganize([]).problems[0]).toMatch(/non-empty/)
    expect(validateOrganize(Array.from({ length: 501 }, (_, i) => ({ id: `a/b#${i + 1}`, action: 'flag' }))).problems[0]).toMatch(/At most 500/)
  })
  test('preview grouped by action with samples, biggest group first', () => {
    const items = [
      { id: ids[0], action: 'move' as const, target: 'Receipts' }, { id: ids[1], action: 'move' as const, target: 'receipts' },
      { id: ids[2], action: 'move' as const, target: 'Receipts' }, { id: ids[3], action: 'archive' as const }, { id: ids[4], action: 'delete' as const }
    ]
    const h = Object.fromEntries(ids.map((id, i) => [id, { from: `Sender ${i}`, subject: `Subject ${i}` }]))
    const g = groupPreview(items, h, 2)
    expect(g.map((x) => [x.action, x.count])).toEqual([['move', 3], ['archive', 1], ['delete', 1]])
    expect(g[0].samples).toHaveLength(2)
    const text = formatPreview(g, ['Gone/INBOX#9'])
    expect(text).toContain('Preview: 5 messages, nothing changed yet.')
    expect(text).toContain('Move to "Receipts": 3')
    expect(text).toContain('…and 1 more')
    expect(text).toContain('Move to Trash: 1')
    expect(text).toContain('Not found (left out): 1 id')
    expect(previewSummary(g)).toMatch(/^Change 5 emails: Move to "Receipts" 3 \(e\.g\. "Subject 0" from Sender 0\); Archive 1/)
  })
  test('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('Mail errors and the Apple Events queue', () => {
  test('classifies osascript errors', () => {
    expect(classifyMailError('execution error: Not authorized to send Apple events to Mail. (-1743)')).toBe('permission')
    expect(classifyMailError("Mail got an error: Application isn't running. (-600)")).toBe('not_running')
    expect(classifyMailError('Command failed: timed out')).toBe('timeout')
    expect(classifyMailError('something else')).toBe('other')
  })

  test('runs jobs one at a time with a gap', async () => {
    let t = 0
    const log: string[] = []
    const q = new AppleEventQueue(100, () => t, async (ms) => { log.push(`sleep ${ms}`); t += ms })
    let running = 0
    const job = (n: number) => q.run(async () => { running++; expect(running).toBe(1); log.push(`job ${n}`); t += 10; running--; return n })
    expect(await Promise.all([job(1), job(2), job(3)])).toEqual([1, 2, 3])
    expect(log).toEqual(['sleep 100', 'job 1', 'sleep 100', 'job 2', 'sleep 100', 'job 3'])
  })

  test('runner: JSON in as an argument, errors mapped', async () => {
    const calls: string[][] = []
    const fast = new AppleEventQueue(0)
    const r = mailRunner(async (args) => { calls.push(args); return '{"ok":true,"data":{"n":1}}' }, fast)
    expect(await r.call<{ n: number }>('(i) => ({ n: 1 })', { q: 'it\'s "quoted"' })).toEqual({ n: 1 })
    expect(calls[0].slice(0, 2)).toEqual(['-l', 'JavaScript'])
    expect(calls[0][4]).toBe(JSON.stringify({ q: 'it\'s "quoted"', __launch: false }))
    expect(calls[0][3]).not.toContain('quoted')

    await expect(mailRunner(async () => '{"error":"not_running"}', fast).call('(i) => 1', {})).rejects.toBeInstanceOf(MailNotRunning)
    await expect(mailRunner(async () => { throw new Error('Not authorized to send Apple events (-1743)') }, fast).call('(i) => 1', {})).rejects.toThrow(MAIL_PERMISSION_HELP)
    await expect(mailRunner(async () => '{"error":"No mailbox named \\"Zed\\""}', fast).call('(i) => 1', {})).rejects.toThrow('No mailbox named "Zed"')
  })

  test('every Mail script compiles as JavaScript (checked with node, never run against Mail)', async () => {
    const scripts: string[] = []
    const r = mailRunner(async (args) => { scripts.push(args[3]); return '{"ok":true,"data":1}' }, new AppleEventQueue(0))
    for (const [name, fn] of Object.entries(SCRIPTS)) {
      await r.call(fn, {})
      expect(() => new Script(scripts.at(-1)!), name).not.toThrow()
    }
    expect(scripts).toHaveLength(8)
    // Only SEND calls send().
    expect(Object.entries(SCRIPTS).filter(([, fn]) => /\.send\(\)/.test(fn)).map(([n]) => n)).toEqual(['SEND'])
  })
})

// ------------------------------------------------------------------ the tool, with a fake Mail

function fakeRunner(opts: { running?: boolean } = {}) {
  const calls: Array<{ fn: string; input: any; launch?: boolean }> = []
  let running = opts.running ?? true
  const runner: MailRunner = {
    async call<T>(fn: string, input: any, o: { launch?: boolean } = {}): Promise<T> {
      calls.push({ fn, input, launch: o.launch })
      if (!running && !o.launch) throw new MailNotRunning()
      running = true
      if (fn === HEADERS) return { headers: Object.fromEntries(input.ids.filter((id: string) => !id.includes('#99')).map((id: string) => [id, { from: `From ${id}`, subject: `Subject ${id}` }])), missing: input.ids.filter((id: string) => id.includes('#99')) } as T
      if (fn === APPLY) return input.ops.map((op: { id: string }) => ({ id: op.id, ok: !op.id.endsWith('#3'), ...(op.id.endsWith('#3') ? { error: 'message not found' } : {}) })) as T
      if (fn === SEARCH) return { rows: [{ num: 5, date: '2026-11-13T09:00:00Z', from: 'Jane', subject: 'Hi', unread: true, flagged: false, mailbox: 'INBOX', account: 'iCloud' }], scanned: 1, more: false } as T
      if (fn === READ) return { num: 5, date: '2026-11-13T09:00:00Z', from: 'Jane <jane@acme.com>', subject: 'Lunch?', body: 'Lunch Friday?', mailbox: 'INBOX', account: 'iCloud', to: ['me@icloud.com'] } as T
      if (fn === DRAFT) return { saved: true } as T
      if (fn === SEND) return { sent: true } as T
      return [] as T
    }
  }
  return { runner, calls }
}

function ctx(answers: string[] = [], threadId = 't1'): ToolContext & { asked: string[] } {
  const asked: string[] = []
  return {
    threadId, signal: new AbortController().signal, workspaceDir: '/tmp', docsDir: '/tmp', state: { loaded: [], alwaysAllow: [], todos: [] },
    askUser: async (q) => { asked.push(q); return answers.shift() ?? 'Not now' },
    loadTools: () => [], searchTools: () => [], readResult: () => undefined, asked
  } as ToolContext & { asked: string[] }
}

describe('mail tool', () => {
  const effect = (t: ReturnType<typeof mailTool>, a: MailArgs): string => (typeof t.effect === 'function' ? t.effect(a, { roots: [] }) : t.effect)

  test('effects: reads run, filing is routine, delete is destructive, sending is a hard stop', () => {
    const t = mailTool(fakeRunner().runner)
    expect(t.untrusted).toBe(true)
    for (const a of ['accounts', 'mailboxes', 'search', 'read'] as const) expect(effect(t, { action: a })).toBe('read')
    expect(effect(t, { action: 'archive', id: 'a/b#1' })).toBe('write_external')
    expect(t.consequential!({ action: 'archive' }, { threadId: 't' })).toBe(false)
    expect(t.consequential!({ action: 'move' }, { threadId: 't' })).toBe(false)
    expect(effect(t, { action: 'delete', id: 'a/b#1' })).toBe('destructive')
    expect(t.consequential!({ action: 'delete' }, { threadId: 't' })).toBe(true)
    expect(effect(t, { action: 'create_draft' })).toBe('write_local')
    expect(effect(t, { action: 'send', to: ['a@b.co'] })).toBe('write_external')
    expect(t.consequential!({ action: 'send' }, { threadId: 't' })).toBe(true)
    expect(t.hardStop!({ action: 'send' })).toMatch(/sends an email/)
    expect(t.hardStop!({ action: 'create_draft' })).toBeNull()
    expect(effect(t, { action: 'organize', items: [] })).toBe('read')
    expect(t.describe!({ action: 'send', to: ['jane@acme.com'], subject: 'Lunch', body: 'Friday works' })).toBe('Send email to jane@acme.com: "Lunch" — "Friday works"')
  })

  test('organize: dry-run preview first, then approval with counts and samples, then apply once', async () => {
    const { runner, calls } = fakeRunner()
    const t = mailTool(runner)
    const items = [
      { id: 'iCloud/INBOX#1', action: 'move' as const, target: 'Receipts' }, { id: 'iCloud/INBOX#2', action: 'move' as const, target: 'Receipts' },
      { id: 'iCloud/INBOX#3', action: 'delete' as const }, { id: 'iCloud/INBOX#99', action: 'archive' as const }
    ]
    const c = ctx()
    const prev = await t.run({ action: 'organize', items }, c)
    expect(calls.map((x) => x.fn)).toEqual([HEADERS])
    expect(prev.text).toContain('nothing changed yet')
    expect(prev.text).toContain('Move to "Receipts": 2')
    expect(prev.text).toContain('Not found (left out): 1 id')
    const planId = /plan_id: (\w+)/.exec(prev.text)![1]

    const apply: MailArgs = { action: 'organize', apply: true, plan_id: planId }
    expect(effect(t, apply)).toBe('destructive')
    expect(t.hardStop!(apply)).toBe('bulk email change (3 messages)')
    expect(t.describe!(apply)).toMatch(/^Change 3 emails: Move to "Receipts" 2 \(e\.g\. "Subject iCloud\/INBOX#1"/)

    await expect(t.run(apply, ctx([], 'other-thread'))).rejects.toThrow(/another chat/)
    const done = await t.run(apply, c)
    expect(calls.filter((x) => x.fn === APPLY)[0].input.ops).toHaveLength(3)
    expect(done.text).toContain('Move to "Receipts": 2')
    expect(done.text).toContain('Failed (1):')
    expect(done.display).toBe('2 emails updated, 1 failed')
    await expect(t.run(apply, c)).rejects.toThrow(/expired/)
  })

  test('without a delete the bulk apply is an outside change, still a hard stop', async () => {
    const t = mailTool(fakeRunner().runner)
    const prev = await t.run({ action: 'organize', items: [{ id: 'a/INBOX#1', action: 'archive' }] }, ctx())
    const planId = /plan_id: (\w+)/.exec(prev.text)![1]
    expect(effect(t, { action: 'organize', apply: true, plan_id: planId })).toBe('write_external')
    expect(t.hardStop!({ action: 'organize', apply: true, plan_id: planId })).toMatch(/bulk email change \(1 messages\)/)
  })

  test('single changes cap at 20 ids and need valid ids', async () => {
    const t = mailTool(fakeRunner().runner)
    await expect(t.run({ action: 'flag', ids: Array.from({ length: 21 }, (_, i) => `a/b#${i + 1}`) }, ctx())).rejects.toThrow(/organize/)
    await expect(t.run({ action: 'flag', id: 'nope' }, ctx())).rejects.toThrow(/not a message id/)
    await expect(t.run({ action: 'move', id: 'a/b#1' }, ctx())).rejects.toThrow(/target/)
    const r = await t.run({ action: 'mark_read', ids: ['a/b#1', 'a/b#1', 'a/b#2'] }, ctx())
    expect(r.text).toBe('Done. Mark read: 2')
  })

  test('Mail closed: asks before opening it, and respects "Not now"', async () => {
    const closed = fakeRunner({ running: false })
    const c = ctx(['Not now'])
    await expect(mailTool(closed.runner).run({ action: 'search', unread: true }, c)).rejects.toThrow(/didn't open it/)
    expect(c.asked[0]).toMatch(/Open Mail/)
    expect(closed.calls.every((x) => !x.launch)).toBe(true)

    const again = fakeRunner({ running: false })
    const r = await mailTool(again.runner).run({ action: 'search', unread: true }, ctx(['Open Mail']))
    expect(again.calls.map((x) => x.launch)).toEqual([false, true])
    expect(r.text).toContain('id: iCloud/INBOX#5')
  })

  test('reply drafts quote the thread and never call send', async () => {
    const { runner, calls } = fakeRunner()
    const r = await mailTool(runner).run({ action: 'create_draft', mode: 'reply', reply_to: 'iCloud/INBOX#5', body: 'Friday works!' }, ctx())
    const draft = calls.find((x) => x.fn === DRAFT)!
    expect(draft.input.content).toMatch(/^Friday works!\n\nOn .+, Jane <jane@acme.com> wrote:\n> Lunch Friday\?/)
    expect(calls.some((x) => x.fn === SEND)).toBe(false)
    expect(r.text).toContain('NOT sent')
  })

  test('send validates recipients and body', async () => {
    const t = mailTool(fakeRunner().runner)
    await expect(t.run({ action: 'send', to: ['x'], body: 'hi' }, ctx())).rejects.toThrow(/not an email address/)
    await expect(t.run({ action: 'send', to: ['a@b.co'] }, ctx())).rejects.toThrow(/body/)
    await expect(t.run({ action: 'send', body: 'hi' }, ctx())).rejects.toThrow(/"to"/)
    expect((await t.run({ action: 'send', to: ['a@b.co'], subject: 'Hi', body: 'hi' }, ctx())).text).toBe('Sent to a@b.co ("Hi").')
  })
})

// ------------------------------------------------------------------ Gmail

describe('Gmail connector policy', () => {
  test('reads, routine label changes, destructive trash, sending is a hard stop', () => {
    for (const n of ['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft']) expect(gmailPolicy(n).effect, n).toBe('read')
    for (const n of ['label_message', 'unlabel_thread', 'update_message_labels', 'create_label', 'untrash_message', 'apply_sensitive_message_label']) expect(gmailPolicy(n), n).toEqual({ effect: 'write_external', consequential: false })
    for (const n of ['create_draft', 'update_draft']) expect(gmailPolicy(n), n).toEqual({ effect: 'write_external', consequential: false })
    for (const n of ['trash_message', 'trash_thread', 'delete_draft', 'delete_label']) expect(gmailPolicy(n).effect, n).toBe('destructive')
    for (const n of ['send_message', 'reply', 'forward', 'send_draft', 'reply_all']) {
      const p = gmailPolicy(n, { readOnlyHint: true })
      expect(p.effect, n).toBe('write_external')
      expect(p.consequential, n).toBe(true)
      expect(p.hardStop, n).toMatch(/sends email/)
    }
    expect(gmailPolicy('mark_message_spam').consequential).toBe(true)
    expect(gmailPolicy('unmark_message_spam').consequential).toBe(false)
    expect(gmailPolicy('mystery_tool')).toEqual({ effect: 'write_external', consequential: true })
    expect(gmailPolicy('mystery_tool', { readOnlyHint: true }).effect).toBe('read')
  })
  test('connectors use the Gmail map only for the Gmail preset', () => {
    expect(toolPolicy('gmail', 'reply').hardStop).toBeTruthy()
    expect(toolPolicy('slack', 'reply').hardStop).toBeUndefined()
    expect(toolPolicy('notion', 'notion-search').effect).toBe('read')
    expect(toolPolicy('slack', 'post_message', undefined, { text: 'hi' }).consequential).toBe(true)
  })
})

const SEARCH_FIXTURE = JSON.stringify({
  threads: [
    { id: 't-old', messages: [{ id: 'm0', sender: 'news@shop.com', subject: 'Sale', snippet: 'Save 20%', date: '2026-11-13T08:00:00Z' }] },
    { id: 't-acme', messageCount: 1, messages: [{ id: 'm1', sender: 'Acme <no-reply@acme.com>', subject: 'Your Acme sign-in code', snippet: 'Use this code to sign in', date: String(NOW - 2 * 60_000) }] },
    { id: 't-other', messages: [{ id: 'm2', sender: 'Bank <alerts@bank.com>', subject: 'Verification', snippet: 'Your verification code is 111222', date: new Date(NOW - 60_000).toISOString() }] }
  ]
})
const THREAD_FIXTURE = JSON.stringify({ id: 't-acme', messages: [{ id: 'm1', sender: 'Acme <no-reply@acme.com>', subject: 'Your Acme sign-in code', plaintextBody: 'Your verification code is 482913. It expires in 10 minutes.', date: String(NOW - 2 * 60_000) }] })

describe('Gmail parsing and emailed codes', () => {
  test('search and thread output', () => {
    const hits = parseGmailSearch(SEARCH_FIXTURE)
    expect(hits.map((h) => h.threadId)).toEqual(['t-other', 't-acme', 't-old'])
    expect(hits[1]).toMatchObject({ from: 'Acme <no-reply@acme.com>', at: NOW - 2 * 60_000, messageId: 'm1' })
    expect(parseGmailSearch('{}')).toEqual([])
    expect(parseGmailSearch('not json')).toEqual([])
    expect(parseGmailThread(THREAD_FIXTURE)[0].text).toContain('482913')
  })

  test('the code source reads the site\'s mail first, inside the window, bodies in main only', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const src = gmailCodeSource(async (tool, args) => { calls.push([tool, args]); return tool === 'search_threads' ? SEARCH_FIXTURE : THREAD_FIXTURE }, () => NOW)
    const msgs = await src(10, 'login.acme.com')
    expect(calls[0][0]).toBe('search_threads')
    expect(String(calls[0][1].query)).toContain('newer_than:1d')
    // The 4-hour-old newsletter is outside the 10-minute window.
    expect(msgs).toHaveLength(2)
    expect(calls[1]).toEqual(['get_thread', { threadId: 't-acme', messageFormat: 'PLAIN_TEXT' }])
    expect(pickCode(msgs, 'login.acme.com', NOW - 10 * 60_000)).toMatchObject({ code: '482913', from: 'Acme <no-reply@acme.com>', matched: 'domain' })
  })

  test('recentEmail: Gmail first, Mail.app as the fallback', async () => {
    const mailApp = async () => [{ from: 'mail.app', text: 'code 123456', at: NOW }]
    try {
      setEmailCodeSource(async () => [{ from: 'gmail', text: 'code 654321', at: NOW }], () => true)
      expect((await recentEmail(10, 'x.com', mailApp))[0].from).toBe('gmail')
      setEmailCodeSource(async () => [], () => true)
      expect((await recentEmail(10, 'x.com', mailApp))[0].from).toBe('mail.app')
      // Gmail answered with nothing and Mail is closed: "no code yet", not an error.
      expect(await recentEmail(10, 'x.com', async () => { throw new Error('Mail is not open') })).toEqual([])
      setEmailCodeSource(async () => { throw new Error('offline') }, () => true)
      await expect(recentEmail(10, 'x.com', async () => { throw new Error('Mail is not open') })).rejects.toThrow(/not open/)
      setEmailCodeSource(async () => [{ from: 'gmail', text: '', at: NOW }], () => false)
      expect((await recentEmail(10, 'x.com', mailApp))[0].from).toBe('mail.app')
    } finally {
      setEmailCodeSource(null)
    }
  })
})

// ------------------------------------------------------------------ connectors: Google setup and health

describe('Set up Google once', () => {
  const ID = '123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com'
  const SECRET = 'GOCSPX-abcdefghijklmnopqrstuvwx'
  test('client ID and secret format', () => {
    expect(validateGoogleClient(ID, SECRET)).toBeNull()
    expect(validateGoogleClient('', SECRET)).toMatch(/Paste the client ID/)
    expect(validateGoogleClient('abc.apps.googleusercontent.com', SECRET)).toMatch(/doesn't look like/)
    expect(validateGoogleClient(`${ID} `.replace(' ', ' x'), SECRET)).toMatch(/spaces/)
    expect(validateGoogleClient(ID, '')).toMatch(/secret too/)
    expect(validateGoogleClient(ID, 'short')).toMatch(/client secret/)
  })

  test('one client shared by Gmail, Calendar and Drive; Google apps refuse to connect without it', async () => {
    const { Connectors } = await import('../../src/main/connectors')
    const { ToolRegistry } = await import('../../src/main/agent/registry')
    const store = new Map<string, unknown>()
    const secrets = new Map<string, string>()
    const db = { getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) }
    const sec = { get: (k: string) => secrets.get(k), set: (k: string, v: string | null) => { if (v === null) secrets.delete(k); else secrets.set(k, v) } }
    const c = new Connectors(db as never, sec as never, new ToolRegistry(), () => undefined)
    expect(c.googleClient()).toBeNull()
    await expect(c.connectPreset('gmail')).rejects.toThrow(GOOGLE_SETUP_NEEDED)
    expect(() => c.save({ name: 'Gmail', kind: 'remote', url: 'https://gmailmcp.googleapis.com/mcp/v1', preset: 'gmail', enabled: true })).toThrow(GOOGLE_SETUP_NEEDED)
    expect(() => c.setGoogleClient('nope', SECRET)).toThrow()
    expect(c.setGoogleClient(ID, SECRET)).toEqual({ clientId: ID, hasSecret: true })
    expect(c.googleClient()).toEqual({ clientId: ID, hasSecret: true })
    // The secret stays in the Keychain store, never on the config.
    for (const p of ['gmail', 'gcal', 'gdrive']) {
      const cfg = c.save({ name: p, kind: 'remote', url: `https://${p}.example/mcp`, preset: p, enabled: true })
      expect(cfg.clientId).toBeUndefined()
    }
    expect(JSON.stringify(store.get('connectors'))).not.toContain('GOCSPX')
    c.clearGoogleClient()
    expect(c.googleClient()).toBeNull()
  })

  test('in-chat suggestions find apps by what they do', async () => {
    const { Connectors } = await import('../../src/main/connectors')
    const { ToolRegistry } = await import('../../src/main/agent/registry')
    const store = new Map<string, unknown>()
    const c = new Connectors({ getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) } as never, { get: () => undefined, set: () => undefined } as never, new ToolRegistry(), () => undefined)
    expect(c.suggest('gmail')[0].id).toBe('gmail')
    expect(c.suggest('semrush keyword research')[0].id).toBe('semrush')
    expect(c.suggest('seo').map((p) => p.id)).toContain('semrush')
    expect(c.suggest('send email').map((p) => p.id)).toContain('gmail')
    expect(c.suggest('with your files and data').length).toBe(0)
  })
})

describe('connector health', () => {
  test('backoff and connection errors', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5000, 15000, 45000, 135000])
    expect(backoffMs(20)).toBe(600000)
    expect(isConnectionError('TypeError: fetch failed')).toBe(true)
    expect(isConnectionError('read ECONNRESET')).toBe(true)
    expect(isConnectionError('Invalid arguments: query')).toBe(false)
  })

  test('Test connection times a tools/list; a server that went away is reconnected', async () => {
    const { Connectors } = await import('../../src/main/connectors')
    const { ToolRegistry } = await import('../../src/main/agent/registry')
    const store = new Map<string, unknown>()
    const registry = new ToolRegistry()
    const c = new Connectors({ getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) } as never, { get: () => undefined, set: () => undefined } as never, registry, () => undefined)
    const cfg = c.save({ name: 'Notes', kind: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-notes-server.mjs')], enabled: true })
    try {
      // Not live yet: Test connects (never opening a browser).
      const first = await c.test(cfg.id)
      expect(first.state).toBe('connected')
      const st = await c.test(cfg.id)
      expect(st.state).toBe('connected')
      expect(typeof st.latencyMs).toBe('number')
      expect(st.checkedAt).toBeGreaterThan(0)
      expect(c.presetConnected('notes')).toBe(false)
      await c.disconnect(cfg.id)
      expect(registry.all().some((t) => t.name.startsWith('notes__'))).toBe(false)
      expect((await c.test(cfg.id)).state).toBe('connected')
      expect(registry.all().some((t) => t.name.startsWith('notes__'))).toBe(true)
    } finally {
      await c.disconnect(cfg.id)
      c.stopHealth()
    }
  }, 30_000)
})
