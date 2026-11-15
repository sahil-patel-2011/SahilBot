import type { BotSwarmSettings, CouncilSettings, Settings, Space } from '@shared/types'
import { helperCeiling } from '../run-scheduler'

// Settings → botSwarm[botId] and Settings → council are stored as the user set them; every reader goes
// through these, so a bad value can't widen a cap. (Re-exported by spaces.ts.)

export const BOT_SWARM_DEFAULTS: BotSwarmSettings = { mode: 'auto', maxHelpers: 20, routineUsd: 1 }
/** A bot swarm never has more helpers than this. */
export const BOT_SWARM_MAX = 50
export const COUNCIL_DEFAULTS: CouncilSettings = { members: 'auto', rounds: 2 }

const clampNum = (v: unknown, lo: number, hi: number, dflt: number, int = true): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt
  const c = Math.min(hi, Math.max(lo, n))
  return int ? Math.round(c) : c
}

/** A bot's swarm settings, cleaned (any bot id; missing = the defaults). */
export function botSwarmConfig(all: Settings['botSwarm'] | undefined, botId: string | null | undefined): BotSwarmSettings {
  const x = (botId && all && typeof all === 'object' ? all[botId] : undefined) ?? {}
  return {
    mode: x.mode === 'off' || x.mode === 'always' ? x.mode : 'auto',
    maxHelpers: Math.min(helperCeiling(), clampNum(x.maxHelpers, 1, BOT_SWARM_MAX, BOT_SWARM_DEFAULTS.maxHelpers)),
    routineUsd: clampNum(x.routineUsd, 0, 100, BOT_SWARM_DEFAULTS.routineUsd, false)
  }
}

/** Whether a space can swarm at all: bots (SahilBot itself included), not groups or projects. */
export const canSwarm = (space: Pick<Space, 'kind'> | null | undefined): boolean => space?.kind === 'bot'

export function councilConfig(v: unknown): CouncilSettings {
  const x = (v && typeof v === 'object' ? v : {}) as Partial<CouncilSettings>
  const ids = Array.isArray(x.members) ? [...new Set(x.members.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim().slice(0, 200)))].slice(0, 4) : []
  return { members: ids.length >= 2 ? ids : 'auto', rounds: clampNum(x.rounds, 1, 4, COUNCIL_DEFAULTS.rounds) }
}
