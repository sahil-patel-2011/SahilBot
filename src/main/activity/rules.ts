import { lineSecret } from '../code/git'
import { looksLikeSecret, scrubSecrets } from '../browser/teach'
import { redactSecrets } from '../knowledge/ignore'
import type { ActivitySettings } from '@shared/types'

// What "Know what I'm working on" may keep from one look at the front app, decided before anything is
// stored. Password managers, SahilBot itself and the user's excluded apps leave no trace at all;
// messaging and mail apps (and webmail and web chat) keep only their name; private windows, banking and
// health sites, secret-looking titles and titles with an email address keep only the app's name; a
// browser page whose address wasn't read (Firefox, Opera, Vivaldi, Zen, no Automation, tabs off) keeps
// only the browser's name, since its title alone can't be checked against those lists; addresses keep
// only host + path (never the query).

/** What one look at the Mac returned (from the sampler; nothing here is trusted). */
export interface RawSample {
  app: string
  bundleId: string
  pid?: number
  /** The focused window's title (Accessibility); undefined when not read. */
  title?: string
  /** The focused window's document (AXDocument: a file URL or path). */
  document?: string
  /** The front browser tab, when read. */
  tab?: { title: string; url: string; private?: boolean }
}

/** What gets stored: already cleaned and excluded. */
export interface CleanSample {
  app: string
  bundleId: string
  /** The current file or document (editors, Office, iWork). */
  doc?: string
  /** The project or folder the file belongs to (VS Code, Cursor, Xcode). */
  project?: string
  /** A window or page title. */
  title?: string
  /** host + path of the front tab (no query, no fragment). */
  url?: string
  host?: string
  /** Why the details were left out (for the preview: "Messages (titles hidden)"). */
  hidden?: 'messaging' | 'private' | 'sensitive-site' | 'secret' | 'excluded-site' | 'personal' | 'unchecked-page'
}

export type Verdict = { skip: 'self' | 'password-manager' | 'excluded-app' | 'empty' } | { sample: CleanSample }

// ---------------------------------------------------------------------------------------- built-in lists

/** Password managers: never recorded at all (not even that one was open). */
export const PASSWORD_MANAGERS: Array<{ name: string; bundle: RegExp }> = [
  { name: '1Password', bundle: /^com\.(1password|agilebits)\./i },
  { name: 'Bitwarden', bundle: /^com\.bitwarden\./i },
  { name: 'Keychain Access', bundle: /^com\.apple\.keychainaccess$/i },
  { name: 'Passwords', bundle: /^com\.apple\.Passwords$/i },
  { name: 'LastPass', bundle: /^com\.lastpass\./i },
  { name: 'Dashlane', bundle: /^com\.dashlane\./i },
  { name: 'KeePassXC', bundle: /keepass/i },
  { name: 'Enpass', bundle: /enpass/i },
  { name: 'NordPass', bundle: /nordpass/i },
  { name: 'Proton Pass', bundle: /^(me|ch)\.proton\.pass/i },
  { name: 'Keeper', bundle: /keepersecurity/i },
  { name: 'Security Agent', bundle: /^com\.apple\.(SecurityAgent|LocalAuthentication)/i }
]
const PASSWORD_NAMES = /^(1password( \d+)?|bitwarden|keychain access|passwords|lastpass|dashlane|keepassxc?|macpass|strongbox|enpass|nordpass|proton pass|keeper( password manager)?|securityagent)$/i

