import { execFile } from 'node:child_process'
import { classifyMailError, MAIL_PERMISSION_HELP, parseScriptReply, type ScriptReply } from './core'

// Runs Mail's JavaScript-for-Automation scripts one at a time, with a short gap between them, so a
// bulk job never floods Mail with Apple Events. JSON goes in as an argument and comes back on stdout:
// no user text is ever spliced into a script.

export class MailNotRunning extends Error {
  constructor() { super('Mail is not open.') }
}

export type Exec = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>

const osascript: Exec = (args, timeoutMs, signal) => new Promise((ok, fail) => {
  execFile('osascript', args, { timeout: timeoutMs, signal, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) fail(new Error((stderr || err.message).toString().trim().slice(0, 600)))
    else ok(stdout.toString())
  })
})

/** A serial queue with a minimum gap between jobs (Apple Events rate limit). */
export class AppleEventQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private last = 0

  constructor(private gapMs = 150, private now: () => number = Date.now, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      const wait = this.last + this.gapMs - this.now()
      if (wait > 0) await this.sleep(wait)
      try { return await job() } finally { this.last = this.now() }
    })
    this.tail = next
    return next
  }
}

/** Shared helpers every Mail script gets (mailbox lookup by path, message lookup by id, one-line summaries). */
const PRELUDE = String.raw`
const Mail = Application('Mail');
const boxCache = {};
function accountsFor(name) {
  if (!name) return Mail.accounts();
  const hit = Mail.accounts().filter((a) => { try { return a.name() === name } catch (e) { return false } });
  if (!hit.length) throw new Error('No Mail account named "' + name + '"');
  return hit;
}
function walk(container, prefix, out, depth) {
  let kids = [];
  try { kids = container.mailboxes() } catch (e) { return out }
  for (const b of kids) {
    let n = '';
    try { n = b.name() } catch (e) { continue }
    const full = prefix && n.indexOf('/') < 0 ? prefix + '/' + n : n;
    if (!out.some((x) => x.path === full)) out.push({ box: b, path: full, leaf: n.split('/').pop() });
    if (depth < 6) walk(b, full, out, depth + 1);
  }
  return out;
}
function boxesOf(account) { return walk(account, '', [], 0) }
function findBox(accountName, path) {
  const key = accountName + '\u0000' + path;
  if (boxCache[key]) return boxCache[key];
  const want = String(path).toLowerCase();
  for (const a of accountsFor(accountName)) {
    const all = boxesOf(a);
    const hit = all.find((x) => x.path.toLowerCase() === want) || all.find((x) => x.leaf.toLowerCase() === want) ||
      (want === 'inbox' ? all.find((x) => x.path.toLowerCase() === 'inbox') : null);
    if (hit) { boxCache[key] = hit.box; return hit.box }
  }
  return null;
}
function findBoxAny(accountName, names) {
  for (const n of names) { const b = findBox(accountName, n); if (b) return b }
  return null;
}
function locate(id) {
  const s = String(id); const h = s.lastIndexOf('#'); const head = s.slice(0, h); const slash = head.indexOf('/');
  const account = head.slice(0, slash), mailbox = head.slice(slash + 1), num = Number(s.slice(h + 1));
  const box = findBox(account, mailbox);
  if (!box) throw new Error('mailbox not found');
  let m = null;
  try { m = box.messages.byId(num); m.id() } catch (e) { m = null }
  if (!m) { const r = box.messages.whose({ id: num })(); m = r.length ? r[0] : null }
  if (!m) throw new Error('message not found (moved or deleted?)');
  return { m: m, account: account };
}
function where(m) {
  let mailbox = '', account = '';
  try { const b = m.mailbox(); mailbox = b.name(); account = b.account().name() } catch (e) {}
  return { mailbox: mailbox, account: account };
}
function row(m, snippet) {
  const w = where(m);
  const r = { num: m.id(), date: m.dateReceived() ? m.dateReceived().toISOString() : null, from: m.sender(), subject: m.subject(),
    unread: !m.readStatus(), flagged: m.flaggedStatus(), mailbox: w.mailbox, account: w.account };
  if (snippet) { try { r.snippet = String(m.content() || '').replace(/\s+/g, ' ').slice(0, 300) } catch (e) {} }
  return r;
}
`

export interface MailRunner {
  /** Runs one Mail script function `(input) => data` and returns its data; throws MailNotRunning when Mail is closed (unless launch). */
  call<T>(fn: string, input: unknown, opts?: { signal?: AbortSignal; launch?: boolean; timeoutMs?: number }): Promise<T>
}

export function mailRunner(exec: Exec = osascript, queue = new AppleEventQueue()): MailRunner {
  return {
    call<T>(fn: string, input: unknown, opts: { signal?: AbortSignal; launch?: boolean; timeoutMs?: number } = {}): Promise<T> {
      // Mail is only started when the user said yes (launch); otherwise a closed Mail is reported, not opened.
      const script = `function run(argv) {
  const input = JSON.parse(argv[0]);
  const M = Application('Mail');
  if (!M.running()) {
    if (!input.__launch) return JSON.stringify({ error: 'not_running' });
    M.launch(); let n = 0; while (!M.running() && n < 40) { delay(0.5); n++ } delay(1.5);
  }
  ${PRELUDE}
  try { return JSON.stringify({ ok: true, data: (${fn})(input) }) } catch (e) { return JSON.stringify({ error: String(e && e.message || e).slice(0, 400) }) }
}`
      return queue.run(async () => {
        let out: string
        try {
          out = await exec(['-l', 'JavaScript', '-e', script, JSON.stringify({ ...(input as object), __launch: !!opts.launch })], opts.timeoutMs ?? 60_000, opts.signal)
        } catch (e) {
          const kind = classifyMailError((e as Error).message)
          if (kind === 'permission') throw new Error(MAIL_PERMISSION_HELP)
          if (kind === 'not_running') throw new MailNotRunning()
          if (kind === 'timeout') throw new Error('Mail took too long to answer (a large mailbox?). Try a narrower search: a mailbox, a sender or a date range.')
          throw e
        }
        const r: ScriptReply<T> = parseScriptReply<T>(out)
        if (r.ok) return r.data
        if (r.notRunning) throw new MailNotRunning()
        if (classifyMailError(r.error) === 'permission') throw new Error(MAIL_PERMISSION_HELP)
        throw new Error(r.error)
      })
    }
  }
}
