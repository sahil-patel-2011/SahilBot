import type { ConnectorPreset, ConnectorStatus } from '@shared/types'

// Connect Apps catalog: how presets group into chips and sections (pure; shared with unit tests).

/** Chips shown in the row; everything else lives under "More". */
/** Chips beside All, most common first; everything else (Password Managers included) is under More. */
export const MAIN_CHIPS = ['Productivity', 'Communication', 'Code', 'Design'] as const

/** Section order in the All view (after "Recommended for you"). */
export const SECTION_ORDER = ['Built in', 'On this Mac', 'Productivity', 'Communication', 'Code', 'Design', 'Support', 'Media & AI', 'Password Managers', 'Data & analytics', 'Sales & marketing', 'Social', 'Finance & commerce', 'HR & recruiting', 'Legal', 'Travel & real estate', 'Education & science', 'Health & fitness', 'Research', 'Other'] as const

/** Categories under the More ▾ chip. */
export const MORE_CATEGORIES: string[] = SECTION_ORDER.filter((c) => !(MAIN_CHIPS as readonly string[]).includes(c))

/** The chip a category is reached from: itself for a main chip, else "More". */
export function chipOf(category: string): string {
  return (MAIN_CHIPS as readonly string[]).includes(category) ? category : 'More'
}

/**
 * Popular apps people connect first, in order (one-click apps are shown before ones that need setup).
 * A spread on purpose: notes, tasks, design, files, search, money and code, so the first screen shows
 * something for most people rather than six dev tools.
 */
const RECOMMENDED = ['notion', 'gmail', 'gcal', 'figma', 'linear', 'fathom', 'canva', 'dropbox', 'exa', 'kiwi', 'granola', 'trello', 'zillow', 'gitlab', 'stripe', 'tavily', 'strava', 'heygen', 'vercel', 'cloudflare', 'slack', 'github', 'gdrive', 'gsheets', 'asana']

/**
 * Signs in with one click: the app registers SahilBot itself (DCR), needs no sign-in, or SahilBot
 * ships its own app registration for it (`builtinClient`). Same rule as main (connectors.isOneClick).
 */
export function isOneClick(p: Pick<ConnectorPreset, 'auth' | 'builtinClient'>): boolean {
  return p.auth === 'oauth' || p.auth === 'none' || ((p.auth === 'oauth-static' || p.auth === 'google') && !!p.builtinClient)
}

/** Needs a one-time setup before the first sign-in: an OAuth app at the provider (or Google) and no built-in client yet. */
export function needsSetup(p: Pick<ConnectorPreset, 'auth' | 'builtinClient'>): boolean {
  return (p.auth === 'oauth-static' || p.auth === 'google') && !p.builtinClient
}

/** Connects with the user's own API key, pasted once (kept in the Keychain). */
export function needsKey(p: Pick<ConnectorPreset, 'auth'>): boolean {
  return p.auth === 'apikey'
}

/** Web automation: the user signs in inside SahilBot's own browser (no connector). */
export function isBrowserSignIn(p: Pick<ConnectorPreset, 'auth'>): boolean {
  return p.auth === 'browser'
}

export type Badge = 'One click' | 'API key' | 'Needs setup' | 'SahilBot\'s browser'

/** The badge on a catalog row: "One click", "API key", "Needs setup", "SahilBot's browser", or none (built in, custom). */
export function connectBadge(p: Pick<ConnectorPreset, 'id' | 'auth' | 'builtinClient'>): Badge | null {
  if (p.id === 'custom') return null
  return isOneClick(p) ? 'One click' : isBrowserSignIn(p) ? 'SahilBot\'s browser' : needsKey(p) ? 'API key' : needsSetup(p) ? 'Needs setup' : null
}

/**
 * How easy an app is to connect, for ordering inside a section: built in, one click, then a sign-in
 * inside SahilBot's browser (below the app's real one-click connector), then a pasted key, then a setup.
 */
export function ease(p: Pick<ConnectorPreset, 'auth' | 'builtinClient'>): number {
  return p.auth === 'app' ? 0 : isOneClick(p) ? 1 : isBrowserSignIn(p) ? 2 : needsKey(p) ? 3 : 4
}

