import type { ConnectorPreset } from '@shared/types'

// Connect Apps catalog: how presets group into chips and sections (pure; shared with unit tests).

/** Chips shown in the row; everything else lives under "More". */
export const MAIN_CHIPS = ['Password Managers', 'Productivity', 'Communication', 'Design', 'Code'] as const

/** Section order in the All view (after "Recommended for you"). */
export const SECTION_ORDER = ['Built in', 'Password Managers', 'Productivity', 'Communication', 'Support', 'Design', 'Media & AI', 'Code', 'Data & analytics', 'Sales & marketing', 'Social', 'Finance & commerce', 'Research', 'Other'] as const

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
const RECOMMENDED = ['notion', 'gmail', 'gcal', 'figma', 'linear', 'canva', 'dropbox', 'exa', 'granola', 'trello', 'gitlab', 'stripe', 'tavily', 'heygen', 'vercel', 'cloudflare', 'slack', 'github', 'gdrive', 'asana']

/** Signs in with one click: the app registers SahilBot itself, or needs no sign-in. */
export function isOneClick(p: Pick<ConnectorPreset, 'auth'>): boolean {
  return p.auth === 'oauth' || p.auth === 'none'
}

/** Needs a one-time setup before the first sign-in (an OAuth app at the provider, or "Set up Google once"). */
export function needsSetup(p: Pick<ConnectorPreset, 'auth'>): boolean {
  return p.auth === 'oauth-static' || p.auth === 'google'
}

/** Connects with the user's own API key, pasted once (kept in the Keychain). */
export function needsKey(p: Pick<ConnectorPreset, 'auth'>): boolean {
  return p.auth === 'apikey'
}

export type Badge = 'One click' | 'API key' | 'Needs setup'

/** The badge on a catalog row: "One click", "API key", "Needs setup", or none (built in, browser, custom). */
export function connectBadge(p: Pick<ConnectorPreset, 'id' | 'auth'>): Badge | null {
  if (p.id === 'custom') return null
  return isOneClick(p) ? 'One click' : needsKey(p) ? 'API key' : needsSetup(p) ? 'Needs setup' : null
}

/** How easy an app is to connect, for ordering inside a section: one click, then a pasted key, then a setup. */
export function ease(p: Pick<ConnectorPreset, 'auth'>): number {
  return p.auth === 'app' || p.auth === 'browser' ? 0 : isOneClick(p) ? 1 : needsKey(p) ? 2 : 3
}

/** A section's apps with the easiest to connect first (stable: catalog order within each kind). */
export function easiestFirst<T extends Pick<ConnectorPreset, 'auth'>>(ps: T[]): T[] {
  return ps.map((p, i) => [p, i] as const).sort((a, b) => ease(a[0]) - ease(b[0]) || a[1] - b[1]).map(([p]) => p)
}

/** Six suggestions, skipping what's already connected; one-click apps come first. */
export function recommended(presets: ConnectorPreset[], connectedPresetIds: Set<string>, n = 6): ConnectorPreset[] {
  const open = RECOMMENDED.map((id) => presets.find((p) => p.id === id)).filter((p): p is ConnectorPreset => !!p && !connectedPresetIds.has(p.id))
  return easiestFirst(open).slice(0, n)
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
  'Communication': 'chat messages meetings email calls'
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
export function searchApps<T extends Pick<ConnectorPreset, 'name' | 'description' | 'category' | 'auth'> & { id?: string }>(q: string, ps: T[]): T[] {
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

/** "Gmail (no setup)" → "Gmail" for compact rows. */
export function shortName(name: string): string {
  return name.replace(/\s*\(no setup\)$/i, '')
}

/** Light checks on a pasted API key, for feedback while typing (main checks again and has the final say). */
export function keyProblem(key: string, p: Pick<ConnectorPreset, 'name'>): string | null {
  const k = key.trim()
  if (!k) return `Paste your ${p.name} API key.`
  if (/\s/.test(k)) return 'The key has spaces or line breaks in it; copy it again.'
  if (k.length < 8 || k.length > 512) return `That doesn't look like a ${p.name} API key; copy it again.`
  return null
}