/** Messaging and mail apps: their window titles are other people's names and message subjects; only the app's name is kept. */
export const MESSAGING_APPS: Array<{ name: string; bundle: RegExp }> = [
  { name: 'Messages', bundle: /^com\.apple\.(MobileSMS|iChat)$/i },
  { name: 'Mail', bundle: /^com\.apple\.mail$/i },
  { name: 'FaceTime', bundle: /^com\.apple\.FaceTime$/i },
  { name: 'Slack', bundle: /^com\.tinyspeck\.slackmacgap$/i },
  { name: 'Discord', bundle: /^com\.hnc\.Discord$/i },
  { name: 'WhatsApp', bundle: /whatsapp/i },
  { name: 'Telegram', bundle: /telegram|keepcoder/i },
  { name: 'Signal', bundle: /^org\.whispersystems\./i },
  { name: 'Microsoft Teams', bundle: /^com\.microsoft\.teams/i },
  { name: 'Microsoft Outlook', bundle: /^com\.microsoft\.Outlook$/i },
  { name: 'Messenger', bundle: /^com\.facebook\.archon/i },
  { name: 'WeChat', bundle: /^com\.tencent\.xin/i },
  { name: 'Zoom', bundle: /^us\.zoom\./i },
  { name: 'Skype', bundle: /^com\.skype\./i },
  { name: 'Spark', bundle: /^com\.readdle\.smartemail/i },
  { name: 'Airmail', bundle: /airmail/i },
  { name: 'Element', bundle: /^im\.riot\./i },
  { name: 'Beeper', bundle: /beeper/i }
]
const MESSAGING_NAMES = /^(messages|mail|facetime|slack|discord|whatsapp|telegram|signal|microsoft teams( \(work or school\))?|teams|microsoft outlook|outlook|messenger|wechat|zoom\.us|zoom|skype|spark( desktop)?|airmail( \d)?|element|beeper|mimestream|superhuman)$/i

/**
 * Banking, money and health sites: only "Safari" or "Chrome" is kept, never the page. Matched on the
 * host and its parents (chase.com covers secure.chase.com). Keyword hosts (…bank…, mychart…) too.
 */
export const SENSITIVE_DOMAINS = [
  // banks, cards, brokers, payments, crypto, credit, tax
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'capitalone.com', 'usbank.com', 'pnc.com', 'truist.com',
  'tdbank.com', 'td.com', 'ally.com', 'sofi.com', 'chime.com', 'discover.com', 'americanexpress.com', 'synchrony.com', 'navyfederal.org',
  'usaa.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'etrade.com', 'robinhood.com', 'webull.com', 'interactivebrokers.com', 'merrilledge.com',
  'morganstanley.com', 'goldmansachs.com', 'marcus.com', 'wealthfront.com', 'betterment.com', 'acorns.com', 'stash.com', 'public.com',
  'paypal.com', 'venmo.com', 'cash.app', 'zellepay.com', 'wise.com', 'revolut.com', 'monzo.com', 'starlingbank.com', 'n26.com',
  'coinbase.com', 'kraken.com', 'binance.com', 'binance.us', 'gemini.com', 'crypto.com', 'blockchain.com', 'metamask.io',
  'creditkarma.com', 'experian.com', 'equifax.com', 'transunion.com', 'annualcreditreport.com', 'mint.intuit.com', 'monarchmoney.com',
  'ynab.com', 'rocketmoney.com', 'turbotax.intuit.com', 'hrblock.com', 'irs.gov', 'ssa.gov', 'treasurydirect.gov',
  'hsbc.com', 'barclays.co.uk', 'santander.com', 'lloydsbank.com', 'natwest.com', 'rbcroyalbank.com', 'scotiabank.com', 'bmo.com', 'cibc.com',
  // health, insurance, pharmacy, therapy
  'mychart.com', 'kaiserpermanente.org', 'healthcare.gov', 'medicare.gov', 'cvs.com', 'walgreens.com', 'goodrx.com', 'zocdoc.com',
  'teladoc.com', 'onemedical.com', 'labcorp.com', 'questdiagnostics.com', '23andme.com', 'ancestry.com', 'betterhelp.com', 'talkspace.com',
  'cerebral.com', 'hims.com', 'forhers.com', 'ro.co', 'nurx.com', 'cigna.com', 'aetna.com', 'uhc.com', 'myuhc.com', 'anthem.com', 'bcbs.com',
  'humana.com', 'webmd.com', 'healthline.com', 'mayoclinic.org', 'clevelandclinic.org', 'patient.info', 'followmyhealth.com', 'athenahealth.com',
  'myhealth.va.gov', 'va.gov', 'nhs.uk',
  // accounts and password managers on the web
  'accounts.google.com', 'myaccount.google.com', 'passwords.google.com', 'appleid.apple.com', 'account.apple.com', 'icloud.com',
  'login.microsoftonline.com', 'account.microsoft.com', '1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com'
]
const SENSITIVE_KEYWORDS = /(^|[.-])([a-z0-9-]*bank[a-z0-9-]*|[a-z0-9-]*banking|creditunion|[a-z0-9-]*fcu|mychart|[a-z0-9-]*patientportal|[a-z0-9-]*pharmacy|[a-z0-9-]*clinic)\./i

