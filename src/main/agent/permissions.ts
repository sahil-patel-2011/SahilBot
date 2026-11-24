import type { PermissionMode, ToolEffect } from '@shared/types'
import type { Decision, PermissionInput } from './types'

// Three levels: Ask (every change asks), Auto (the default: it does nearly everything itself; buying, credentials
// off their own site and actions steered by outside content ask) and Bypass (everything runs, except purchases,
// saved logins off their own site and one-time codes).
// 'autonomous' is the old name of what Auto does now: still read (older chats, settings, handoffs), and
// treated exactly as Auto everywhere (normalizeMode); migratePermissionLevels (spaces.ts) rewrites stored values once.
const STRICTNESS: Record<PermissionMode, number> = { ask: 3, auto: 2, autonomous: 2, bypass: 0 }

/** The levels the user can pick, strictest first. */
export const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto', 'bypass']
export const isPermissionMode = (m: unknown): m is PermissionMode => typeof m === 'string' && m in STRICTNESS
/** The level a stored mode means today: 'autonomous' (older chats and settings) is Auto. */
export const normalizeMode = (m: PermissionMode): Exclude<PermissionMode, 'autonomous'> => (m === 'autonomous' ? 'auto' : m)

/**
 * Tools that only write inside the workspace and attached folders, and keep a backup when they overwrite
 * something (files.ts backup()). Auto runs their overwrites; deleting still asks (a hard stop).
 */
export const BACKED_UP_OVERWRITES = new Set(['file_write', 'file_edit', 'file_manage', 'create_document'])

/** The stricter of two permission modes (ask > auto > bypass). A missing one doesn't loosen anything. */
export function stricterMode(a: PermissionMode, b?: PermissionMode | null): PermissionMode {
  if (!b || !(b in STRICTNESS)) return normalizeMode(a)
  return STRICTNESS[b] > STRICTNESS[a] ? normalizeMode(b) : normalizeMode(a)
}

/**
 * A hard stop about typing a saved credential (a login, an ID number, a password field), or recording what you
 * type (which can include passwords). Like purchases and one-time codes, it asks even in Bypass with hard stops switched off: credentials always need the user.
 */
export const isCredentialStop = (s: string | null | undefined): boolean =>
  typeof s === 'string' && /\b(saved login|saved ID|password field|secret scan flagged|recording what you click and type)\b/i.test(s)

/** Money words in the description of an outside step (a page's button, an app's action, a paid render). */
const MONEY = /\b(pay|pays|paying|payments?|payouts?|purchases?|buy|buying|checkout|check out|place (your |an )?order|order now|refunds?|transfer funds|send money|subscribe|subscriptions?|donate|donations?)\b|\b\d[\d,.]*\s+(\w+\s+)?credits\b/i
/** A price on a page's button ("Next $5"): only the browser's descriptions are checked for one. */
const PRICE = /[$€£]\s?\d/

/**
 * Built-in tools that work on this Mac or in the user's own mail, files and chats: they can't spend money by
 * themselves, so only their name counts, never their description. A command (`git checkout`, `awk '{print $2}'`,
 * `cd payments-api`), an email body ("total $313.20", "quick tip") or a reminder ("Pay rent") is not a purchase.
 */
const NO_SPEND_TOOLS = new Set(['run_command', 'git', 'code', 'jobs', 'file_read', 'file_write', 'file_edit', 'file_manage', 'create_document',
  'doc_create', 'doc_edit', 'doc_export', 'doc_read', 'office', 'review_document', 'read_document_image', 'mail', 'gmail_imap', 'resend', 'mac',
  'mac_apps', 'computer', 'ask_on_mac', 'schedule', 'memory', 'vault', 'todo', 'goal', 'follow_up', 'propose_plan', 'propose_idea', 'update_bot',
  'create_bot', 'manage_bot', 'finish_setup', 'message_bot', 'ask_bot', 'bots_overview', 'undo_changes', 'create_page', 'update_page', 'sites',
  'names', 'knowledge_search', 'knowledge_status', 'chat_history', 'maps', 'price_alert', 'stock_quote', 'stock_analyze', 'stock_compare',
  'stock_forecast', 'stock_backtest', 'swarm', 'batch', 'agents', 'consult', 'research', 'manual', 'about', 'find_tools', 'ask_user', 'image',
  'speech', 'transcribe', 'web_search', 'fetch_page', 'read_result', 'phi_scan', 'frc_code', 'frc_mech', 'freecad', 'onshape', 'cursor',
  'connect_app', 'max'])

/**
 * Does this step spend money? From the tool's name (create_refund, submit_order, venmo_send) for every tool; for a
 * step on a site or in a connected app (the browser, api_request, a paid render, an app's tool) also from its own
 * description and its stop note. Callers only ask this for steps that aren't reads (get_orders never asks).
 */
export function spendsMoney(tool: string, summary?: string | null, hardStop?: string | null): boolean {
  if (isSelfGated(hardStop)) return false
  // createRefund / stripe__create_refund / capture_order all read as words.
  const name = tool.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ')
  if (MONEY_NAME.test(name) && !NOT_MONEY_NAME.test(name)) return true
  // A stop note that says so in so many words ("moves money or buys something"), whatever the tool.
  if (MONEY_STOP.test(hardStop ?? '')) return true
  if (NO_SPEND_TOOLS.has(tool)) return false
  // An app's tool: its title, not the arguments after it ('Slack: post message {"text":"Pay rent?"}').
  const said = tool.includes('__') ? String(summary ?? '').split('{')[0] : String(summary ?? '')
  if (MONEY.test(said) || (tool === 'browser' && PRICE.test(said))) return true
  // A raw API call that isn't a read: its endpoint says what it does (POST …/v1/charges, /refunds, /orders).
  if (tool === 'api_request' && said && !/^\s*(GET|HEAD|OPTIONS)\b/i.test(said) && MONEY_NAME.test(said.replace(/[_\-./]+/g, ' '))) return true
  return MONEY.test(hardStop ?? '') || MONEY_NOTE.test(hardStop ?? '')
}
/** Money in a tool's name: paying, refunds, charges, orders, bookings, rentals, bets, top-ups, trades, P2P payments. */
const MONEY_NAME = /\b(pay|pays|paying|payments?|payouts?|purchases?|buy|buying|checkout|check ?out|refunds?|charges?|transfers?|wire|send money|subscribe|subscriptions?|donate|donations?|tip|bid|credits?|capture|reimburse|reimbursement|beneficiary|payee|conversion|convert|fx|quote lock|mandate|orders?|book|booking|reserve|reservation|rent|rental|lease|bet|wager|top ?up|upgrade|renew|renewal|venmo|zelle|cash ?app|paypal|ride|hire|trade|trading|sell|withdraw|withdrawal|swap|stake|staking|deposit|send crypto)\b/i
/** The phrases connectors.ts and the apps' own stop notes use for money (never a user's file or command text). */
const MONEY_STOP = /\b(moves? (your )?money|buys? something|adds? a payee|spends? money)\b/i
/** Names that only look like money: an address book, booking a meeting, a sort order. */
const NOT_MONEY_NAME = /\b(address|phone|note|face|guest|work) book\b|\bbook (a )?(meeting|call|demo|appointment|slot|time)\b|\b(sort|display|tab|column|sequence) order\b/i
/** A connected app's own stop notes for money ("moves money or buys something", "adds a payee", "takes, refunds…"). */
const MONEY_NOTE = /\b(money|buys?|payee|funds)\b/i

