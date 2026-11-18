import type { ConnectorConfig, ConnectorPreset, ConnectorStatus } from '@shared/types'

// Function bots' suggested apps (BotTemplate.sources): names, colors and whether each is connected. Pure, for tests.

/** Apps a function bot can suggest that have no connector preset yet: shown by name, never connected. */
export const NO_PRESET: Record<string, { name: string; color: string }> = {
  quickbooks: { name: 'QuickBooks', color: '#2CA01C' }
}
/** Other presets that count as the same app (Gmail in SahilBot's browser is still Gmail). */
const SAME_APP: Record<string, string[]> = { gmail: ['gmail-web'], gdrive: ['gdrive-web'], gcal: ['gcal-web'] }

export interface SourceInfo { id: string; name: string; color?: string; connected: boolean; preset: boolean }

/** A template's suggested apps with their names and whether each is connected. */
export function sourceInfo(ids: string[], presets: Pick<ConnectorPreset, 'id' | 'name' | 'color'>[], configs: Pick<ConnectorConfig, 'id' | 'preset'>[], statuses: Pick<ConnectorStatus, 'id' | 'state'>[]): SourceInfo[] {
  const on = new Set(configs.filter((c) => statuses.find((s) => s.id === c.id)?.state === 'connected').map((c) => c.preset).filter(Boolean) as string[])
  return ids.map((id) => {
    const p = presets.find((x) => x.id === id)
    const fallback = NO_PRESET[id]
    const name = p ? p.name.replace(/\s*\(.*\)$/, '') : fallback?.name ?? id.charAt(0).toUpperCase() + id.slice(1)
    return { id, name, color: p?.color ?? fallback?.color, preset: !!p, connected: [id, ...(SAME_APP[id] ?? [])].some((x) => on.has(x)) }
  })
}
