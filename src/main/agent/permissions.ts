import type { PermissionMode } from '@shared/types'
import type { Decision, PermissionInput } from './types'

const STRICTNESS: Record<PermissionMode, number> = { ask: 3, auto: 2, autonomous: 1, bypass: 0 }

/** Every autonomy level, strictest first. */
export const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto', 'autonomous', 'bypass']
export const isPermissionMode = (m: unknown): m is PermissionMode => typeof m === 'string' && m in STRICTNESS

/**
 * Tools that only write inside the workspace and attached folders, and keep a backup when they overwrite
 * something (files.ts backup()). Autonomous runs their overwrites; deleting still asks (a hard stop).
 */
export const BACKED_UP_OVERWRITES = new Set(['file_write', 'file_manage', 'create_document'])

/** The stricter of two permission modes (ask > auto > autonomous > bypass). A missing one doesn't loosen anything. */
export function stricterMode(a: PermissionMode, b?: PermissionMode | null): PermissionMode {
  if (!b || !(b in STRICTNESS)) return a
  return STRICTNESS[b] > STRICTNESS[a] ? b : a
}

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

  // A read that opens an address steered by fetched content can leak data in the URL itself.
  if (p.effect === 'read') return p.tainted && p.mode !== 'bypass' ? { verdict: 'ask', reason: 'Opens an address taken from a web page or email' } : { verdict: 'allow' }

  if (p.hardStop && (p.mode !== 'bypass' || p.hardStopsEnabled)) {
    return { verdict: 'ask', reason: `Hard stop: ${p.hardStop}` }
  }

  // Nobody is there to watch an unattended run (routines, wake-ups): Autonomous works like Auto there.
  const mode: PermissionMode = p.unattended && p.mode === 'autonomous' ? 'auto' : p.mode
  // Taint is checked before the local-write shortcut: a terminal command steered by fetched content asks
  // whatever it does (checkTaint flags run_command at every effect; other tools' local writes never are).
  if (p.tainted && (mode === 'auto' || mode === 'autonomous')) return { verdict: 'ask', reason: 'Uses details taken from a web page or email' }
  switch (mode) {
    case 'bypass':
      return { verdict: 'allow' }
    case 'autonomous':
      // Auto, plus: project commands (installs from the lockfile, git fetch/pull) and overwrites inside
      // your folders that keep a backup. Taint, hard stops (deleting, sending, buying, credentials,
      // security, history rewrites) and every other consequential outside action still ask.
      if (p.effect === 'write_local') return { verdict: 'allow' }
      if (p.effect === 'write_external' && (p.consequential === false || p.consequential === 'project')) return { verdict: 'allow' }
      if (p.alwaysAllowed && p.effect === 'write_external') return { verdict: 'allow' }
      if (p.effect === 'destructive' && BACKED_UP_OVERWRITES.has(p.tool)) return { verdict: 'allow' }
      return { verdict: 'ask', reason: p.effect === 'destructive' ? 'Deletes or replaces something' : 'Acts outside this Mac (Autonomous still asks for this)' }
    case 'auto':
      if (p.effect === 'write_local') return { verdict: 'allow' }
      // Routine outside actions (sign in, next page, search, save draft) don't interrupt the user.
      if (p.effect === 'write_external' && p.consequential === false) return { verdict: 'allow' }
      if (p.alwaysAllowed && p.effect === 'write_external') return { verdict: 'allow' }
      return { verdict: 'ask', reason: p.effect === 'destructive' ? 'Destructive action' : 'Acts outside this Mac' }
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

/**
 * True when an argument carries an address, number or 8-word run that appears in
 * untrusted tool output but nowhere in what the user typed. That's the signature
 * of a page or email steering the agent ("send the file to attacker@…").
 */
export function isTainted(args: unknown, untrusted: string[], userText: string): boolean {
  if (!untrusted.length) return false
  const corpus = untrusted.join('\n').toLowerCase()
  const user = userText.toLowerCase()
  for (const s of strings(args)) {
    for (const m of s.matchAll(ENTITY)) {
      const e = m[0].toLowerCase().trim()
      if (corpus.includes(e) && !user.includes(e)) return true
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

/**
 * A URL steered by fetched content: its host appears in untrusted output but not in what the user typed,
 * and the URL itself is not a link copied verbatim from that output (so the agent built it, e.g. by
 * appending private data to a query string).
 */
export function urlTainted(url: string, untrusted: string[], userText: string): boolean {
  if (!untrusted.length) return false
  let host: string
  let parsed: URL
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`); host = parsed.hostname.toLowerCase().replace(/^www\./, '') } catch { return false }
  // Only a URL that can carry data out matters: a query, or a long path segment. Plain pages on a site
  // (its /login, /form) are ordinary browsing.
  const carries = parsed.search.length > 24 || parsed.pathname.split('/').some((p) => p.length > 40)
  if (!carries) return false
  const corpus = untrusted.join('\n').toLowerCase()
  const user = userText.toLowerCase()
  if (!host || user.includes(host) || !corpus.includes(host)) return false
  const u = url.toLowerCase().replace(/\/+$/, '')
  return !corpus.includes(u) && !user.includes(u)
}

/** Tools whose read calls load a URL the agent chose. */
const URL_READS: Record<string, (args: any) => string | undefined> = {
  fetch_page: (a) => a?.url,
  browser: (a) => (a?.action === 'navigate' || (a?.action === 'tabs' && a?.op === 'new') ? a?.url : undefined)
}

/** Tools whose every call is checked for taint, whatever its effect: a terminal command can do anything. */
export const ALWAYS_TAINT_CHECKED = new Set(['run_command'])

/** Whether a call's arguments were steered by fetched content, for decide()'s `tainted`. */
export function checkTaint(tool: string, effect: string, args: unknown, untrusted: string[], userText: string): boolean {
  if (effect === 'write_external' || effect === 'destructive' || ALWAYS_TAINT_CHECKED.has(tool)) return isTainted(args, untrusted, userText) || (effect === 'read' && urlTaintedRead(tool, args, untrusted, userText))
  if (effect !== 'read') return false
  return urlTaintedRead(tool, args, untrusted, userText)
}

function urlTaintedRead(tool: string, args: unknown, untrusted: string[], userText: string): boolean {
  const url = URL_READS[tool]?.(args)
  return !!url && urlTainted(url, untrusted, userText)
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
 * Why a memory-tool call must ask, or null. Saving a standing rule always asks (see the tool's hardStop);
 * a memory or skill asks when its text was taken from fetched content, or when this run read untrusted
 * content and the text reads like an instruction. Work-log entries never ask. Ordinary saves of what the
 * user said stay frictionless.
 */
export function memoryRisk(args: unknown, untrusted: string[], userText: string, sawUntrusted: boolean): string | null {
  const a = (args ?? {}) as Record<string, unknown>
  if (a.action !== 'save' && a.action !== 'save_skill') return null
  if (a.action === 'save' && typeof a.category === 'string' && WORKLOG.test(a.category)) return null
  const text = a.action === 'save' ? String(a.fact ?? '') : [a.name, a.description, a.steps].filter((x) => typeof x === 'string').join('\n')
  const what = a.action === 'save' ? 'a memory every future chat sees' : 'a skill future chats can follow'
  if (isTainted(a.action === 'save' ? { fact: a.fact } : { name: a.name, description: a.description, steps: a.steps }, untrusted, userText)) return `saving ${what}, with details taken from a web page or email`
  if (sawUntrusted && looksInstructionLike(text)) return `saving ${what} after reading a web page or email (it reads like an instruction)`
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