/** A file step outside the workspace and your attached folders (files.ts outsideStop). */
export const isOutsideStop = (s: string | null | undefined): boolean => typeof s === 'string' && /, outside your folders$/.test(s)
/**
 * A terminal command that changes the Mac itself (sudo, launchctl, defaults write, crontab, security, tccutil…,
 * shell.ts systemReason). The file-write sandbox can't hold these (launchd, cfprefsd and the security daemons do the
 * writing), and ordinary work never needs them, so Auto asks. Read-only uses (defaults read) never get this stop.
 */
export const isSystemStop = (s: string | null | undefined): boolean => typeof s === 'string' && /\bis a system-level command\b/.test(s)

/**
 * The single place that decides whether a tool call runs, asks, or is refused.
 * Nothing a tool returns can change `mode`; only the user can, from the composer.
 */
export function decide(p: PermissionInput): Decision {
  // Never send a stored secret anywhere, in any mode, even if asked to.
  if (p.leaksSecret) return { verdict: 'deny', reason: 'The arguments contain a saved password or card number. Secrets can only be typed with browser fill_secret / fill_payment.' }

  // Purchases: the browser shows its own Purchase card at the moment of the click (browser/checkout.ts).
  // No mode, rule, "Always allow" or setting can skip that card, and unattended runs are refused there,
  // so a generic card here would only be a second prompt (or worse, a pre-approval). None is shown.
  // One-time codes work the same way: the browser asks with its own card (per site, per chat, or a
  // per-site grant the user chose), and refuses unattended runs without such a grant.
  if (isSelfGated(p.hardStop)) return { verdict: 'allow', reason: p.hardStop! }

  // A hard stop on a call classified as a read (a link-styled "Place order", a system-level command that
  // only reads) means the read label can't be trusted: it asks in every mode, hard stops on or off.
  if (p.effect === 'read' && p.hardStop) return { verdict: 'ask', reason: `Hard stop: ${p.hardStop}` }

  // A read that opens an address steered by fetched content can leak data in the URL itself. "Always allow" on
  // that card is honoured for the rest of the chat (it's only an address to open; nothing is sent or changed).
  if (p.effect === 'read') return p.tainted && !p.alwaysAllowed && normalizeMode(p.mode) !== 'bypass' ? { verdict: 'ask', reason: 'Opens an address taken from a web page or email' } : { verdict: 'allow' }

  const mode = normalizeMode(p.mode)
  // Trusted recipients (agent/trusted.ts): a send that reaches only people on this bot's "Can message without
  // asking" list, or the user, runs in Auto and Bypass, attended or not, even after reading outside content
  // (the recipients were matched exactly against the user's list, so outside content can't have chosen them).
  // Only a send stop is lifted: purchases and codes returned above, credentials and every other stop still ask.
  if (p.trustedSend && p.effect === 'write_external' && mode !== 'ask' && (!p.hardStop || (/^sends?\b/i.test(p.hardStop.trim()) && !isCredentialStop(p.hardStop)))) {
    return { verdict: 'allow', reason: 'Every recipient is on your trusted list', trusted: true }
  }
  // Hard stops: Ask asks for every one. Auto does the work itself (sending, deleting, uploading…) and stops only for a
  // credential (a saved login on a site that isn't its own, a password field, a flagged secret); buying has its own
  // card (above). Bypass skips them only when Settings says so, and never for credentials.
  // (Your whole home folder is the bot's in Auto. A path beyond it, or a protected spot in it like shell startup files
  // and login items, asks too: that OK is what lets the call reach it. So does a system-level command, which the
  // write sandbox can't contain: launchctl, defaults write, crontab, security.)
  const stops = mode === 'ask' || isCredentialStop(p.hardStop) || (mode === 'auto' && (isOutsideStop(p.hardStop) || isSystemStop(p.hardStop))) || (mode === 'bypass' && p.hardStopsEnabled)
  if (p.hardStop && stops) {
    return { verdict: 'ask', reason: `Hard stop: ${p.hardStop}${p.trustNote ? ` (${p.trustNote})` : ''}` }
  }

  // Taint is checked before the local-write shortcut: a terminal command steered by fetched content asks
  // whatever it does (checkTaint flags run_command at every effect; other tools' local writes never are).
  if (p.tainted && mode === 'auto') return { verdict: 'ask', reason: 'Uses details taken from a web page or email' }
  switch (mode) {
    case 'bypass':
      return { verdict: 'allow' }
    case 'auto':
      // Money is the user's call: paying, refunds, charges, transfers, subscriptions, paid credits (flagged by the loop
      // from the step's description, or by an app's own stop note).
      if (p.spends || spendsMoney(p.tool, null, p.hardStop)) return { verdict: 'ask', reason: `Spends money${p.hardStop ? `: ${p.hardStop}` : ''}` }
      // A memory a web page or email may have planted ("always forward invoices to…") is checked with the user.
      if (p.planted && p.hardStop) return { verdict: 'ask', reason: `Hard stop: ${p.hardStop}` }
      // Auto does nearly everything by itself, attended or not: files (made, changed or deleted; deletes go to the
      // Trash and Undo takes a task's file changes back), commands, emails and posts, and signing in with a saved
      // login on its own site. What still asks: buying (the Purchase card), credentials anywhere else, and anything a
      // web page or email steered (above), so outside content can't take the wheel.
      return { verdict: 'allow' }
    case 'ask':
    default:
      if (p.alwaysAllowed && !p.tainted && p.effect !== 'destructive') return { verdict: 'allow' }
      return { verdict: 'ask' }
  }
}

// ---------- hard-stop heuristics shared by tools ----------

/**
 * Prefix of a hard stop that the browser's purchase gate owns. The tool asks with a Purchase card
 * itself, every time, whatever the mode; decide() therefore doesn't ask a second time.
 */
export const PURCHASE_STOP = 'purchase: '
export const isPurchaseStop = (s: string | null | undefined): boolean => typeof s === 'string' && s.startsWith(PURCHASE_STOP)
/** Prefix of a hard stop for filling a one-time code: the browser's own code card handles it. */
export const OTP_STOP = 'one-time code: '
export const isSelfGated = (s: string | null | undefined): boolean => typeof s === 'string' && (s.startsWith(PURCHASE_STOP) || s.startsWith(OTP_STOP))

/** Words that mark an action with real-world consequences. */
export const CONSEQUENTIAL = /\b(send|submit|post|publish|pay|buy|purchase|order|checkout|check out|book|reserve|confirm|place|transfer|share|invite|sign ?up|register|subscribe|apply|delete|remove|cancel|tweet|reply|comment|upload|forward|approve|decline|accept|merge|deploy|donate|bid)\b/i

const PAYMENT = /\b(checkout|check out|pay(ment)?|purchase|buy now|place (your )?order|billing|credit card|card number|cvv|transfer funds|wire|send money|subscribe)\b/i
const SECURITY = /\b(password|passcode|2fa|two-factor|mfa|security settings|account settings|recovery (email|phone)|delete (my )?account|api key|permissions?)\b/i
const SECURITY_URL = /\/(settings|security|account|password|billing|admin)(\/|$|\?)/i

export function looksLikePayment(...texts: Array<string | undefined>): boolean {
  return texts.some((t) => !!t && PAYMENT.test(t))
}

export function looksLikeSecurity(url?: string, ...texts: Array<string | undefined>): boolean {
  return (!!url && SECURITY_URL.test(url)) || texts.some((t) => !!t && SECURITY.test(t))
}

