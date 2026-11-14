import type { HeavySettings, SwarmSettings } from '@shared/types'

// Swarm and Heavy settings, cleaned with defaults and limits. Settings → swarm / heavy are stored as the
// user (or a test) set them; every reader goes through these so a bad value can't widen a cap.

export const SWARM_DEFAULTS: SwarmSettings = { maxAgents: 30, maxParallel: 8, askAboveUsd: 1, maxUsd: 5, helperModel: 'auto' }
export const HEAVY_DEFAULTS: HeavySettings = { attempts: 4, mix: 'auto' }

const num = (v: unknown, lo: number, hi: number, dflt: number, int = true): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt
  const c = Math.min(hi, Math.max(lo, n))
  return int ? Math.round(c) : c
}

export function swarmConfig(v: unknown): SwarmSettings {
  const x = (v && typeof v === 'object' ? v : {}) as Partial<SwarmSettings>
  return {
    maxAgents: num(x.maxAgents, 1, 100, SWARM_DEFAULTS.maxAgents),
    maxParallel: num(x.maxParallel, 1, 32, SWARM_DEFAULTS.maxParallel),
    askAboveUsd: num(x.askAboveUsd, 0, 1000, SWARM_DEFAULTS.askAboveUsd, false),
    maxUsd: num(x.maxUsd, 0.01, 1000, SWARM_DEFAULTS.maxUsd, false),
    helperModel: typeof x.helperModel === 'string' && x.helperModel.trim() ? x.helperModel.trim().slice(0, 200) : SWARM_DEFAULTS.helperModel
  }
}

export function heavyConfig(v: unknown): HeavySettings {
  const x = (v && typeof v === 'object' ? v : {}) as Partial<HeavySettings>
  const mix = Array.isArray(x.mix)
    ? x.mix.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim().slice(0, 200)).slice(0, 8)
    : x.mix === 'same' ? 'same' : 'auto'
  return { attempts: num(x.attempts, 2, 8, HEAVY_DEFAULTS.attempts), mix: Array.isArray(mix) && !mix.length ? 'auto' : mix }
}

/** "$2.40", "$0.06", "$0.004". */
export const usd = (n: number): string => `$${n >= 0.1 || n === 0 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(2) : n.toFixed(3)}`