/** A section's apps with the easiest to connect first (stable: catalog order within each kind). */
export function easiestFirst<T extends Pick<ConnectorPreset, 'auth' | 'builtinClient'>>(ps: T[]): T[] {
  return ps.map((p, i) => [p, i] as const).sort((a, b) => ease(a[0]) - ease(b[0]) || a[1] - b[1]).map(([p]) => p)
}

/**
 * Not ready in one click: a one-time setup (an OAuth app of your own, Google setup) or your API key.
 * These go in each section's "Needs a one-time setup" group, after everything that connects at once.
 */
export function needsOneTimeSetup(p: Pick<ConnectorPreset, 'id' | 'auth' | 'builtinClient'>): boolean {
  return p.id !== 'custom' && (needsSetup(p) || needsKey(p))
}

/** A section split in two: what connects right away (easiest first), then the "Needs a one-time setup" group. */
export function splitSection<T extends Pick<ConnectorPreset, 'id' | 'auth' | 'builtinClient'>>(ps: T[]): { ready: T[]; setup: T[] } {
  const sorted = easiestFirst(ps)
  return { ready: sorted.filter((p) => !needsOneTimeSetup(p)), setup: sorted.filter(needsOneTimeSetup) }
}

/** The group heading for apps that need their one-time setup first. */
export const SETUP_GROUP = 'Needs a one-time setup'

/** Six suggestions, skipping what's already connected: only apps that truly connect in one click. */
export function recommended(presets: ConnectorPreset[], connectedPresetIds: Set<string>, n = 6): ConnectorPreset[] {
  const open = RECOMMENDED.map((id) => presets.find((p) => p.id === id)).filter((p): p is ConnectorPreset => !!p && !connectedPresetIds.has(p.id) && isOneClick(p))
  return open.slice(0, n)
}

/** Redirect URL for a custom server's own OAuth client (main: connectors.setupRedirect(); a unit test keeps them equal). */
export const CUSTOM_REDIRECT = 'http://127.0.0.1:47613/callback'

/** Case-insensitive match of every word in the query against the text. */
export function matches(q: string, ...text: Array<string | undefined>): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = text.filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** Extra words people search for that a category's name doesn't say ("crm" finds Sales, "tickets" finds Support). */
const CATEGORY_WORDS: Record<string, string> = {
  'Support': 'help desk helpdesk tickets customer service inbox chat',
  'Media & AI': 'video audio voice image generate ai music podcast',
  'Social': 'social media posts schedule twitter x linkedin instagram tiktok',
  'Sales & marketing': 'crm leads seo ads email marketing campaigns',
  'Finance & commerce': 'money payments invoices accounting bank expenses store shop ecommerce',
  'Data & analytics': 'analytics metrics dashboards sql warehouse reports',
  'Code': 'developer dev deploy hosting database ci devops monitoring logs incidents',
  'Productivity': 'tasks notes docs files projects',
  'Research': 'web search scrape crawl news',
  'Communication': 'chat messages meetings email calls',
  'On this Mac': 'local desktop mac app xcode ios swift figma offline',
  'HR & recruiting': 'hr hiring recruiting jobs candidates ats payroll employees people',
  'Legal': 'law legal contracts signature esign e-sign cases court documents',
  'Travel & real estate': 'travel flights hotels trips homes houses rentals real estate property mortgage',
  'Education & science': 'learning courses education school study science papers research math',
  'Health & fitness': 'health fitness running workouts training medical clinical biomedical'
}

/**
 * Search score for one app (0 = no match): every query word must appear in its name, description,
 * category or the category's extra words; matches in the name rank above the rest.
 */
export function searchScore(q: string, p: Pick<ConnectorPreset, 'name' | 'description' | 'category'> & { id?: string }): number {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  const name = `${p.name} ${p.id ?? ''}`.toLowerCase()
  const rest = `${p.description} ${p.category} ${CATEGORY_WORDS[p.category] ?? ''}`.toLowerCase()
  let score = 0
  for (const w of words) {
    if (name.startsWith(w)) score += 4
    else if (name.includes(w)) score += 3
    else if (rest.includes(w)) score += 1
    else return 0
  }
  return score
}

