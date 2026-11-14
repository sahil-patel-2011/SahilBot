import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ToolContext, ToolDef, ToolOutput } from '../../agent/types'
import { computerControl } from '../../agent/tools/computer'
import { wrap } from '../scripts'
import { ADAPTERS, catalog, consequentialOf, describeCall, effectOf, findAdapter, GENERIC, hardStopOf, helpText, isRoute, route } from './registry'
import { checkArgs, type AppAdapter, type AppEnv, type Args } from './types'

// The app tool: one tool for every app SahilBot has an adapter for (Finder, Safari, Chrome, Numbers,
// Pages, Keynote, Excel, Word, PowerPoint, Preview, Messages, Slack, Music, Spotify, VS Code, Cursor,
// Xcode, System Settings, Notes, Reminders, Calendar). app {app, action, args}; app_help {app} lists an
// app's actions. Each action's effect, hard stop and approval text come from its adapter.

export interface AppToolDeps {
  /** A JXA function with JSON input (default: osascript). */
  osa?: (fn: string, input: unknown, timeoutMs: number) => Promise<unknown>
  /** AppleScript source + argv (default: osascript). */
  applescript?: (src: string, args: string[], timeoutMs: number) => Promise<string>
  sh?: (cmd: string, args: string[], timeoutMs: number) => Promise<string>
  /** Computer use (default: the registered computer tool). */
  computer?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>
  macApps?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>
  /** Where the app is installed, or undefined. */
  installed?: (a: AppAdapter) => Promise<string | undefined>
  running?: (a: AppAdapter) => Promise<boolean>
  /** Whether computer use already has the chat's OK (default: the computer tool's grant). */
  granted?: (threadId: string) => boolean
}

type AppToolArgs = { app?: string; action?: string; args?: Args } & Record<string, unknown>

function exec(cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((ok, fail) => execFile(cmd, args, { timeout: timeoutMs, signal, maxBuffer: 32 * 1024 * 1024 }, (e, out, err) => (e ? fail(new Error((err || e.message).toString().trim().slice(0, 600))) : ok(out.toString()))))
}

/** The call's arguments: `args`, plus any given at the top level (some models flatten them). */
export function argsOf(a: AppToolArgs): Args {
  const { app: _app, action: _action, args, ...rest } = a
  return { ...rest, ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) }
}

/** osascript's errors in words the model (and the user) can act on. */
export function explainError(app: string, message: string): string {
  const m = message.replace(/^execution error:\s*/i, '')
  if (/-1743|not authori[sz]ed to send apple events|not allowed to send apple events/i.test(m)) return `macOS blocked SahilBot from controlling ${app}. The user can allow it in System Settings → Privacy & Security → Automation (turn on ${app} under SahilBot), then try again.`
  if (/-1719|-25211|assistive access|accessibility/i.test(m)) return 'SahilBot needs Accessibility permission for this: System Settings → Privacy & Security → Accessibility.'
  if (/-600\b|isn.t running|not running/i.test(m)) return `${app} isn't running. Open it first.`
  if (/-1712|timed out|timeout|ETIMEDOUT|SIGTERM/i.test(m)) return `${app} took too long to answer (it may be busy or showing a dialog: check with computer ui {app:"${app}"}).`
  if (/-1708|-10000|doesn.t understand|can.t make|-1700/i.test(m)) return `${app} couldn't do that through its scripting (${m.slice(0, 200)}). This version may not support it: use computer use instead (computer ui {app:"${app}"}).`
  if (/-1728|can.t get|-1719/i.test(m)) return `${app} couldn't find that: ${m.slice(0, 240)}`
  return `${app}: ${m.slice(0, 400)}`
}

const cache = new Map<string, { path?: string; at: number }>()

