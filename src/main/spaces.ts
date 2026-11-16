import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sub } from './paths'
import { isAutoModel } from '@shared/model-picker'

export const DEFAULT_PROMPT = `Help the user with whatever they bring you, and get it done end to end.
Be direct and concise. Prefer doing the work over describing it.
When you are unsure of a fact, say so instead of guessing.
`

/** Each Space's system prompt is a plain Markdown file the user can edit in any editor. */
export class SpaceFiles {
  path(spaceId: string): string {
    return join(sub('spaces', spaceId), 'system.md')
  }

  getPrompt(spaceId: string): string {
    const p = this.path(spaceId)
    if (!existsSync(p)) writeFileSync(p, DEFAULT_PROMPT)
    return readFileSync(p, 'utf8')
  }

  setPrompt(spaceId: string, text: string): void {
    writeFileSync(this.path(spaceId), text)
  }
}

// ---------------------------------------------------------------- swarm and council settings
// Per-bot Swarm (Off / Auto / Always, Max helpers, routine budget) and Council settings live in Settings;
// their cleaners are in agent/swarm/bot-config.ts (no Electron imports, so the agent and tests can use them).
export { BOT_SWARM_DEFAULTS, BOT_SWARM_MAX, COUNCIL_DEFAULTS, botMaxConfig, botSwarmConfig, canSwarm, councilConfig, migrateBotMax } from './agent/swarm/bot-config'

// ---------------------------------------------------------------- always-on bots: autonomy defaults
// A bot (not the main SahilBot chat, groups or projects) works at Auto until the user picks a level in
// Bot details; regular chats keep the app default. Policy and cleaners: agent/questions/policy.ts.
export { BOT_AUTONOMY_DEFAULTS, BOT_DEFAULT_LEVEL, botAutonomyConfig, botLevel, isAlwaysOnBot } from './agent/questions/policy'

/**
 * Once per database (older installs): bots' chats used to move from Auto to Autonomous here. Auto now does
 * what Autonomous did (agent/permissions.ts), so nothing moves any more; the marker is still set so the
 * step stays done. Returns how many chats moved (always 0).
 */
export function migrateBotAutonomy(db: import('./db').Db, _settings: Pick<import('@shared/types').Settings, 'botModes'>): number {
  const KEY = 'botAutonomyDefaultV1'
  if (!db.getSetting<number>(KEY)) db.setSetting(KEY, 1)
  return 0
}

/**
 * Once per database: bots choose their model and thinking by themselves (Auto for each request), so the
 * per-bot model and thinking overrides the bot editor used to set are cleared (the columns stay; null = Auto).
 * Every bot's own chats lose a model or thinking picked in them too (bot chats show "Auto (bot)"); helper
 * threads keep the model their orchestrator assigned. SahilBot's own chats, projects and groups' chats keep
 * what the user picked in the composer ("what you pick is what happens"). Returns how many rows changed.
 */
export function migrateBotModelEffort(db: import('./db').Db): number {
  const KEY = 'botAutoModelEffortV1'
  if (db.getSetting<number>(KEY)) return 0
  let changed = 0
  for (const space of db.listSpaces()) {
    if (space.model || space.effort) { db.updateSpace(space.id, { model: null, effort: null }); changed++ }
    if (space.kind !== 'bot' || space.isMain) continue
    for (const t of db.listThreads(space.id)) {
      if (t.parentId || (!t.model && !t.effort) || (t.model === 'auto' && (!t.effort || t.effort === 'auto'))) continue
      db.updateThread(t.id, { model: null, effort: null })
      changed++
    }
  }
  db.setSetting(KEY, 1)
  return changed
}

/**
 * Once per database, for the three permission levels (Ask / Auto / Bypass) and "Auto means automatic":
 * - chats, the app default and bots' levels saved as 'autonomous' become 'auto' (Auto now does what
 *   Autonomous did; agent/permissions.ts);
 * - a thinking level stored on a chat whose model is Auto (its own pick, or the app default when it has none)
 *   is cleared: Auto picks the model and the thinking together. The app's own "thinking for new chats"
 *   goes back to Auto when the default model is Auto.
 * Returns how many rows changed.
 */
export function migratePermissionLevels(db: import('./db').Db, s: Pick<import('@shared/types').Settings, 'defaultModel' | 'defaultMode' | 'botModes' | 'thinking'>, save: (patch: Partial<import('@shared/types').Settings>) => void): number {
  const KEY = 'permissionLevelsV3'
  if (db.getSetting<number>(KEY)) return 0
  let changed = Number(db.sql.prepare(`UPDATE threads SET permission_mode = 'auto' WHERE permission_mode = 'autonomous'`).run().changes ?? 0)
  const rows = db.sql.prepare(`SELECT id, model FROM threads WHERE effort IS NOT NULL AND parent_id IS NULL`).all() as Array<{ id: string; model: string | null }>
  for (const r of rows) {
    if (!isAutoModel(r.model || s.defaultModel)) continue
    db.sql.prepare('UPDATE threads SET effort = NULL WHERE id = ?').run(r.id)
    changed++
  }
  const patch: Partial<import('@shared/types').Settings> = {}
  if ((s.defaultMode as string) === 'autonomous') patch.defaultMode = 'auto'
  const bots = Object.entries(s.botModes ?? {})
  if (bots.some(([, m]) => (m as string) === 'autonomous')) patch.botModes = Object.fromEntries(bots.map(([k, m]) => [k, (m as string) === 'autonomous' ? 'auto' : m]))
  if (isAutoModel(s.defaultModel) && s.thinking && s.thinking !== 'auto') patch.thinking = 'auto'
  if (Object.keys(patch).length) { save(patch); changed++ }
  db.setSetting(KEY, 1)
  return changed
}
