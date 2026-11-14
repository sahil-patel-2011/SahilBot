import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ToolEffect } from '@shared/types'
import type { ToolOutput } from '../../agent/types'

// App adapters: each app SahilBot knows well gets one file with its actions. An action uses the app's own
// scripting (AppleScript / JXA dictionary) or a command-line tool when there is one, because that is
// exact and doesn't depend on what is on screen; actions that need the keyboard (Slack, an editor's
// command palette) go through computer use, with its guards and the visible cursor. Every action says
// what it can do to the world (effect), whether it always asks, and how to describe it on the approval
// card. User data only ever reaches a script as JSON or argv, never spliced into its source.

export interface ArgSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  required?: boolean
  description: string
  enum?: string[]
}

/** What an action needs from the app tool to run. */
export interface AppEnv {
  /** A JXA function `(a) => result` with JSON input (wrapped like computer use's scripts). */
  jxa<T = unknown>(fn: string, input: unknown, timeoutMs?: number): Promise<T>
  /** AppleScript source with `on run argv`; args arrive as argv (never spliced into the source). */
  applescript(src: string, args: string[], timeoutMs?: number): Promise<string>
  sh(cmd: string, args: string[], timeoutMs?: number): Promise<string>
  /** Computer use: guards, the visible cursor and verification, e.g. { action: 'key', keys: 'cmd+k' }. */
  computer(args: Record<string, unknown>): Promise<ToolOutput>
  /** The mac_apps tool (Notes, Reminders, Calendar). */
  macApps(args: Record<string, unknown>): Promise<ToolOutput>
  workspace: string
  roots: string[]
  signal: AbortSignal
}

export interface AppResult { text: string; display?: string; path?: string }

/** Where an action runs: the chat's attached folders and workspace (paths inside them are routine). */
export interface ActionScope { roots: string[]; workspace: string }

export type Args = Record<string, any>

export interface AppAction {
  summary: string
  args?: Record<string, ArgSpec>
  effect: ToolEffect | ((a: Args, s: ActionScope) => ToolEffect)
  /** Drives the mouse and keyboard through computer use (one OK per task, like computer use itself). */
  drives?: boolean
  /** For write_external: false when routine. Omitted = consequential (asks in Auto). */
  consequential?: boolean | ((a: Args) => boolean)
  /** Always asks, whatever the mode (sending a message, the Trash). */
  hardStop?: (a: Args) => string | null
  describe(a: Args): string
  /** Reads an open app: refuse instead of launching it. */
  needsRunning?: boolean
  run(a: Args, env: AppEnv): Promise<AppResult>
}

export interface AppAdapter {
  id: string
  /** The app's name as macOS shows it (and as computer use's app argument takes it). */
  name: string
  aliases: string[]
  bundleIds: string[]
  /** Where it is usually installed. */
  paths: string[]
  /** What it is for, in a few words. */
  blurb: string
  /** The skill with recipes for it. */
  skill: string
  /** How its control works, and what to fall back to. */
  notes: string
  actions: Record<string, AppAction>
}

/** Checks an action's arguments; returns a message for the model, or null. */
export function checkArgs(action: AppAction, args: Args, name: string): string | null {
  const spec = action.args ?? {}
  const problems: string[] = []
  for (const [k, s] of Object.entries(spec)) {
    const v = args[k]
    if (v === undefined || v === null || v === '') { if (s.required) problems.push(`${k} is required (${s.description})`); continue }
    const t = Array.isArray(v) ? 'array' : typeof v
    const ok = s.type === t || (s.type === 'number' && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))
    if (!ok) problems.push(`${k} should be a ${s.type}`)
    else if (s.enum && !s.enum.includes(String(v))) problems.push(`${k} is one of ${s.enum.join(', ')}`)
  }
  const unknown = Object.keys(args).filter((k) => !(k in spec))
  if (unknown.length) problems.push(`unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}${Object.keys(spec).length ? ` (takes ${Object.keys(spec).join(', ')})` : ' (takes none)'}`)
  return problems.length ? `${name}: ${problems.join('; ')}.` : null
}