/** Catalog apps matching a search, best first (name hits, then easiest to connect). */
export function searchApps<T extends Pick<ConnectorPreset, 'name' | 'description' | 'category' | 'auth' | 'builtinClient'> & { id?: string }>(q: string, ps: T[]): T[] {
  return ps.map((p, i) => ({ p, i, s: searchScore(q, p) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || ease(a.p) - ease(b.p) || a.i - b.i).map((x) => x.p)
}

/** Dark or light letter on an app's brand color. */
export function letterColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#fff'
  const n = parseInt(m[1], 16)
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.68 ? '#111' : '#fff'
}

/** "Gmail (in SahilBot's browser)" → "Gmail" for compact rows. */
export function shortName(name: string): string {
  return name.replace(/\s*\((no setup|in SahilBot's browser)\)$/i, '')
}

/** Light checks on a pasted API key, for feedback while typing (main checks again and has the final say). */
export function keyProblem(key: string, p: Pick<ConnectorPreset, 'name'>): string | null {
  const k = key.trim()
  if (!k) return `Paste your ${p.name} API key.`
  if (/\s/.test(k)) return 'The key has spaces or line breaks in it; copy it again.'
  if (k.length < 8 || k.length > 512) return `That doesn't look like a ${p.name} API key; copy it again.`
  return null
}

/**
 * One clear state per app in Connect apps: connected; needs sign-in again (a sign-in that worked
 * before was refused or revoked, one click on Reconnect); unavailable right now (the server isn't
 * answering, or the catalog marks it unavailable); needs setup (a one-time OAuth app, Google setup or
 * API key is missing); plus the in-between states.
 */
export type AppState = 'connected' | 'busy' | 'reauth' | 'signin' | 'unavailable' | 'setup' | 'error' | 'idle'

export const APP_STATE_TEXT: Record<AppState, string> = {
  connected: 'Connected', busy: 'Connecting…', reauth: 'Needs sign-in again', signin: 'Needs sign-in',
  unavailable: 'Unavailable right now', setup: 'Needs setup', error: 'Error', idle: 'Not connected'
}

export function appState(
  p: Pick<ConnectorPreset, 'auth' | 'unavailable' | 'builtinClient'> | undefined,
  st: Pick<ConnectorStatus, 'state' | 'reason'> | undefined,
  o: { setupMissing?: boolean } = {}
): AppState {
  if (p?.unavailable && st?.state !== 'connected') return 'unavailable'
  switch (st?.state) {
    case 'connected': return 'connected'
    case 'connecting': case 'signing_in': return 'busy'
    case 'needs_auth': return st.reason === 'expired' ? 'reauth' : 'signin'
    case 'reconnecting': return 'unavailable'
    case 'error': return st.reason === 'unavailable' ? 'unavailable' : st.reason === 'expired' ? 'reauth' : st.reason === 'setup' || o.setupMissing ? 'setup' : 'error'
    default: return o.setupMissing ? 'setup' : 'idle'
  }
}

/** Short summary of a "Check all" run: "3 working · 1 needs sign-in again · 1 unavailable right now". */
export function checkSummary(states: AppState[]): string {
  if (!states.length) return 'No apps to check.'
  const n = (s: AppState): number => states.filter((x) => x === s).length
  const parts = [
    n('connected') && `${n('connected')} working`,
    n('reauth') + n('signin') && `${n('reauth') + n('signin')} need${n('reauth') + n('signin') === 1 ? 's' : ''} sign-in again`,
    n('unavailable') && `${n('unavailable')} unavailable right now`,
    n('setup') && `${n('setup')} need${n('setup') === 1 ? 's' : ''} setup`,
    n('error') && `${n('error')} with errors`,
    n('busy') && `${n('busy')} still connecting`,
    n('idle') && `${n('idle')} not connected`
  ].filter(Boolean)
  return parts.join(' · ')
}