/**
 * Webmail and web chat: like the Mail and Messages apps, only the browser's name (titles are people's
 * names and message subjects). host, or host + path prefix.
 */
export const WEB_MESSAGING: Array<{ host: string; path?: RegExp }> = [
  { host: 'mail.google.com' }, { host: 'inbox.google.com' }, { host: 'chat.google.com' }, { host: 'messages.google.com' },
  { host: 'outlook.live.com' }, { host: 'outlook.office.com' }, { host: 'outlook.office365.com' }, { host: 'outlook.cloud.microsoft' },
  { host: 'teams.microsoft.com' }, { host: 'teams.live.com' }, { host: 'teams.cloud.microsoft' },
  { host: 'web.whatsapp.com' }, { host: 'messenger.com' }, { host: 'app.slack.com' }, { host: 'discord.com' }, { host: 'ptb.discord.com' }, { host: 'canary.discord.com' },
  { host: 'web.telegram.org' }, { host: 'mail.yahoo.com' }, { host: 'mail.proton.me' }, { host: 'mail.protonmail.com' }, { host: 'app.fastmail.com' },
  { host: 'mail.zoho.com' }, { host: 'mail.aol.com' }, { host: 'app.hey.com' }, { host: 'web.skype.com' }, { host: 'web.wechat.com' },
  { host: 'icloud.com', path: /^\/(mail|messages)\b/i }, { host: 'facebook.com', path: /^\/messages\b/i }, { host: 'instagram.com', path: /^\/direct\b/i },
  { host: 'x.com', path: /^\/(messages|i\/chat)\b/i }, { host: 'twitter.com', path: /^\/messages\b/i }, { host: 'linkedin.com', path: /^\/messaging\b/i }
]

export function isWebMessaging(host: string, path = '/'): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  return WEB_MESSAGING.some((w) => (h === w.host || h.endsWith(`.${w.host}`)) && (!w.path || w.path.test(path)))
}

/** An email address anywhere in the text (a title naming a person's mailbox or a message's sender). */
export const HAS_EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/i

/** Browsers whose front tab can be read by script. kind: which dictionary. */
export const SCRIPTABLE_BROWSERS: Array<{ name: string; bundleId: string; kind: 'safari' | 'chromium' | 'arc' }> = [
  { name: 'Safari', bundleId: 'com.apple.Safari', kind: 'safari' },
  { name: 'Safari Technology Preview', bundleId: 'com.apple.SafariTechnologyPreview', kind: 'safari' },
  { name: 'Google Chrome', bundleId: 'com.google.Chrome', kind: 'chromium' },
  { name: 'Google Chrome Beta', bundleId: 'com.google.Chrome.beta', kind: 'chromium' },
  { name: 'Arc', bundleId: 'company.thebrowser.Browser', kind: 'arc' },
  { name: 'Brave Browser', bundleId: 'com.brave.Browser', kind: 'chromium' },
  { name: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac', kind: 'chromium' }
]
/** Any browser (titles only for the ones without a script dictionary). */
const BROWSER_BUNDLES = /^(com\.apple\.Safari|com\.google\.Chrome|company\.thebrowser\.|com\.brave\.Browser|com\.microsoft\.edgemac|org\.mozilla\.|com\.operasoftware\.|com\.vivaldi\.|org\.chromium\.|com\.kagi\.kagimacOS|app\.zen-browser)/i

export const browserFor = (bundleId: string): (typeof SCRIPTABLE_BROWSERS)[number] | undefined => SCRIPTABLE_BROWSERS.find((b) => b.bundleId.toLowerCase() === bundleId.toLowerCase())
export const isBrowser = (bundleId: string): boolean => BROWSER_BUNDLES.test(bundleId)

/** A private/incognito window, from its title (every browser marks it there, or in its name). */
export const PRIVATE_TITLE = /\b(private browsing|incognito|inprivate)\b|[—–-]\s*private\s*$|\(private\)\s*$/i

export function isPasswordManager(app: string, bundleId: string): boolean {
  return PASSWORD_MANAGERS.some((p) => p.bundle.test(bundleId)) || PASSWORD_NAMES.test(app.trim())
}

export function isMessaging(app: string, bundleId: string): boolean {
  return MESSAGING_APPS.some((p) => p.bundle.test(bundleId)) || MESSAGING_NAMES.test(app.trim())
}

/** "https://www.Chase.com/x" or "chase.com/" → "chase.com"; '' for anything that isn't a domain. */
export function normalizeDomain(d: string): string {
  let s = String(d ?? '').trim().toLowerCase()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : ''
}

const underDomain = (host: string, d: string): boolean => host === d || host.endsWith(`.${d}`)

export function isSensitiveHost(host: string, extra: string[] = []): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  if (!h) return false
  if (h.endsWith('.bank') || h.endsWith('.insurance')) return true
  if (SENSITIVE_DOMAINS.some((d) => underDomain(h, d))) return true
  if (SENSITIVE_KEYWORDS.test(`.${h}.`)) return true
  return extra.some((d) => d && underDomain(h, d))
}

