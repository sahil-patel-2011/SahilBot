import type { Space } from '@shared/types'

/** Bots in the order the sidebar lists them (pinned first, SahilBot by default): ⌘1–9 open them. */
export function botOrder(spaces: Space[], pinned?: string[]): Space[] {
  const main = spaces.find((s) => s.isMain)
  const pins = (pinned ?? (main ? [main.id] : [])).map((id) => spaces.find((s) => s.id === id)).filter((s): s is Space => !!s && !s.hidden && s.kind !== 'project')
  const rest = spaces.filter((s) => !s.hidden && s.kind !== 'project' && !pins.includes(s))
  return [...pins, ...rest]
}
