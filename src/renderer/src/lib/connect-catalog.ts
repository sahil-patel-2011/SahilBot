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

/** Popular apps people connect first, in order. */
const RECOMMENDED = ['gmail', 'gcal', 'notion', 'slack', 'github', 'gdrive', 'figma', 'linear', 'canva', 'stripe', 'exa', 'asana']

/** Six suggestions, skipping what's already connected. */
export function recommended(presets: ConnectorPreset[], connectedPresetIds: Set<string>, n = 6): ConnectorPreset[] {
  return RECOMMENDED.map((id) => presets.find((p) => p.id === id)).filter((p): p is ConnectorPreset => !!p && !connectedPresetIds.has(p.id)).slice(0, n)
}

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