/** One line, no control or bidi characters, no angle brackets (it rides inside a <context> block), at most `max` characters. */
export function cleanText(s: string | undefined, max = 120): string {
  const flat = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, ' ')
    .replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'))
    .replace(/`{3,}/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : flat
}

/**
 * Text that looks like (or contains) a secret: keys and tokens, key=value secrets, card numbers, SSNs,
 * one-time codes, long random runs. Runs every detector SahilBot has; any hit hides the whole title.
 */
export function looksSecretTitle(t: string): boolean {
  if (!t.trim()) return false
  if (scrubSecrets(t) !== t) return true
  if (redactSecrets(t) !== t) return true
  if (lineSecret(t)) return true
  if (t.split(/[\s"'`,;()[\]{}|]+/).some((w) => w.length >= 16 && looksLikeSecret(w) && !/^[a-z]+(-[a-z]+)*$/i.test(w))) return true
  // "Your code is 482913", "PIN: 4821", "verification code 12-34-56".
  if (/\b(code|otp|pin|passcode|verification|one[- ]time|2fa|mfa)\b\D{0,24}\d(?:[ -]?\d){3,7}\b/i.test(t)) return true
  if (/\b(password|passwd|passphrase)\b\s*[:=]/i.test(t)) return true
  return false
}

/** Short app names for the timeline ("Google Chrome" → "Chrome"). */
export function shortApp(app: string): string {
  const a = app.trim()
  const map: Record<string, string> = {
    'Google Chrome': 'Chrome', 'Google Chrome Beta': 'Chrome Beta', 'Brave Browser': 'Brave', 'Microsoft Edge': 'Edge', 'Code': 'VS Code',
    'Visual Studio Code': 'VS Code', 'Visual Studio Code - Insiders': 'VS Code Insiders', 'Microsoft Word': 'Word', 'Microsoft Excel': 'Excel',
    'Microsoft PowerPoint': 'PowerPoint', 'Microsoft Outlook': 'Outlook', 'Microsoft Teams': 'Teams', 'zoom.us': 'Zoom', 'Firefox': 'Firefox'
  }
  return map[a] ?? a
}

// ------------------------------------------------------------------------------- the current file

const EDITORS = /^(com\.microsoft\.VSCode(Insiders)?|com\.todesktop\.230313mzl4w4u92|com\.exafunction\.windsurf|dev\.zed\.Zed(-Preview)?|com\.vscodium|com\.google\.antigravity)$/i
const EDITOR_NAMES = /^(code|visual studio code( - insiders)?|cursor|windsurf|zed|vscodium)$/i
const XCODE = /^com\.apple\.dt\.Xcode$/i
const OFFICE = /^com\.microsoft\.(Word|Excel|Powerpoint)$/i
const IWORK = /^com\.apple\.iWork\.(Pages|Numbers|Keynote)$/i
const DOC_APPS = /^(com\.apple\.(TextEdit|Preview)|com\.adobe\.(Acrobat|Reader)|com\.apple\.iWork\.)/i

const parts = (t: string): string[] => t.split(/\s+[—–]\s+|\s+-\s+/).map((p) => p.trim()).filter(Boolean)