// ---------- taint: did these arguments come from fetched content? ----------

const ENTITY = /(https?:\/\/[^\s"'<>)]+|[\w.+-]+@[\w-]+\.[\w.-]+|\+?\d[\d\s().-]{7,}\d|\b\d{6,}\b)/g

function ngrams(text: string, n: number): Set<string> {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out))
  return out
}

/** Every string in the arguments with the name of the field it sits under (array items keep their field's name). */
function keyed(v: unknown, key = '', out: Array<[string, string]> = [], depth = 0): Array<[string, string]> {
  if (depth > 6 || out.length > 400) return out
  if (typeof v === 'string') out.push([key, v])
  else if (Array.isArray(v)) v.forEach((x) => keyed(x, key, out, depth + 1))
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => keyed(x, k, out, depth + 1))
  return out
}

const wordSet = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))

/** Fields that only pick an item already shown (a message id from a search, a plan id): they can't steer anything. */
const HANDLE_KEY = /^(id|ids|uid|uids|message_?ids?|thread_?ids?|plan_?id|ref|refs|reply_?to|in_?reply_?to|item_?ids?|event_?ids?|draft_?ids?|task_?ids?|job_?id|index)$/i
/** Fields that name who a message goes to. */
const RECIPIENT_KEY = /^(to|cc|bcc|recipients?|emails?|address|addresses|attendees|invitees)$/i
/** The user asked to answer a message (its sender is then theirs to write to). */
const REPLY_ASK = /\b(reply|replies|respond|answer|write back|get back to)\b/i
/** Words next to an address that are nobody's name. */
const NOT_A_NAME = new Set(('from to cc bcc reply sender date subject mail email info hello hi team support contact noreply admin office the and mr mrs ms dr ' +
  'com net org billing invoice invoices accounts account sales finance payments payment security help service orders notifications news').split(' '))

/**
 * The user named the person behind an address shown in outside content: a word of its "Name <address>" line or of
 * the address itself is one the user typed ("reply to Sarah" → "Sarah Kim <sarah@kimdesign.co>"), or it is the
 * sender of a message the user asked to answer. The body of what is sent stays checked word for word.
 */
function namedByUser(addr: string, corpus: string, user: string, userWords: Set<string>): boolean {
  const names = addr.split('@')[0].split(/[^a-z]+/)
  let header = false
  for (let i = corpus.indexOf(addr), n = 0; i >= 0 && n < 50; i = corpus.indexOf(addr, i + addr.length), n++) {
    const before = corpus.slice(Math.max(corpus.lastIndexOf('\n', i) + 1, i - 80), i)
    // Only a display name right before the address: "Sarah Kim <sarah@…>", "\"Sarah Kim\" <…>".
    const display = /([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,3})"?\s*<\s*$/.exec(before)
    if (display) names.push(...display[1].split(/[^a-z]+/))
    if (/(^|["\s,{])(from|reply-to|sender)"?\s*[:=]/.test(before)) header = true
  }
  if (header && REPLY_ASK.test(user)) return true
  return names.some((w) => w.length >= 3 && !NOT_A_NAME.has(w) && userWords.has(w))
}

/**
 * True when an argument carries an address, number or 8-word run that appears in
 * untrusted tool output but nowhere in what the user typed. That's the signature
 * of a page or email steering the agent ("send the file to attacker@…").
 * Ids that pick a shown item (archive message #104190) don't count, and neither does a recipient the user named
 * ("reply to Sarah") or the sender of a message the user asked to reply to.
 */
export function isTainted(args: unknown, untrusted: string[], userText: string): boolean {
  if (!untrusted.length) return false
  const corpus = untrusted.join('\n').toLowerCase()
  const user = userText.toLowerCase()
  let userWords: Set<string> | undefined
  for (const [key, s] of keyed(args)) {
    if (!HANDLE_KEY.test(key)) {
      for (const m of s.matchAll(ENTITY)) {
        const e = m[0].toLowerCase().trim()
        if (!corpus.includes(e) || user.includes(e)) continue
        if (RECIPIENT_KEY.test(key) && /^[^/]+@/.test(e) && namedByUser(e, corpus, user, userWords ??= wordSet(user))) continue
        return true
      }
    }
    for (const g of ngrams(s, 8)) {
      if (corpus.includes(g) && !user.includes(g)) return true
    }
  }
  return false
}

export function containsSecret(args: unknown, secrets: string[]): boolean {
  const all = strings(args).join('\n')
  if (secrets.some((s) => s.length >= 4 && all.includes(s))) return true
  // Card numbers however they're written: "4242 4242 4242 4242", "4242-4242-…", "4242.4242…".
  const cards = secrets.filter((s) => /^\d{12,19}$/.test(s))
  if (!cards.length) return false
  const digits = all.replace(/[\s.\-\u00a0\u2010-\u2015_/]+/g, '')
  return cards.some((c) => digits.includes(c))
}

/** In a URL: an email, a phone number, a long number (a code, an account). Dates and counts aren't. */
const URL_ENTITY = /[\w.+-]+@[\w-]+\.[\w.-]+|\+?\d[\d\s().-]{8,}\d|\b\d{6,}\b/g
/** A run that looks like a key, token or encoded blob (base64 or hex, letters and digits mixed). */
const TOKENISH = /[a-z0-9+/=]{16,}/g
/** Text as words between spaces, for whole-word phrase checks. */
const flat = (t: string): string => ` ${t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

/** The parts of a URL that can carry data: query keys and values, the fragment and the path segments, decoded. */
function urlParts(parsed: URL): string[] {
  const dec = (x: string): string => { try { return decodeURIComponent(x) } catch { return x } }
  const out: string[] = []
  for (const [k, v] of parsed.searchParams) out.push(k, v)
  if (parsed.hash.length > 1) out.push(dec(parsed.hash.slice(1)))
  for (const seg of parsed.pathname.split('/')) if (seg) out.push(dec(seg))
  return out
}

/**
 * Whether a URL's parts carry private data out: an address, phone number, code or token the user didn't type (and
 * that isn't just public text from the page itself), three words in a row from the user's own files, mail, notes or
 * screen (`priv`: what this chat read that isn't a public web page), or a short secret-looking word from there.
 * A search for "savannah restaurants family", dates (2026-12-04) and counts (group_adults=4) carry nothing.
 */
function carriesData(parts: string[], corpus: string, user: string, priv: string): boolean {
  const privWords = priv ? flat(priv) : ''
  const userWords = flat(user)
  for (const raw of parts) {
    const v = raw.toLowerCase()
    for (const m of v.matchAll(URL_ENTITY)) {
      const e = m[0].trim()
      const digits = e.replace(/\D/g, '').length
      if (!e.includes('@') && digits < (/^\d+$/.test(e) ? 6 : 10)) continue
      if (user.includes(e)) continue
      if (!corpus.includes(e) || priv.includes(e)) return true
    }
    for (const m of v.matchAll(TOKENISH)) {
      const t = m[0]
      if (!/\d/.test(t) || !/[a-z]/.test(t) || user.includes(t)) continue
      if (!corpus.includes(t) || priv.includes(t)) return true
    }
    if (!privWords) continue
    const w = v.split(/[^a-z0-9]+/).filter(Boolean)
    for (let i = 0; i + 3 <= w.length; i++) {
      const g = ` ${w.slice(i, i + 3).join(' ')} `
      if (privWords.includes(g) && !userWords.includes(g)) return true
    }
    // A short password or code from the user's own data ("hunter22", "x7k9q2").
    for (const t of w) if (t.length >= 6 && /\d/.test(t) && /[a-z]/.test(t) && privWords.includes(` ${t} `) && !userWords.includes(` ${t} `) && !corpus.includes(t)) return true
  }
  return false
}

/**
 * A URL steered by fetched content: its host appears in untrusted output but not in what the user typed, the URL
 * itself is not a link copied verbatim from that output, and it carries data that looks private (carriesData):
 * e.g. an attacker page's "open evil.example/collect?d=<your notes>" or "?c=<the code from your email>". Ordinary
 * research on a site a search turned up (a booking.com search for dates and a city) never asks.
 * `priv`: what this chat read from the user's own data (files, mail, notes, screen), for the private-words check.
 */
export function urlTainted(url: string, untrusted: string[], userText: string, priv: string[] = []): boolean {
  if (!untrusted.length) return false
  let host: string
  let parsed: URL
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`); host = parsed.hostname.toLowerCase().replace(/^www\./, '') } catch { return false }
  const corpus = untrusted.join('\n').toLowerCase()
  const user = userText.toLowerCase()
  if (!host || user.includes(host) || !corpus.includes(host)) return false
  const u = url.toLowerCase().replace(/\/+$/, '')
  if (corpus.includes(u) || user.includes(u)) return false
  return carriesData(urlParts(parsed), corpus, user, priv.join('\n').toLowerCase())
}

