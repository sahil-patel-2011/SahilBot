import type { BotAutonomySettings, PermissionMode, QueueQuestion, Settings, Space } from '@shared/types'
import { hardStopText } from '../permissions'

// Always-on bots: their autonomy level, "Always ask for…" exceptions, question deadline and daily digest.
// No Electron imports: the agent loop, main and tests all use these.

export const BOT_AUTONOMY_DEFAULTS: BotAutonomySettings = { alwaysAsk: [], deadlineHours: 4, digest: { enabled: true, time: '18:00' } }
/** The level a bot works at until the user picks one. Regular chats keep the app's default (Settings → defaultMode). */
export const BOT_DEFAULT_LEVEL: PermissionMode = 'auto'
export const ALWAYS_ASK_LIMIT = 20
/** Attended bot runs show the question card this long before it moves to the Needs-you queue and the bot carries on. */
export const ATTENDED_GRACE_MS = 2 * 60_000

/** A bot with its own job (not the main SahilBot chat, a group or a project): it can work on its own. */
export const isAlwaysOnBot = (s: Pick<Space, 'kind' | 'isMain'> | null | undefined): boolean => !!s && s.kind === 'bot' && !s.isMain

const clock = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null
}

/** One bot's always-on settings as saved: trimmed "always ask" phrases, a deadline of 15 minutes to a week, a HH:MM digest time. */
export function cleanBotAutonomy(v: unknown): BotAutonomySettings {
  const x = (v ?? {}) as Partial<BotAutonomySettings>
  const seen = new Set<string>()
  const alwaysAsk: string[] = []
  for (const w of Array.isArray(x.alwaysAsk) ? x.alwaysAsk : []) {
    if (typeof w !== 'string') continue
    const t = w.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!t || seen.has(t.toLowerCase()) || alwaysAsk.length >= ALWAYS_ASK_LIMIT) continue
    seen.add(t.toLowerCase())
    alwaysAsk.push(t)
  }
  const n = typeof x.deadlineHours === 'number' ? x.deadlineHours : typeof x.deadlineHours === 'string' ? Number(x.deadlineHours) : NaN
  const deadlineHours = Number.isFinite(n) ? Math.min(168, Math.max(0.25, Math.round(n * 4) / 4)) : BOT_AUTONOMY_DEFAULTS.deadlineHours
  const d = (x.digest ?? {}) as Partial<BotAutonomySettings['digest']>
  return { alwaysAsk, deadlineHours, digest: { enabled: typeof d.enabled === 'boolean' ? d.enabled : BOT_AUTONOMY_DEFAULTS.digest.enabled, time: clock(d.time) ?? BOT_AUTONOMY_DEFAULTS.digest.time } }
}

/** The saved map, cleaned (at most 500 bots). */
export function cleanBotAutonomyMap(v: unknown): Record<string, BotAutonomySettings> {
  const out: Record<string, BotAutonomySettings> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 500)) if (k.length <= 64) out[k] = cleanBotAutonomy(x)
  return out
}

export function botAutonomyConfig(s: Pick<Settings, 'botAutonomy'> | null | undefined, botId: string): BotAutonomySettings {
  return cleanBotAutonomy(s?.botAutonomy?.[botId])
}

/**
 * The permission level a chat of this space starts in: the bot's own pick, else Auto for an always-on bot,
 * else the app default (Auto). Never Bypass; 'autonomous' (older settings) reads as Auto.
 */
export function botLevel(s: Pick<Settings, 'botModes' | 'defaultMode'> | null | undefined, space: Pick<Space, 'id' | 'kind' | 'isMain'> | null | undefined): PermissionMode {
  const mine = space ? s?.botModes?.[space.id] : undefined
  const m = mine ?? (isAlwaysOnBot(space) ? BOT_DEFAULT_LEVEL : s?.defaultMode ?? 'auto')
  return m === 'ask' ? 'ask' : 'auto'
}

/** The recommended default for a question: its explicit default, an option marked "(recommended)", else the first option. */
export function recommendedDefault(q: QueueQuestion): string | undefined {
  const d = typeof q.default === 'string' ? q.default.trim() : ''
  if (d) return d
  const opts = (q.options ?? []).filter((o) => typeof o === 'string' && o.trim())
  return opts.find((o) => /\(recommended\)|\brecommended\b/i.test(o)) ?? opts[0]
}

/** An option label without its "(recommended)" tag, for reports and memories. */
export const plainOption = (o: string): string => o.replace(/\s*\((recommended|default|suggested)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim()

/**
 * Whether a deadline may answer this question with its default: there is one, the bot didn't say going
 * ahead is unsafe, and neither the question nor the default touches a hard stop (money, credentials,
 * deleting, mass sends, public posts).
 */
export function safeToDefault(q: QueueQuestion, o: { declaredUnsafe?: boolean } = {}): { ok: true; answer: string } | { ok: false; why: string } {
  const answer = recommendedDefault(q)
  if (!answer) return { ok: false, why: 'there is no recommended default' }
  if (o.declaredUnsafe) return { ok: false, why: 'the bot said going ahead without you is not safe' }
  const stop = hardStopText(q.question, answer)
  if (stop) return { ok: false, why: stop }
  return { ok: true, answer: plainOption(answer) }
}
