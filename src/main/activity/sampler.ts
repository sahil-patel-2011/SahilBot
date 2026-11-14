import { automationError } from '../permissions-center'
import { browserFor, isBrowser, type RawSample } from './rules'

// One look at what's in front, through osascript (JXA). Never a screenshot, keystrokes, page contents or
// the clipboard: the front app's name and bundle id (NSWorkspace, needs no permission), the focused
// window's title and document (System Events, needs Accessibility; only once the user's own check said
// System Events answers), and the front browser tab's title and address (that browser's scripting
// dictionary, needs Automation; only browsers the user's check allowed, so macOS never prompts in the
// background). Private and incognito windows are detected in the script and their tab is never read.

/** Runs a JXA function source with one JSON argument and returns its JSON result (the app's osascript runner). */
export type Jxa = (fn: string, input: unknown, timeoutMs: number) => Promise<unknown>

const GET = `const get = (f, d) => { try { const v = f(); return v === undefined || v === null ? d : v } catch (e) { return d } }`

/** The front app (NSWorkspace) and, when asked, its focused window's title and document (System Events). */
export const FRONT_JS = `(a) => {
  ${GET}
  const ws = $.NSWorkspace.sharedWorkspace
  const fa = ws.frontmostApplication
  if (!fa || fa.isNil()) return null
  const out = { app: String(ObjC.unwrap(fa.localizedName) || ''), bundleId: String(ObjC.unwrap(fa.bundleIdentifier) || ''), pid: Number(fa.processIdentifier) }
  if (a.window) {
    const se = Application('System Events')
    const ps = se.processes.whose({ unixId: out.pid })
    const P = get(() => (ps.length ? ps[0] : null), null)
    if (P) {
      const fw = get(() => P.attributes.byName('AXFocusedWindow').value(), null)
      const w = fw || get(() => P.windows[0], null)
      if (w) {
        out.title = String(get(() => w.name(), '') || '')
        out.document = String(get(() => w.attributes.byName('AXDocument').value(), '') || '')
      }
    }
  }
  return out
}`

/** The user's own check that System Events answers (launches it if needed; macOS may ask once). Reads nothing. */
export const SYSTEM_EVENTS_CHECK_JS = `() => { Application('System Events').processes.length; return 'ok' }`

/** Safari: the front window's current tab, unless it's a private window (Safari keeps those out of its documents). */
export const SAFARI_TAB_JS = `(a) => {
  ${GET}
  const S = Application(a.app)
  if (!get(() => S.running(), false)) return null
  const w = get(() => S.windows[0], null)
  if (!w) return null
  const name = String(get(() => w.name(), '') || '')
  if (/private/i.test(name)) return { private: true }
  const docs = get(() => S.documents.name(), [])
  if (!docs.includes(name)) return { private: true }
  const t = get(() => w.currentTab(), null)
  if (!t) return null
  return { title: String(get(() => t.name(), '') || ''), url: String(get(() => t.url(), '') || '') }
}`

/** Chrome, Brave, Edge: the front window's active tab, unless the window is incognito (mode "incognito"). */
export const CHROMIUM_TAB_JS = `(a) => {
  ${GET}
  const C = Application(a.app)
  if (!get(() => C.running(), false)) return null
  const w = get(() => C.windows[0], null)
  if (!w) return null
  const mode = String(get(() => w.mode(), 'unknown') || 'unknown')
  if (mode !== 'normal') return { private: true }
  const t = get(() => w.activeTab(), null)
  if (!t) return null
  return { title: String(get(() => t.title(), '') || ''), url: String(get(() => t.url(), '') || '') }
}`

/** Arc: the front window's active tab, unless it's an incognito window. */
export const ARC_TAB_JS = `(a) => {
  ${GET}
  const A = Application(a.app)
  if (!get(() => A.running(), false)) return null
  const w = get(() => A.windows[0], null)
  if (!w) return null
  if (get(() => w.incognito(), true) !== false) return { private: true }
  const t = get(() => w.activeTab(), null)
  if (!t) return null
  return { title: String(get(() => t.title(), '') || ''), url: String(get(() => t.URL(), '') || get(() => t.url(), '') || '') }
}`

export const TAB_JS = { safari: SAFARI_TAB_JS, chromium: CHROMIUM_TAB_JS, arc: ARC_TAB_JS } as const

export interface SampleDeps {
  jxa: Jxa
  /** Accessibility is granted (systemPreferences.isTrustedAccessibilityClient(false): never prompts). */
  accessibility: () => boolean
  /** Window titles are wanted and the user's check found System Events answering. */
  windowTitles: boolean
  /** Browsers (names) the user's check allowed; their front tab is read only when tabs are wanted. */
  browsers: string[]
  browserTabs: boolean
}

export interface SampleResult {
  raw: RawSample | null
  /** A permission turned out to be off (macOS said so): stop asking until the user checks again. */
  denied?: { systemEvents?: boolean; browser?: string }
}

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Parses the front-app script's output (any shape: it's another process's answer). */
export function parseFront(out: unknown): RawSample | null {
  if (!out || typeof out !== 'object') return null
  const o = out as Record<string, unknown>
  const app = str(o.app, 200), bundleId = str(o.bundleId, 200)
  if (!app && !bundleId) return null
  const raw: RawSample = { app, bundleId }
  if (typeof o.pid === 'number' && Number.isFinite(o.pid)) raw.pid = o.pid
  if (typeof o.title === 'string') raw.title = str(o.title, 1000)
  if (typeof o.document === 'string' && o.document) raw.document = str(o.document, 2000)
  return raw
}

export function parseTab(out: unknown): RawSample['tab'] | undefined {
  if (!out || typeof out !== 'object') return undefined
  const o = out as Record<string, unknown>
  if (o.private === true) return { title: '', url: '', private: true }
  const url = str(o.url, 4000), title = str(o.title, 1000)
  return url || title ? { title, url } : undefined
}

const denial = (e: unknown): boolean => automationError(String((e as Error)?.message ?? e)) === 'denied'

/** One sample: never throws (a failed look is just no sample). */
export async function sampleOnce(d: SampleDeps): Promise<SampleResult> {
  const window = d.windowTitles && safeBool(d.accessibility)
  let raw: RawSample | null
  const denied: NonNullable<SampleResult['denied']> = {}
  try {
    raw = parseFront(await d.jxa(FRONT_JS, { window }, 8000))
  } catch (e) {
    if (!window || !denial(e)) return { raw: null }
    // System Events was turned off: the app's name still works without it.
    denied.systemEvents = true
    try { raw = parseFront(await d.jxa(FRONT_JS, { window: false }, 8000)) } catch { return { raw: null, denied } }
  }
  if (!raw) return { raw: null, ...(Object.keys(denied).length ? { denied } : {}) }
  const b = browserFor(raw.bundleId)
  if (d.browserTabs && b && isBrowser(raw.bundleId) && d.browsers.includes(b.name)) {
    try {
      const tab = parseTab(await d.jxa(TAB_JS[b.kind], { app: b.name }, 8000))
      if (tab) raw.tab = tab
    } catch (e) {
      if (denial(e)) denied.browser = b.name
    }
  }
  return { raw, ...(Object.keys(denied).length ? { denied } : {}) }
}

function safeBool(f: () => boolean): boolean {
  try { return !!f() } catch { return false }
}