/** One line per action for app_help. */
export function formatAction(id: string, a: AppAction, scope?: ActionScope): string {
  const args = Object.entries(a.args ?? {}).map(([k, s]) => `${k}${s.required ? '' : '?'}${s.enum ? `: ${s.enum.join('|')}` : ''}`).join(', ')
  const eff = typeof a.effect === 'string' ? a.effect : scope ? a.effect({}, scope) : 'depends'
  const tags = [a.drives ? 'uses mouse/keyboard' : '', a.hardStop?.({}) ? 'always asks' : ''].filter(Boolean).join(', ')
  return `- ${id}${args ? ` {${args}}` : ''}: ${a.summary} [${eff}${tags ? `; ${tags}` : ''}]`
}

// ------------------------------------------------------------------------------------------ paths

/** "~/x" → home; relative → the workspace. */
export function expandPath(p: string, workspace: string): string {
  const s = String(p).trim()
  if (s === '~') return homedir()
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return isAbsolute(s) ? resolve(s) : resolve(workspace, s)
}

const real = (p: string): string => { try { return realpathSync(p) } catch { return p } }
const within = (root: string, p: string): boolean => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r) && !r.startsWith(`..${sep}`)) }

/** Inside the workspace or a folder attached to the chat (real paths compared; the tail may not exist yet). */
export function insideRoots(p: string, scope: ActionScope): boolean {
  if (!p) return false
  const full = expandPath(p, scope.workspace)
  let probe = full
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  const fullReal = join(real(probe), relative(probe, full))
  return [scope.workspace, ...scope.roots].filter(Boolean).map(real).some((r) => within(r, fullReal))
}

/** A list argument that may come as one string. */
export const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)])

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s)

/** Accepts "https://x.com", "x.com/path"; refuses javascript:, data:, file: and other schemes. */
export function webUrl(raw: string): string {
  const s = String(raw).trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) throw new Error(`Only web addresses (http or https) open this way, not "${s.split(':')[0]}:" links.`)
  const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`)
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error(`"${s}" isn't a web address.`)
  return u.toString()
}

/** Helpers every JXA adapter script gets. */
export const JXA_GET = `const get = (f, d) => { try { const v = f(); return v === undefined ? d : v } catch (e) { return d } }`
/** Open documents by name (exact, then contains) or 1-based number; the front one by default. */
export const JXA_PICK_DOC = `const pickDoc = (A, want) => {
  const ds = A.documents()
  if (!ds.length) throw new Error('No document is open. Open one with the open action first.')
  if (want === undefined || want === null || want === '') return ds[0]
  if (typeof want === 'number') { if (!ds[want - 1]) throw new Error('There is no document ' + want + '; ' + ds.length + ' are open.'); return ds[want - 1] }
  const w = String(want).toLowerCase()
  const hit = ds.find((d) => d.name().toLowerCase() === w) || ds.find((d) => d.name().toLowerCase().indexOf(w) >= 0)
  if (!hit) throw new Error('No open document named "' + want + '". Open: ' + ds.map((d) => d.name()).join(', '))
  return hit
}`
/** An element of a collection by name or 1-based number (the first by default). */
export const JXA_PICK = `const pick = (coll, want, what) => {
  if (want === undefined || want === null || want === '') { if (!coll.length) throw new Error('No ' + what + ' here.'); return coll[0] }
  if (typeof want === 'number') { if (want < 1 || want > coll.length) throw new Error('There is no ' + what + ' ' + want + '.'); return coll[want - 1] }
  const names = coll.name()
  const w = String(want).toLowerCase()
  let i = names.findIndex((n) => String(n).toLowerCase() === w)
  if (i < 0) i = names.findIndex((n) => String(n).toLowerCase().indexOf(w) >= 0)
  if (i < 0) throw new Error('No ' + what + ' named "' + want + '". There are: ' + names.join(', '))
  return coll[i]
}`
/** A Path or file URL from a scripting dictionary → POSIX path. */
export const JXA_POSIX = `const posix = (x) => { if (!x) return ''; const s = String(x); if (/^file:/.test(s)) return ObjC.unwrap($.NSURL.URLWithString(s).path); return s }`
