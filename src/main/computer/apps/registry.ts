import type { ToolEffect } from '@shared/types'
import { brave, chrome, edge, safari } from './browsers'
import { cursorEditor, vscode, xcode } from './devtools'
import { finder } from './finder'
import { keynote, numbers, pages } from './iwork'
import { music, spotify } from './media'
import { messages } from './messages'
import { excel, powerpoint, word } from './office'
import { calendar, notes, reminders } from './pim'
import { preview } from './preview'
import { systemSettings } from './settings'
import { slack } from './slack'
import { formatAction, type ActionScope, type AppAction, type AppAdapter, type Args } from './types'

// Every app adapter, and the routing the app tool uses: an app by name or alias, an action by id, and
// what a call can do (effect, whether it always asks) before it runs.

export const ADAPTERS: AppAdapter[] = [
  finder, safari, chrome, brave, edge,
  numbers, pages, keynote, excel, word, powerpoint, preview,
  messages, slack, music, spotify,
  vscode, cursorEditor, xcode,
  systemSettings, notes, reminders, calendar
]

const norm = (s: string): string => String(s ?? '').trim().toLowerCase().replace(/\.app$/, '').replace(/[\s_-]+/g, ' ')

/** An adapter by id, app name or alias ("chrome", "Google Chrome", "excel", "vs code", "system preferences"). */
export function findAdapter(app: string): AppAdapter | undefined {
  const k = norm(app)
  if (!k) return undefined
  return ADAPTERS.find((x) => norm(x.id) === k || norm(x.name) === k || x.aliases.some((al) => norm(al) === k) || x.bundleIds.some((b) => b.toLowerCase() === k))
}

/** Actions every app has (answered by the app tool itself). */
export const GENERIC = ['help', 'status'] as const

export type Route = { adapter: AppAdapter; id: string; action: AppAction }

/** The adapter and action for a call, or an error message that tells the model what exists. */
export function route(app: string, action: string): Route | { error: string } {
  const adapter = findAdapter(app)
  if (!adapter) return { error: `SahilBot has no adapter for "${app}". Apps: ${ADAPTERS.map((x) => x.name).join(', ')}. For any other app use computer use (computer ui {app:"${app}"}).` }
  const id = String(action ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const hit = adapter.actions[id]
  if (!hit) return { error: `${adapter.name} has no action "${action}". Its actions: ${[...Object.keys(adapter.actions), ...GENERIC].join(', ')}. Anything else: computer use.` }
  return { adapter, id, action: hit }
}

export const isRoute = (r: Route | { error: string }): r is Route => 'adapter' in r

/** What a call can do to the world. Unknown apps or actions only produce an error, so they read. */
export function effectOf(app: string, action: string, args: Args, scope: ActionScope): ToolEffect {
  if ((GENERIC as readonly string[]).includes(String(action))) return 'read'
  const r = route(app, action)
  if (!isRoute(r)) return 'read'
  if (r.action.drives) return 'write_external'
  try {
    return typeof r.action.effect === 'function' ? r.action.effect(args, scope) : r.action.effect
  } catch {
    return 'destructive'
  }
}

/**
 * Whether Auto mode asks before a write_external call. Mouse-and-keyboard actions follow computer use's
 * rule (one OK per task, always asked when nobody is watching); others ask unless marked routine.
 */
export function consequentialOf(app: string, action: string, args: Args, c: { granted: boolean; unattended?: boolean }): boolean {
  const r = route(app, action)
  if (!isRoute(r)) return false
  const own = typeof r.action.consequential === 'function' ? r.action.consequential(args) : r.action.consequential
  if (r.action.drives) return own === true || !!c.unattended || !c.granted
  return own ?? true
}

export function hardStopOf(app: string, action: string, args: Args): string | null {
  const r = route(app, action)
  return isRoute(r) ? r.action.hardStop?.(args) ?? null : null
}

export function describeCall(app: string, action: string, args: Args): string {
  if (String(action) === 'help') return `List what SahilBot can do in ${app}`
  if (String(action) === 'status') return `Check whether ${app} is installed and running`
  const r = route(app, action)
  return isRoute(r) ? `${r.adapter.name}: ${r.action.describe(args)}` : `${app} ${action}`
}

/** app_help for one app: what it is, how it's controlled, every action with its arguments and effect. */
export function helpText(a: AppAdapter, status?: string): string {
  return [
    `${a.name}${status ? ` (${status})` : ''}: ${a.blurb}.`,
    a.notes,
    'Actions (call app {app, action, args}; ? = optional):',
    ...Object.entries(a.actions).map(([id, x]) => formatAction(id, x)),
    '- status: installed / running',
    `Recipes: read the skill ${a.skill} (memory read_skill). Anything not listed: computer use (computer ui {app:"${a.name}"}), and verify each step.`
  ].join('\n')
}

/** app_help with no app: every adapter in one line each. */
export const catalog = (): string => `Apps with adapters (app_help {app} lists an app's actions):\n${ADAPTERS.map((a) => `- ${a.name}${a.aliases.length ? ` (${a.aliases.slice(0, 2).join(', ')})` : ''}: ${a.blurb}`).join('\n')}\nAny other app: computer use.`