/** The file's name from AXDocument (a file:// URL or a path); never the folders above it. */
export function docName(document: string | undefined): string | undefined {
  const d = String(document ?? '').trim()
  if (!d) return undefined
  let path = d
  if (/^file:\/\//i.test(d)) { try { path = decodeURIComponent(new URL(d).pathname) } catch { return undefined } } else if (/^[a-z][a-z0-9+.-]*:/i.test(d)) return undefined
  const name = path.replace(/\/+$/, '').split('/').pop()
  return name || undefined
}

/**
 * The current file (and project) from the window title: "● loop.ts — SahilBot — Visual Studio Code",
 * "SahilBot — Agent.swift" (Xcode), "Report.docx - Compatibility Mode" (Word), "Proposal — Edited" (Pages).
 */
export function fileFromTitle(app: string, bundleId: string, title: string, document?: string): { doc?: string; project?: string } {
  const fromAx = docName(document)
  const t = title.replace(/^[●•*]\s*/, '').replace(/\s*\[(extension development host|administrator|read-only|unlicensed)\]\s*/gi, ' ').trim()
  if (EDITORS.test(bundleId) || EDITOR_NAMES.test(app.trim())) {
    const p = parts(t)
    if (p.length && /^(visual studio code|code|cursor|windsurf|zed|vscodium)( - insiders)?$/i.test(p[p.length - 1])) p.pop()
    if (!p.length) return fromAx ? { doc: fromAx } : {}
    if (p.length === 1) return /\.[a-z0-9]{1,8}$/i.test(p[0]) ? { doc: p[0] } : { project: p[0] }
    return { doc: fromAx ?? p[0], project: p[1] }
  }
  if (XCODE.test(bundleId)) {
    const p = parts(t)
    if (p.length >= 2) return { doc: fromAx ?? p[p.length - 1], project: p[0] }
    return fromAx || p[0] ? { doc: fromAx ?? p[0] } : {}
  }
  if (OFFICE.test(bundleId) || IWORK.test(bundleId)) {
    const p = parts(t).filter((x) => !/^(compatibility mode|read-only|edited|saved( to [\w ]+)?|autosaved|locked|protected view|shared|repaired|recovered)$/i.test(x))
    return fromAx || p[0] ? { doc: fromAx ?? p[0] } : {}
  }
  if (fromAx && DOC_APPS.test(bundleId)) return { doc: fromAx }
  return fromAx ? { doc: fromAx } : {}
}

/** https://docs.wpilib.org/en/stable/x?y=1#z → { host: 'docs.wpilib.org', url: 'docs.wpilib.org/en/stable/x' }; key-like path parts drop the path. */
export function cleanUrl(raw: string): { host?: string; url?: string } {
  let u: URL
  try { u = new URL(raw) } catch { return {} }
  if (!/^https?:$/.test(u.protocol)) return {}
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (!host) return {}
  let segs: string[] = []
  try { segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s)) } catch { segs = [] }
  // A token, code or e-mail address in the path: the host alone.
  if (segs.some((s) => looksLikeSecret(s) || looksSecretTitle(s) || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(s) || /^\d{9,}$/.test(s))) return { host, url: host }
  const path = segs.length ? `/${segs.join('/')}` : ''
  return { host, url: cleanText(`${host}${path}`, 140) }
}

// ------------------------------------------------------------------------------------ the decision

export type Rules = Pick<ActivitySettings, 'excludedApps' | 'excludedDomains' | 'windowTitles' | 'browserTabs'> & {
  /** This app (never recorded). */
  self?: { pid?: number; bundleId?: string; names?: string[] }
}

const SELF_NAMES = /^(sahilbot|foreman)$/i