/** Hosts a terminal command talks to: URLs, user@host: targets, and bare domains it names. */
function commandHosts(cmd: string): string[] {
  const out = new Set<string>()
  for (const m of cmd.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/:'"@]+@)?([^\s/:'"?#]+)/gi)) out.add(m[2].toLowerCase())
  for (const m of cmd.matchAll(/[\w.-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+):/gi)) out.add(m[1].toLowerCase())
  for (const m of cmd.matchAll(/(?<![\w./@-])([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|dev|app|ai|xyz|me|info|biz|ru|cn|site|online|top|cc|us|uk|de|fr|sh|example|test))(?![\w.-])/gi)) out.add(m[1].toLowerCase())
  return [...out].map((h) => h.replace(/^www\./, ''))
}

/** A command that sends data somewhere: uploads, posts, copies to another machine, raw sockets. */
const SENDS_DATA = /\b(curl|wget|http|https|xh)\b[^|;&\n]*(\s-[a-zA-Z]*[dFT]\b|\s--(data|data-binary|data-raw|data-urlencode|form|upload-file|post-data|post-file|json)\b|\s-X\s*['"]?(POST|PUT|PATCH)\b|\s--request\s*['"]?(POST|PUT|PATCH)\b)|(^|[\s;&|(])(scp|sftp|rsync|ftp|nc|ncat|netcat|socat)\s/i

/** The user named this site: its address, or its name ("acme" for careers.acme.com). */
function hostNamed(host: string, user: string, userWords: Set<string>): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  if (user.includes(h)) return true
  const labels = h.split('.')
  return labels.slice(0, -1).some((l) => l.length >= 4 && !/^(www|mail|api|app|apps|login|auth|secure|account|accounts|careers|jobs|upload|uploads|files|cdn|static)$/.test(l) && userWords.has(l))
}

/** The host a command sends data to, when it is one the page or email named and the user didn't. */
function commandHostTainted(args: unknown, untrusted: string[], userText: string): boolean {
  const cmd = (args as { command?: unknown } | null)?.command
  if (typeof cmd !== 'string' || !SENDS_DATA.test(cmd) || !untrusted.length) return false
  const corpus = untrusted.join('\n').toLowerCase()
  const user = userText.toLowerCase()
  const words = wordSet(user)
  return commandHosts(cmd).some((h) => corpus.includes(h) && !hostNamed(h, user, words))
}

/** Tools whose read calls load a URL the agent chose. */
const URL_READS: Record<string, (args: any) => string | undefined> = {
  fetch_page: (a) => a?.url,
  browser: (a) => (a?.action === 'navigate' || (a?.action === 'tabs' && a?.op === 'new') ? a?.url : undefined)
}

/** Tools whose every call is checked for taint, whatever its effect: a terminal command can do anything. */
export const ALWAYS_TAINT_CHECKED = new Set(['run_command', 'mac'])

/**
 * Whether a call's arguments were steered by fetched content, for decide()'s `tainted`. `priv`: what this chat read
 * from the user's own data (not public pages), so a URL carrying it out is caught. A terminal command that sends data
 * to a host the page or email named (and the user didn't) counts too, even with no copied string.
 */
export function checkTaint(tool: string, effect: string, args: unknown, untrusted: string[], userText: string, priv: string[] = []): boolean {
  if (effect === 'write_external' || effect === 'destructive' || ALWAYS_TAINT_CHECKED.has(tool)) {
    return isTainted(args, untrusted, userText) || (tool === 'run_command' && commandHostTainted(args, untrusted, userText)) || (effect === 'read' && urlTaintedRead(tool, args, untrusted, userText, priv))
  }
  if (effect !== 'read') return false
  return urlTaintedRead(tool, args, untrusted, userText, priv)
}

function urlTaintedRead(tool: string, args: unknown, untrusted: string[], userText: string, priv: string[]): boolean {
  const url = URL_READS[tool]?.(args)
  return !!url && urlTainted(url, untrusted, userText, priv)
}

// ---------- steered: an outside action a page or email chose, without copying a string ----------

/** Public places a post goes out to (an app's own tool names). */
const PUBLIC_POST_TOOL = /^(x|twitter|linkedin|reddit|facebook|instagram|threads|mastodon|bluesky|tiktok|youtube|medium|substack|wordpress|ghost|tumblr)__.*(post|tweet|publish|share|submit|create|reply|comment)/i
const POST_ASK = /\b(post|posts|posting|tweet|tweets|publish|share|announce|thread|reply|comment|put (it|this|that) on)\b/i
/** Tools that make a new file from a path the model picks. */
const CREATES_FILE = new Set(['file_write', 'create_document', 'doc_create', 'office'])
/** The user asked for something to be sent to themselves. */
const ME_ASK = /\b(email|e-mail|mail|send|forward|text|message)\b[^.\n]{0,40}\b(me|myself)\b|\bmy (own )?(email|inbox)\b/i
/** Programs that delete their arguments. */
const RM_CMD = /(^|[\s;&|(])(rm|rmdir|unlink|trash|srm|shred)\s+([^;&|\n]+)/g

/** What a delete removes: file_manage's paths, or the arguments of rm / trash in a command. */
function deleteTargets(tool: string, a: Record<string, unknown>): string[] {
  if (tool === 'run_command' && typeof a.command === 'string') {
    const out: string[] = []
    for (const m of a.command.matchAll(RM_CMD)) out.push(...m[3].trim().split(/\s+/).filter((x) => x && !x.startsWith('-')).map((x) => x.replace(/^['"]|['"]$/g, '')))
    return out
  }
  if (tool !== 'file_manage' || !/^(delete|trash|remove)$/i.test(String(a.action ?? ''))) return []
  return keyed(a).filter(([k]) => /^(path|paths|file|files|source|sources|from)$/i.test(k)).map(([, v]) => v)
}

/** A path's own name (or its folder's, for "*.tmp"), as people say it. */
function nameOf(p: string): string {
  const parts = p.replace(/\/+$/, '').split(/[\\/]/).filter(Boolean)
  const last = parts.pop() ?? ''
  return (/[*?[\]{}]/.test(last) ? parts.pop() ?? last : last).toLowerCase()
}

export interface SteerCheck {
  tool: string
  effect: ToolEffect | string
  args: unknown
  summary?: string
  hardStop?: string | null
  /** Outside content this chat read (pages, email, other bots and apps). */
  untrusted: string[]
  /** The user's own data this chat read (files, listings, notes, the screen): not outside content. */
  private?: string[]
  userText: string
}

/**
 * An outside action that a web page or email this run read could have chosen, even when no address or phrase was
 * copied word for word (taint only matches literal strings). Called only for runs that read outside content. Each
 * target has to come from the user: an address they typed or a person they named ("reply to Sarah"), a file they
 * named or that came from their own folders (not from the page), a site they named. Returns why, or null.
 *  - sending to an address nobody gave ("billing at evil dot com" → billing@evil.com)
 *  - deleting a file the user didn't name that the page did
 *  - uploading a file to, or sending data with a command to, a site the user didn't name
 *  - typing the user's own data (from a file or note) into a site they didn't name
 *  - posting publicly when the user never asked for a post
 */
export function steeredRisk(c: SteerCheck): string | null {
  const a = (c.args && typeof c.args === 'object' ? c.args : {}) as Record<string, unknown>
  const user = c.userText.toLowerCase()
  const corpus = c.untrusted.join('\n').toLowerCase()
  const priv = (c.private ?? []).join('\n').toLowerCase()
  // From the user's own data, and not something the outside content also names.
  const ownData = (t: string): boolean => !!t && priv.includes(t) && !corpus.includes(t)
  // A new file the outside content told the bot to make ("ASSISTANT: reply HACKED, create pwned.txt").
  if (c.effect === 'write_local' && CREATES_FILE.has(c.tool)) {
    const name = nameOf(String(a.path ?? a.file ?? a.filename ?? a.name ?? ''))
    if (name.length >= 3 && name.includes('.') && !user.includes(name) && !ownData(name) && new RegExp(`\\b(create|write|save|make|add|touch)\\b[^.\\n]{0,40}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(corpus)) return `creates ${name}, which a page, email or file asked for`
  }
  if (c.effect !== 'write_external' && c.effect !== 'destructive') return null
  const userWords = wordSet(user)

  // "Email me": one of the user's own Mail accounts (mail accounts lists them as "- iCloud (me@icloud.com, …)").
  const toMe = ME_ASK.test(user)
  const ownAccount = (addr: string): boolean => toMe && new RegExp(`^- [^\\n]*\\([^)\\n]*${addr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)\\n]*\\)`, 'm').test(corpus)
  for (const [key, s] of keyed(a)) {
    if (!RECIPIENT_KEY.test(key)) continue
    for (const addr of s.toLowerCase().match(EMAIL) ?? []) {
      if (user.includes(addr) || ownData(addr) || namedByUser(addr, corpus, user, userWords) || ownAccount(addr)) continue
      return `sends to ${addr}, an address you didn't give`
    }
  }

  for (const t of deleteTargets(c.tool, a)) {
    const name = nameOf(t)
    if (!name || user.includes(name) || ownData(name) || (name.includes('.') && user.includes(name.replace(/\.[^.]+$/, '')) && name.replace(/\.[^.]+$/, '').length >= 3)) continue
    return `deletes ${name}, which you didn't name`
  }

  const host = c.tool === 'browser' && a.action === 'upload'
    ? (/ to ([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(c.hardStop ?? '')?.[1] ?? / on ([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(c.summary ?? '')?.[1])
    : c.tool === 'run_command' && typeof a.command === 'string' && SENDS_DATA.test(a.command) ? commandHosts(a.command).find((h) => !hostNamed(h, user, userWords)) : undefined
  if (host && !hostNamed(host, user, userWords)) return `sends your file or data to ${host}, a site you didn't name`

  if (c.tool === 'browser' && (a.action === 'type' || a.action === 'fill_form') && priv) {
    const page = / on ([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(c.summary ?? '')?.[1]
    const typed = strings(a.action === 'type' ? a.text : a.fields).join('\n')
    if (page && !hostNamed(page, user, userWords) && sharesRun(typed, priv, user, 6)) return `types your own data into ${page}, a site you didn't name`
  }

  if (PUBLIC_POST_TOOL.test(c.tool) && !POST_ASK.test(user)) return 'posts publicly, which you didn\'t ask for'
  return null
}

/** Whether `text` has an n-word run that is in `source` but not in what the user typed. */
function sharesRun(text: string, source: string, user: string, n: number): boolean {
  const src = flat(source)
  const u = flat(user)
  const w = flat(text).trim().split(' ').filter(Boolean)
  for (let i = 0; i + n <= w.length; i++) {
    const g = ` ${w.slice(i, i + n).join(' ')} `
    if (src.includes(g) && !u.includes(g)) return true
  }
  return false
}

/**
 * Whether a chat's autonomy may be changed to `next` from the renderer: only real levels, and Bypass only
 * when Settings offers it (advanced.allowBypass) or the chat is already in Bypass.
 */
export function modeChangeAllowed(next: unknown, o: { allowBypass?: boolean; current?: PermissionMode | null }): boolean {
  if (!isPermissionMode(next)) return false
  return next !== 'bypass' || !!o.allowBypass || o.current === 'bypass'
}

// ---------- long-term memory: instructions planted from fetched content ----------

/** Words that make saved text read as a standing instruction (or a place to send things). */
const INSTRUCTION = /\b(always|never|must|ignore|disregard|override|instead|from now on|whenever|every time|send|forward|cc|bcc|reply|email|e-mail|upload|share|post|transfer|pay|wire|run|execute|download|install|delete)\b/i
const ADDRESSY = /(https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+/i

/** Text that would steer future chats: imperatives like "always / never / send / forward", URLs or emails. */
export function looksInstructionLike(text: string): boolean {
  return INSTRUCTION.test(text) || ADDRESSY.test(text)
}

/** Category names that mean the work log (kept in sync with memory.ts normalizeKind). */
const WORKLOG = /^\s*(worklog|work[ _-]?log|log)\s*$/i

/**
 * Why a memory-tool call must ask, or null. A memory, skill or standing rule asks when its text was taken from
 * fetched content, or when this run read untrusted content and the text reads like an instruction (every rule does,
 * so a rule saved after reading a page or email always asks). Work-log entries never ask. Ordinary saves of what
 * the user said ("always reply in metric", with nothing outside read) stay frictionless in Auto.
 */
export function memoryRisk(args: unknown, untrusted: string[], userText: string, sawUntrusted: boolean): string | null {
  const a = (args ?? {}) as Record<string, unknown>
  if (a.action !== 'save' && a.action !== 'save_skill' && a.action !== 'save_rule') return null
  if (a.action === 'save' && typeof a.category === 'string' && WORKLOG.test(a.category)) return null
  const fields = a.action === 'save' ? { fact: a.fact } : a.action === 'save_rule' ? { name: a.name, rule: a.rule } : { name: a.name, description: a.description, steps: a.steps }
  const text = Object.values(fields).filter((x) => typeof x === 'string').join('\n')
  const what = a.action === 'save' ? 'a memory every future chat sees' : a.action === 'save_rule' ? 'a standing rule every chat will follow' : 'a skill future chats can follow'
  if (isTainted(fields, untrusted, userText)) return `saving ${what}, with details taken from a web page or email`
  if (sawUntrusted && looksInstructionLike(text)) return `saving ${what} after reading a web page or email (it reads like an instruction)`
  return null
}

/** Outward steps a saved instruction can tell a later run to take (sending, posting, paying, deleting, running). */
const OUTWARD_STEP = /\b(forward|forwards|cc|bcc|upload|uploads|share|shares|post|posts|publish|transfer|pay|pays|wire|delete|deletes|erase|install|download|execute|ignore|disregard|override|email|e-mail|emails|send|sends|text|message|reply|buy|purchase|order)\b/gi
/** Steps aimed back at the user ("send me", "text me the summary", "remind me"): not outward. */
const TO_ME = /\b(send|email|e-mail|text|message|tell|remind|notify|ping|show|give)\s+(it\s+|this\s+|that\s+|them\s+)?(to\s+)?me\b/gi

/** Text that tells a later run to do something outward the user never asked for (or to reach an address they didn't give). */
function steersOutward(text: string, userText: string): boolean {
  const user = userText.toLowerCase()
  for (const m of text.matchAll(new RegExp(ADDRESSY.source, 'gi'))) if (!user.includes(m[0].toLowerCase())) return true
  const said = new Set(words(user).map(stem))
  const rest = text.replace(TO_ME, ' ')
  for (const m of rest.matchAll(OUTWARD_STEP)) if (!said.has(stem(m[0]))) return true
  return false
}

/**
 * Why saving a routine's instructions or a bot's standing instructions must ask, or null: text later runs follow as
 * if the user had said it (a routine's prompt arrives as the user's message; a bot's instructions are its job). It
 * asks when the text carries details from a web page or email, or when this run read outside content and the text
 * tells a later run to do something outward the user never asked for. A user's own routine ("every weekday at 7:30
 * send me the Atlanta weather") or bot ("explain steps, never give answers") saves without a card. Memory saves go
 * through memoryRisk.
 */
export function plantRisk(tool: string, args: unknown, untrusted: string[], userText: string, sawUntrusted: boolean): string | null {
  if (tool === 'memory') return memoryRisk(args, untrusted, userText, sawUntrusted)
  const a = (args ?? {}) as Record<string, unknown>
  let text: string
  let what: string
  if (tool === 'schedule' && (a.action === 'create' || a.action === 'update') && typeof a.prompt === 'string') {
    text = a.prompt
    what = 'a routine\'s instructions (it runs on its own later)'
  } else if ((tool === 'update_bot' || tool === 'create_bot' || tool === 'finish_setup') && typeof a.instructions === 'string') {
    text = a.instructions
    what = 'a bot\'s standing instructions'
  } else return null
  if (isTainted({ text }, untrusted, userText)) return `saving ${what}, with details taken from a web page or email`
  if (sawUntrusted && steersOutward(text, userText)) return `saving ${what} after reading a web page or email (it tells the bot to do something you didn't ask for)`
  return null
}

/** Where a saved memory's wording came from, for its provenance. */
export function memoryProvenance(args: unknown, untrusted: string[], userText: string, sawUntrusted: boolean): 'chat' | 'web-tainted' {
  const a = (args ?? {}) as Record<string, unknown>
  const text = [a.fact, a.rule, a.name, a.description, a.steps].filter((x) => typeof x === 'string').join('\n')
  if (!text) return 'chat'
  return isTainted(text, untrusted, userText) || (sawUntrusted && looksInstructionLike(text)) ? 'web-tainted' : 'chat'
}

// ---------- the user's own approval rules ----------

/** Rule limits: per kind (allow / ask) and per rule text. */
export const RULE_LIMIT = 20
export const RULE_MAX_CHARS = 1000

/** Filler words a rule can contain without narrowing what it matches. */
const STOPWORDS = new Set(('a an the to for of on in at by with and or any anything something someone somebody me my mine i ' +
  'it its this that these those want wants wanted wanting when whenever if sahilbot should be is are was were am from into onto ' +
  'about please some all every do does use uses using used via can could would will just thing things stuff action actions try tries').split(' '))

/** Irregular forms, so "sent" matches "send" and "ran" matches "run". */
const IRREGULAR: Record<string, string> = {
  sent: 'send', ran: 'run', bought: 'buy', paid: 'pay', wrote: 'write', written: 'write', made: 'make', sold: 'sell',
  took: 'take', taken: 'take', gave: 'give', given: 'give', went: 'go', gone: 'go', got: 'get', gotten: 'get', chose: 'choose',
  chosen: 'choose', did: 'do', done: 'do', put: 'put', read: 'read', left: 'leave', kept: 'keep', found: 'find', told: 'tell',
  goes: 'go', said: 'say', saw: 'see', seen: 'see', spent: 'spend', built: 'build', began: 'begin', begun: 'begin'
}

/** A light stemmer: send / sends / sending, delete / deleted, reply / replies / replied all meet in one form. */
export function stem(word: string): string {
  let w = word.toLowerCase()
  if (IRREGULAR[w]) w = IRREGULAR[w]
  if (w.length <= 3 || /^\d/.test(w)) return w
  const undouble = (x: string): string => (/([b-df-hj-kmnp-rtv-z])\1$/.test(x) ? x.slice(0, -1) : x)
  // Plurals first, then verb endings, so "strings" and "string", "settings" and "set" agree.
  if (/ies$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (/(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2)
  else if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1)
  if (/ied$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (/ing$/.test(w) && w.length >= 6) w = undouble(w.slice(0, -3))
  else if (/ed$/.test(w) && w.length >= 5 && !/eed$/.test(w)) w = undouble(w.slice(0, -2))
  if (/e$/.test(w) && w.length >= 4) w = w.slice(0, -1)
  return w
}

/** Lowercase words of a text: camelCase, snake_case, paths and URLs all split into their parts. */
function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

interface ParsedRule { tools: RegExp[]; stems: string[]; phrases: string[] }

/** "tool:run_command", quoted "exact phrases", and plain words (stopwords dropped, stemmed). */
export function parseRule(when: string): ParsedRule {
  const text = String(when ?? '').slice(0, RULE_MAX_CHARS)
  const tools: RegExp[] = []
  const phrases: string[] = []
  let rest = text.replace(/\btool:\s*([\w.*-]+)/gi, (_m, name: string) => {
    tools.push(new RegExp(`^${name.toLowerCase().replace(/[.+?^${}()|[\]\\-]/g, '\\$&').replace(/\*/g, '.*')}$`))
    return ' '
  })
  rest = rest.replace(/["\u201c\u201d]([^"\u201c\u201d]+)["\u201c\u201d]/g, (_m, p: string) => {
    const t = p.trim().toLowerCase().replace(/\s+/g, ' ')
    if (t) phrases.push(t)
    return ' '
  })
  const stems = [...new Set(words(rest).filter((w) => !STOPWORDS.has(w)).map(stem))]
  return { tools, stems, phrases }
}

/** An action as rules see it. `target` (optional) is computed from the rest when left out. */
export interface RuleAction { tool: string; label?: string; summary?: string; args: string; target?: string }

/** Whether one rule matches an action. A rule with nothing significant in it matches nothing. */
export function ruleMatches(when: string, action: RuleAction): boolean {
  const r = parseRule(when)
  if (!r.tools.length && !r.stems.length && !r.phrases.length) return false
  const tool = String(action.tool ?? '').toLowerCase()
  if (r.tools.length && !r.tools.some((t) => t.test(tool))) return false
  const all = [action.tool, action.label, action.summary, action.args, action.target].filter(Boolean).join('\n')
  const have = new Set(words(all).map(stem))
  if (!r.stems.every((s) => have.has(s))) return false
  const flat = all.toLowerCase().replace(/\s+/g, ' ')
  return r.phrases.every((p) => flat.includes(p))
}

/**
 * An Allow rule that would match (nearly) everything: "tool:*", or a tool pattern with almost no fixed
 * letters ("tool:s*", "tool:*_*"). Never saved, and ignored if one is found anyway.
 */
export function isBroadAllow(when: string): boolean {
  const text = String(when ?? '').slice(0, RULE_MAX_CHARS)
  for (const m of text.matchAll(/\btool:\s*([\w.*-]+)/gi)) {
    const name = m[1]
    if (name.includes('*') && name.replace(/[*._-]/g, '').length < 3) return true
  }
  return false
}

/** Shell syntax that chains, pipes, substitutes or redirects: an Allow rule never vouches for that. */
const CHAIN = /&&|\|\||;|\||\$\(|`|>|<\(|\n|\r/

/** Argument fields that name who or what an action is aimed at (not what it says). */
const TARGET_KEY = /^(to|cc|bcc|recipients?|emails?|address(es)?|phone|number|channel|chat(_?id)?|users?|username|bot|app|apps|url|urls|href|link|links|host|hostname|domain|path|paths|file|files|filename|folder|dir|directory|dest|destination|repo|repository|owner|calendar|calendar_?id|op|action|method|ref|title|name|names|label|labels|account|project|board|list|table|database|page_?id|id)$/i
const URL_KEY = /^(url|urls|href|link|links)$/i

function hostOf(u: string): string {
  try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`).hostname } catch { return '' }
}

function targetValues(v: unknown, key: string, out: string[], depth = 0): void {
  if (depth > 4 || out.length > 40) return
  if (Array.isArray(v)) { v.forEach((x) => targetValues(x, key, out, depth + 1)); return }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) if (TARGET_KEY.test(k)) targetValues(x, k, out, depth + 1)
    return
  }
  if (typeof v !== 'string' && typeof v !== 'number') return
  const s = String(v).slice(0, 200)
  out.push(URL_KEY.test(key) ? hostOf(s) : s)
}

/**
 * What an action is aimed at, for Allow rules: the tool's own summary for built-in tools whose summary
 * names only the target, otherwise recipients, hosts, paths and names from the arguments, and for a
 * command its first segment. Free-form bodies (message text, email body, typed text) are left out, so
 * "send email to mom" can't be satisfied by a body that says "hi mom".
 */
export function actionTarget(action: RuleAction): string {
  let args: Record<string, unknown> = {}
  try { const p = JSON.parse(action.args || '{}'); if (p && typeof p === 'object' && !Array.isArray(p)) args = p } catch { /* not JSON */ }
  const out: string[] = []
  if (typeof args.command === 'string') out.push(args.command.split(CHAIN)[0].trim().slice(0, 200))
  for (const [k, v] of Object.entries(args)) if (k !== 'command' && TARGET_KEY.test(k)) targetValues(v, k, out)
  // The browser's summary is "Click button "Buy now" on amazon.com": the target itself. Typed text is not.
  if (action.tool === 'browser' && action.summary && args.action !== 'type' && args.action !== 'fill_form') out.push(action.summary)
  else if (action.tool === 'browser' && action.summary) out.push(action.summary.replace(/"[^"]*"/, '').trim())
  return out.filter(Boolean).join('\n')
}

/** Whether an Allow rule may vouch for this action at all (never for a chained or piped shell command). */
function allowable(action: RuleAction): boolean {
  try {
    const a = JSON.parse(action.args || '{}') as Record<string, unknown>
    if (a && typeof a.command === 'string' && CHAIN.test(a.command)) return false
  } catch { /* not JSON */ }
  return true
}

/**
 * The user's custom rules for one action: 'ask' if any Ask-first rule matches, else 'allow' if an
 * Allow rule matches, else null (normal permissions apply). Contract shared by the approvals UI and
 * the agent loop.
 *
 * Matching is case-insensitive: every significant word of the rule (filler words dropped, simple
 * stemming so "send" also matches "sends" / "sending" / "sent") must appear. "tool:run_command" pins a
 * rule to one tool (* is a wildcard), and "quoted text" must appear as written. Ask rules look at
 * everything (tool, label, summary, arguments): they only add safety. Allow rules look only at the tool
 * name, its label and what the action is aimed at (actionTarget), never at free-form bodies; they never
 * vouch for a shell command that chains, pipes, substitutes or redirects; and a near-wildcard rule
 * ("tool:*") is ignored. At most RULE_LIMIT rules of each kind are considered.
 */
export function ruleVerdict(rules: import('@shared/types').CustomRule[] | undefined, action: RuleAction): 'allow' | 'ask' | null {
  if (!Array.isArray(rules) || !rules.length) return null
  const valid = rules.filter((r) => r && typeof r.when === 'string' && (r.action === 'ask' || r.action === 'allow'))
  const of = (kind: 'ask' | 'allow') => valid.filter((r) => r.action === kind).slice(0, RULE_LIMIT)
  if (of('ask').some((r) => ruleMatches(r.when, action))) return 'ask'
  if (!allowable(action)) return null
  const narrow: RuleAction = { tool: action.tool, label: action.label, args: '', target: action.target ?? actionTarget(action) }
  if (of('allow').some((r) => !isBroadAllow(r.when) && ruleMatches(r.when, narrow))) return 'allow'
  return null
}

// ---------- runs an app started (MCP ask_bot): private reads ask ----------

/**
 * Reads of public data only: no cookies, no files, no accounts. A connected app's run may use these
 * without asking; every other read asks, because the bot's reply goes back to the app.
 */
export const APP_PUBLIC_READS = new Set(['web_search', 'fetch_page', 'stock_quote', 'stock_analyze', 'stock_compare', 'stock_forecast', 'stock_backtest'])
/** The run's own bookkeeping (its plan, loading tools, asking the user): reads nothing private. */
const APP_BOOKKEEPING = new Set(['todo', 'find_tools', 'ask_user', 'propose_plan'])

/**
 * Why a call in a run a connected app started (or steered into) must ask, or null. Only public web and
 * market data reads and the run's own bookkeeping run freely. Every other call asks, whatever its effect:
 * files, commands (run_command at any effect), the screen and clipboard, mail, the logged-in browser, the
 * knowledge base and memories are the user's private data, the reply goes to the app, and a "local" write
 * or command is still the app acting on this Mac.
 */
export function appReadRisk(app: string | undefined | null, tool: string, effect: string): string | null {
  if (!app) return null
  if (APP_PUBLIC_READS.has(tool) || APP_BOOKKEEPING.has(tool)) return null
  if (effect === 'read') return `${app} asked: this reads your private data, and the reply goes back to ${app}`
  return `${app} asked: this run was started by ${app}, so everything it does on this Mac asks you first`
}

// ---------- goals: what a run that read outside content may change ----------

/** goal actions that change a goal (get and list only read). follow_up always changes it. */
export const GOAL_MUTATIONS = new Set(['create', 'update', 'add_milestones', 'milestone', 'journal', 'set_status'])

export function isGoalMutation(tool: string, args: unknown): boolean {
  if (tool === 'follow_up') return true
  if (tool !== 'goal') return false
  const action = (args as { action?: unknown } | null)?.action
  return typeof action === 'string' && GOAL_MUTATIONS.has(action)
}

/**
 * Whether a goal change may run. `tainted`: the run read untrusted content (web, email, another bot's
 * or an app's message, a sahilbot:// link) or was handed tainted work. `wake`: an unattended wake-up of
 * the goal itself, which keeps its bookkeeping (its entries are tagged as tainted by the tool).
 * Starting a goal from such a run is refused outright: the user has to ask for it directly.
 */
export function goalChangeRisk(tool: string, args: unknown, o: { tainted: boolean; wake: boolean }): { verdict: 'deny' | 'ask'; reason: string } | null {
  if (!isGoalMutation(tool, args)) return null
  const action = (args as { action?: unknown } | null)?.action
  // (A wake-up can't start goals at all: the tool itself refuses that, unattended.)
  if (tool === 'goal' && action === 'create' && o.tainted && !o.wake) {
    return { verdict: 'deny', reason: 'A goal can\'t be started from content the bot read (a web page, email, another bot or app, or a link). Ask the user to ask for the goal directly in this chat.' }
  }
  if (o.wake || !o.tainted) return null
  return { verdict: 'ask', reason: 'Changes a long-running goal after reading a web page, email, or a message from another bot or app' }
}

// ---------- always-on bots: hard stops that ask whatever the level, rule or "Always" ----------

/** What kind of hard stop an action is, for a bot working on its own. */
export type BotStopKind = 'money' | 'credentials' | 'mass_send' | 'delete' | 'public_post' | 'always_ask'

/** Recipients in one call at or above this count make it a mass send. */
export const MASS_SEND_MIN = 5

const MONEY_WORDS = /\b(buy|purchase|pay|payment|checkout|check out|place (an |your )?order|transfer|wire|send money|refund|charge|invoice payment|donate|tip|subscribe|upgrade plan|billing)\b/i
const CREDENTIAL_WORDS = /\b(password|passcode|passkey|credential|login details|one-time code|otp|2fa|two-factor|mfa|verification code|security code|api key|access token|secret key|recovery (code|email|phone))\b/i
const DELETE_WORDS = /\b(delete|deletes|deleting|remove|erase|wipe|purge|trash|destroy|drop table|unsubscribe|archive all|empty (the )?trash)\b/i
const POST_WORDS = /\b(post|posts|publish|publishes|tweet|retweet|share publicly|go live|announce|comment on|reply publicly)\b/i
const PUBLIC_PLACES = /\b(twitter|x\.com|tweet|linkedin|reddit|facebook|instagram|threads|tiktok|youtube|mastodon|bluesky|medium|substack|wordpress|ghost|blog|forum|discord|slack|public|website|github__create_(issue|comment|release)|producthunt|hacker ?news)\b/i
const MASS_WORDS = /\b(bulk|mass|broadcast|newsletter|blast|campaign|everyone|all (contacts|subscribers|customers|users|members))\b/i
const SEND_WORDS = /\b(send|sends|email|e-mail|message|sms|text|invite|forward|notify)\b/i
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g

/** Recipients named in a call's arguments (to / cc / bcc / recipients / emails, arrays or comma lists). */
export function recipientCount(args: unknown): number {
  const seen = new Set<string>()
  const walk = (v: unknown, key: string, depth: number): void => {
    if (depth > 4) return
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1); return }
    if (typeof v !== 'string' || !/^(to|cc|bcc|recipients?|emails?|addresses|phones?|numbers?|users?|members?|attendees|invitees|contacts?)$/i.test(key)) return
    const emails = v.match(EMAIL)
    if (emails?.length) emails.forEach((e) => seen.add(e.toLowerCase()))
    else v.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).forEach((x) => seen.add(x.toLowerCase()))
  }
  walk(args, '', 0)
  return seen.size
}

/**
 * A hard stop for an always-on bot: an action that always asks the user, even in Auto, with an
 * Allow rule or "Always allow", and that a question's deadline never decides on its own. Money moves and
 * purchases, credentials and one-time codes, and whatever the user listed under "Always ask for…" for this
 * bot: the same things Auto asks for everywhere (decide()). Deleting (files go to the Trash, mail to its Trash),
 * team-chat posts, sends and posts run like in any other chat; taint still asks for whatever outside content
 * steered. Reads are never stopped here (decide() already asks for reads with a hard stop or taint). Purchases
 * and one-time codes keep their own cards.
 */
export function botHardStop(a: { tool: string; effect: ToolEffect; args: unknown; label?: string; summary?: string; hardStop?: string | null; alwaysAsk?: string[]; argsText?: string; trusted?: boolean }): { kind: BotStopKind; reason: string } | null {
  if (isSelfGated(a.hardStop)) return null
  const argsText = a.argsText ?? (() => { try { return JSON.stringify(a.args ?? {}) } catch { return '' } })()
  const rules = (a.alwaysAsk ?? []).filter((w) => typeof w === 'string' && w.trim()).slice(0, RULE_LIMIT)
  const hit = rules.find((w) => ruleMatches(w, { tool: a.tool, label: a.label, summary: a.summary, args: argsText }))
  if (hit) return { kind: 'always_ask', reason: `You asked this bot to always ask for "${hit}"` }
  if (a.effect === 'read') return null
  // A code or password in what a step sends stops it; money is judged by spendsMoney (a command, an email or a
  // reminder that mentions "pay" or "$313.20" spends nothing).
  const local = NO_SPEND_TOOLS.has(a.tool)
  const head = [a.tool.replace(/[_-]+/g, ' '), a.label, a.summary].filter(Boolean).join(' \n')
  // A send to trusted people only (decide() allowed it, agent/trusted.ts capped its size and rate): a message
  // can't buy, so only "always ask" and credentials (a code or password in the text) stop it.
  if (a.trusted) return CREDENTIAL_WORDS.test(head) || CREDENTIAL_WORDS.test(a.hardStop ?? '') ? { kind: 'credentials', reason: 'Uses a password, code or other credential' } : null
  const declared = a.hardStop ?? ''
  const outside = a.effect === 'write_external' || a.effect === 'destructive'
  if (outside && spendsMoney(a.tool, a.summary, declared)) return { kind: 'money', reason: 'Moves money or buys something' }
  if (CREDENTIAL_WORDS.test(head) || isCredentialStop(declared) || (!local && CREDENTIAL_WORDS.test(declared)) || /(^|[_\W])(vault|secrets?|passwords?)([_\W]|$)/i.test(a.tool)) return { kind: 'credentials', reason: 'Uses a password, code or other credential' }
  return null
}

/** Question or default text that touches a hard stop: a deadline never answers it on its own. */
export function hardStopText(...texts: Array<string | undefined>): string | null {
  const t = texts.filter(Boolean).join('\n')
  if (!t) return null
  if (MONEY_WORDS.test(t) || PAYMENT.test(t)) return 'it involves money or a purchase'
  if (CREDENTIAL_WORDS.test(t) || /\b(log ?in|sign ?in|sign-in)\b/i.test(t)) return 'it involves a password, code or credential'
  if (DELETE_WORDS.test(t)) return 'it deletes something'
  if (MASS_WORDS.test(t) && SEND_WORDS.test(t)) return 'it sends to many people'
  if (POST_WORDS.test(t) && PUBLIC_PLACES.test(t)) return 'it posts publicly'
  return null
}
