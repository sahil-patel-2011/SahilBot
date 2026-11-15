import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sub } from './paths'

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
export { BOT_SWARM_DEFAULTS, BOT_SWARM_MAX, COUNCIL_DEFAULTS, botSwarmConfig, canSwarm, councilConfig } from './agent/swarm/bot-config'

// ---------------------------------------------------------------- always-on bots: autonomy defaults
// A bot (not the main SahilBot chat, groups or projects) works at Autonomous until the user picks a level
// in Bot details; regular chats keep the app default. Policy and cleaners: agent/questions/policy.ts.
export { BOT_AUTONOMY_DEFAULTS, BOT_DEFAULT_LEVEL, botAutonomyConfig, botLevel, isAlwaysOnBot } from './agent/questions/policy'

/**
 * Once per database: bots' own conversations still at the old default (Auto) move to Autonomous, unless
 * the user picked a level for that bot. Ask-first chats stay as they are (that was a choice), and so do
 * the main chat, groups, projects and helper chats. Returns how many chats moved.
 */
export function migrateBotAutonomy(db: import('./db').Db, settings: Pick<import('@shared/types').Settings, 'botModes'>): number {
  const KEY = 'botAutonomyDefaultV1'
  if (db.getSetting<number>(KEY)) return 0
  let moved = 0
  for (const space of db.listSpaces()) {
    if (space.kind !== 'bot' || space.isMain || settings.botModes?.[space.id]) continue
    for (const t of db.listThreads(space.id)) {
      if (t.parentId || t.permissionMode !== 'auto') continue
      db.updateThread(t.id, { permissionMode: 'autonomous' })
      moved++
    }
  }
  db.setSetting(KEY, 1)
  return moved
}
