import type { ConnectorPreset } from '@shared/types'

// Connect Apps catalog: how presets group into chips and sections (pure; shared with unit tests).

/** Chips shown in the row; everything else lives under "More". */
export const MAIN_CHIPS = ['Password Managers', 'Productivity', 'Communication', 'Design', 'Code'] as const

/** Section order in the All view (after "Recommended for you"). */
export const SECTION_ORDER = ['Built in', 'Password Managers', 'Productivity', 'Communication', 'Design', 'Code', 'Sales & marketing', 'Finance & commerce', 'Data & analytics', 'Research', 'Other'] as const

/** Categories under the More ▾ chip. */
export const MORE_CATEGORIES: string[] = SECTION_ORDER.filter((c) => !(MAIN_CHIPS as readonly string[]).includes(c))

/** The chip a category is reached from: itself for a main chip, else "More". */
export function chipOf(category: string): string {
  return (MAIN_CHIPS as readonly string[]).includes(category) ? category : 'More'
}

/** Popular apps people connect first, in order (one-click apps are shown before ones that need setup). */
const RECOMMENDED = ['notion', 'gmail', 'gcal', 'figma', 'linear', 'canva', 'stripe', 'dropbox', 'exa', 'granola', 'heygen', 'vercel', 'cloudflare', 'slack', 'github', 'gdrive', 'asana']

/** Signs in with one click: the app registers SahilBot itself, or needs no sign-in. */
export function isOneClick(p: Pick<ConnectorPreset, 'auth'>): boolean {
  return p.auth === 'oauth' || p.auth === 'none'
}

/** Needs a one-time setup before the first sign-in (an OAuth app at the provider, or "Set up Google once"). */
export function needsSetup(p: Pick<ConnectorPreset, 'auth'>): boolean {
  return p.auth === 'oauth-static' || p.auth === 'google'
}

/** The badge on a catalog row: "One click", "Needs setup", or none (built in, browser, custom). */
export function connectBadge(p: Pick<ConnectorPreset, 'id' | 'auth'>): 'One click' | 'Needs setup' | null {
  if (p.id === 'custom') return null
  return isOneClick(p) ? 'One click' : needsSetup(p) ? 'Needs setup' : null
}

/** Six suggestions, skipping what's already connected; one-click apps come first. */
export function recommended(presets: ConnectorPreset[], connectedPresetIds: Set<string>, n = 6): ConnectorPreset[] {
  const open = RECOMMENDED.map((id) => presets.find((p) => p.id === id)).filter((p): p is ConnectorPreset => !!p && !connectedPresetIds.has(p.id))
  return [...open.filter(isOneClick), ...open.filter((p) => !isOneClick(p))].slice(0, n)
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