/** What may be kept from one look at the front app (or why nothing may). */
export function classify(raw: RawSample | null | undefined, r: Rules): Verdict {
  const app = cleanText(raw?.app, 60)
  const bundleId = String(raw?.bundleId ?? '').trim().slice(0, 200)
  if (!raw || (!app && !bundleId)) return { skip: 'empty' }
  const selfNames = (r.self?.names ?? []).map((n) => n.toLowerCase())
  if ((r.self?.pid && raw.pid === r.self.pid) || (r.self?.bundleId && bundleId.toLowerCase() === r.self.bundleId.toLowerCase()) || SELF_NAMES.test(app) || selfNames.includes(app.toLowerCase())) return { skip: 'self' }
  if (isPasswordManager(app, bundleId)) return { skip: 'password-manager' }
  const excluded = r.excludedApps.map((a) => a.trim().toLowerCase()).filter(Boolean)
  if (excluded.includes(app.toLowerCase()) || excluded.includes(bundleId.toLowerCase()) || excluded.includes(shortApp(app).toLowerCase())) return { skip: 'excluded-app' }
  const base: CleanSample = { app: app || bundleId, bundleId }
  if (isMessaging(app, bundleId)) return { sample: { ...base, hidden: 'messaging' } }

  const title = r.windowTitles ? String(raw.title ?? '') : ''
  const browser = isBrowser(bundleId)
  // A private window: nothing about it but the browser's name.
  if ((browser && PRIVATE_TITLE.test(title)) || raw.tab?.private) return { sample: { ...base, hidden: 'private' } }

  const extra = r.excludedDomains.map(normalizeDomain).filter(Boolean)
  // A browser page whose address wasn't read: its title can't be checked against the excluded,
  // sensitive or messaging sites, so only the browser's name is kept.
  if (browser && !(raw.tab && r.browserTabs && cleanUrl(raw.tab.url).host)) return { sample: { ...base, hidden: 'unchecked-page' } }
  if (browser && raw.tab && r.browserTabs) {
    const { host, url } = cleanUrl(raw.tab.url)
    if (host && extra.some((d) => underDomain(host, d))) return { sample: { ...base, hidden: 'excluded-site' } }
    let path = '/'
    try { path = new URL(raw.tab.url).pathname || '/' } catch { path = '/' }
    if (host && isWebMessaging(host, path)) return { sample: { ...base, hidden: 'messaging' } }
    if (host && isSensitiveHost(host)) return { sample: { ...base, hidden: 'sensitive-site' } }
    const pageTitle = String(raw.tab.title || title || '')
    if (looksSecretTitle(pageTitle)) return { sample: { ...base, ...(host ? { host } : {}), hidden: 'secret' } }
    if (HAS_EMAIL.test(pageTitle)) return { sample: { ...base, ...(host ? { host } : {}), hidden: 'personal' } }
    const out: CleanSample = { ...base }
    const tt = cleanText(pageTitle)
    if (tt) out.title = tt
    if (host) { out.host = host; if (url) out.url = url }
    return { sample: out }
  }
  if (!title.trim()) {
    const doc = docName(raw.document)
    return { sample: doc && !looksSecretTitle(doc) && r.windowTitles ? { ...base, doc: cleanText(doc, 80) } : base }
  }
  if (looksSecretTitle(title) || looksSecretTitle(String(raw.document ?? ''))) return { sample: { ...base, hidden: 'secret' } }
  if (HAS_EMAIL.test(title) || HAS_EMAIL.test(String(raw.document ?? ''))) return { sample: { ...base, hidden: 'personal' } }
  // A browser without a script dictionary (or tabs off): the title may name a sensitive site ("Chase - Sign in").
  if (browser && /\b(bank|banking|credit union|mychart|patient portal|pharmacy)\b/i.test(title)) return { sample: { ...base, hidden: 'sensitive-site' } }
  const file = fileFromTitle(app, bundleId, title, raw.document)
  const out: CleanSample = { ...base }
  if (file.doc) out.doc = cleanText(file.doc, 80)
  if (file.project) out.project = cleanText(file.project, 60)
  if (!file.doc && !file.project) {
    // The app's own name as a title adds nothing ("Finder", "Onshape").
    const tt = cleanText(title.replace(/\s+[—–-]\s+(Mozilla Firefox|Google Chrome|Safari|Opera|Vivaldi)$/i, ''))
    if (tt && tt.toLowerCase() !== app.toLowerCase()) out.title = tt
  }
  return { sample: out }
}

/** The timeline label for a sample: "Chrome — WPILib docs: SysId", "VS Code — loop.ts (SahilBot)", "Messages". */
export function labelOf(s: CleanSample): string {
  const app = shortApp(s.app)
  if (s.hidden === 'messaging') return app
  if (s.hidden === 'private') return `${app} (private window)`
  if (s.hidden) return app
  if (s.doc) return `${app} — ${s.doc}${s.project ? ` (${s.project})` : ''}`
  if (s.project) return `${app} — ${s.project}`
  if (s.title) return `${app} — ${s.title}`
  if (s.host) return `${app} — ${s.host}`
  return app
}

/** The "now" line's detail: the label plus where (host + path) for a page. */
export function detailOf(s: CleanSample): string {
  const label = labelOf(s)
  return s.url && !s.hidden ? `${label} (${s.url})` : label
}