async function defaultInstalled(a: AppAdapter): Promise<string | undefined> {
  const c = cache.get(a.id)
  if (c && Date.now() - c.at < 60_000) return c.path
  let path = [...a.paths, ...a.paths.map((p) => join(homedir(), 'Applications', basename(p)))].find((p) => existsSync(p))
  if (!path) {
    for (const id of a.bundleIds) {
      const out = await exec('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${id.replace(/["\\]/g, '')}"`], 4000).catch(() => '')
      path = out.split('\n').find((l) => l.endsWith('.app'))
      if (path) break
    }
  }
  cache.set(a.id, { path, at: Date.now() })
  return path
}

const RUNNING = `(a) => a.ids.some((id) => { try { return Application(id).running() } catch (e) { return false } })`

export function appTool(getWorkspace: () => string, deps: AppToolDeps = {}): ToolDef<AppToolArgs> {
  const scope = (roots: string[]): { roots: string[]; workspace: string } => ({ roots, workspace: getWorkspace() })
  const jxaRun = deps.osa ?? (async (fn: string, input: unknown, timeoutMs: number): Promise<unknown> => JSON.parse((await exec('osascript', ['-l', 'JavaScript', '-e', wrap(fn), JSON.stringify(input ?? {})], timeoutMs)) || 'null'))
  const asRun = deps.applescript ?? ((src: string, args: string[], timeoutMs: number): Promise<string> => exec('osascript', ['-e', src, ...args], timeoutMs))
  const shRun = deps.sh ?? ((cmd: string, args: string[], timeoutMs: number): Promise<string> => exec(cmd, args, timeoutMs))
  const installed = deps.installed ?? defaultInstalled
  const running = deps.running ?? ((a: AppAdapter): Promise<boolean> => jxaRun(RUNNING, { ids: a.bundleIds }, 10_000).then((x) => !!x).catch(() => false))
  const granted = deps.granted ?? ((tid: string): boolean => computerControl()?.isGranted(tid) ?? false)

  const envFor = (adapter: AppAdapter, ctx: ToolContext): AppEnv => ({
    jxa: async <T,>(fn: string, input: unknown, timeoutMs = 30_000): Promise<T> => {
      const r: unknown = await jxaRun(fn, input, timeoutMs)
      // A script's own refusal: { error: "…" } and nothing else.
      if (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 1 && typeof (r as { error?: unknown }).error === 'string') throw new Error((r as { error: string }).error)
      return r as T
    },
    applescript: (src, args, timeoutMs = 30_000) => asRun(src, args, timeoutMs),
    sh: (cmd, args, timeoutMs = 30_000) => shRun(cmd, args, timeoutMs),
    computer: (args) => {
      if (deps.computer) return deps.computer(args, ctx)
      const c = computerControl()
      if (!c) throw new Error('Computer use isn\'t available, so this action can\'t drive the keyboard.')
      return c.run(args, ctx)
    },
    macApps: async (args) => {
      if (deps.macApps) return deps.macApps(args, ctx)
      const { macAppsTool } = await import('../../agent/tools/apps')
      return macAppsTool().run(args as never, ctx)
    },
    workspace: getWorkspace(),
    roots: ctx.state.roots ?? [],
    signal: ctx.signal
  })

  return {
    name: 'app',
    label: 'Mac app',
    core: false,
    group: 'Mac apps (Finder, browsers, Office, iWork, Messages, Slack, Music, Xcode, System Settings…)',
    untrusted: true,
    effect: (a, c) => effectOf(String(a.app ?? ''), String(a.action ?? ''), argsOf(a), scope(c.roots)),
    consequential: (a, c) => consequentialOf(String(a.app ?? ''), String(a.action ?? ''), argsOf(a), { granted: granted(c.threadId), unattended: c.unattended }),
    hardStop: (a) => hardStopOf(String(a.app ?? ''), String(a.action ?? ''), argsOf(a)),
    describe: (a) => describeCall(String(a.app ?? ''), String(a.action ?? ''), argsOf(a)),
    description: `Work in a Mac app through its own scripting (exact, no clicking) before falling back to computer use. app {app, action, args}. Apps: ${ADAPTERS.map((x) => x.name).join(', ')}. Call app_help {app} (or action "help") first to see the app's actions and their arguments. Each result says what happened; verify anything important (read it back). Sending messages and the Trash always ask; files outside the chat's folders ask.`,
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'e.g. "Finder", "Safari", "Google Chrome", "Numbers", "Microsoft Excel", "Messages", "Slack", "Music", "Xcode", "System Settings"' },
        action: { type: 'string', description: 'an action from app_help, e.g. "open_url", "read", "write", "send"' },
        args: { type: 'object', description: 'the action\'s arguments, e.g. {"url": "https://…"}' }
      },
      required: ['app', 'action'],
      additionalProperties: true
    },
    async run(a, ctx) {
      const app = String(a.app ?? '')
      const action = String(a.action ?? '').trim().toLowerCase()
      const adapter = findAdapter(app)
      if (!adapter) { const miss = route(app, action); throw new Error(isRoute(miss) ? `No adapter for ${app}.` : miss.error) }
      if ((GENERIC as readonly string[]).includes(action)) {
        const path = await installed(adapter)
        const on = path ? await running(adapter) : false
        const status = path ? `installed${on ? ', running' : ', not running'}` : 'not installed'
        if (action === 'status') return { text: `${adapter.name}: ${status}${path ? ` (${path})` : ''}.`, display: `${adapter.name} ${status}` }
        return { text: helpText(adapter, status), display: `${adapter.name} actions` }
      }
      const r = route(app, action)
      if (!isRoute(r)) throw new Error(r.error)
      const args = argsOf(a)
      const bad = checkArgs(r.action, args, `${adapter.name} ${r.id}`)
      if (bad) throw new Error(`${bad} See app_help {app:"${adapter.name}"}.`)
      if (!(await installed(adapter))) throw new Error(`${adapter.name} isn't installed on this Mac.`)
      if (r.action.needsRunning && !(await running(adapter))) return { text: `${adapter.name} isn't open, so there's nothing to read yet. Open it (computer open_app {app:"${adapter.name}"}, or an open action) and try again.`, display: `${adapter.name} not open` }
      ctx.progress?.(`${adapter.name}: ${r.action.describe(args).slice(0, 80)}`)
      try {
        const out = await r.action.run(args, envFor(adapter, ctx))
        return { text: out.text, display: out.display ?? `${adapter.name} ${r.id}`, path: out.path }
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        throw new Error(explainError(adapter.name, (e as Error).message))
      }
    }
  }
}

/** app_help {app?}: an app's actions, or the list of apps. Read-only. */
export function appHelpTool(): ToolDef<{ app?: string }> {
  return {
    name: 'app_help',
    label: 'Mac app help',
    core: false,
    effect: 'read',
    describe: (a) => (a.app ? `List what SahilBot can do in ${a.app}` : 'List the Mac apps SahilBot can work in'),
    description: 'What the app tool can do in a Mac app: its actions, their arguments and effects, and the skill with recipes. Without app: every app with an adapter.',
    parameters: { type: 'object', properties: { app: { type: 'string', description: 'e.g. "Finder", "Numbers", "Slack"' } }, additionalProperties: false },
    async run(a) {
      if (!a.app) return { text: catalog(), display: `${ADAPTERS.length} apps` }
      const ad = findAdapter(a.app)
      if (!ad) return { text: `No adapter for "${a.app}": use computer use for it (computer ui {app:"${a.app}"}).\n\n${catalog()}`, display: 'no adapter' }
      const path = await defaultInstalled(ad).catch(() => undefined)
      return { text: helpText(ad, path ? 'installed' : 'not installed'), display: `${ad.name} actions` }
    }
  }
}
