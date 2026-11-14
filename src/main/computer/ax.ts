import { center, contains, type Rect } from './geometry'

// The Accessibility (AX) view of an app, for computer use. A JXA script (scripts.ts) walks the app's
// windows through System Events and returns raw nodes; everything here is pure: picking the elements
// worth showing, giving them refs (e1, e2… kept stable across snapshots, like the browser's), finding a
// ref again after the UI changed, describing what an action changed, and the safety checks (password
// fields, payment sheets, purchase buttons, system authentication dialogs).

/** One element as the snapshot script returns it. */
export interface RawNode {
  /** Window index, then child indexes: how the action script finds the element again. */
  path: number[]
  depth: number
  win: number
  role: string
  subrole?: string
  name?: string
  desc?: string
  value?: string
  enabled?: boolean
  focused?: boolean
  secure?: boolean
  x?: number; y?: number; w?: number; h?: number
}

export interface RawWindow { index: number; title: string; x?: number; y?: number; w?: number; h?: number; focused?: boolean; minimized?: boolean }

export interface RawSnapshot {
  app: string
  pid?: number
  windows: RawWindow[]
  nodes: RawNode[]
  truncated?: boolean
  error?: string
}

export interface AxElement {
  ref: string
  role: string
  subrole?: string
  /** What a person would call it: its title, description, or (static text) its text. */
  label: string
  value?: string
  enabled: boolean
  focused: boolean
  /** A password field: never typed into, value never read. */
  secure: boolean
  /** Can be pressed with AXPress (buttons, checkboxes, menu items, links…). */
  pressable: boolean
  /** Takes typed text. */
  editable: boolean
  rect?: Rect
  path: number[]
  win: number
  window: string
  /** The raw title/description, to check it's still the same element before acting. */
  name: string
  desc: string
}

export interface AxSnapshot {
  app: string
  pid?: number
  at: number
  windows: Array<RawWindow & { ref: string }>
  elements: AxElement[]
  truncated: boolean
  /** Next free element number (refs are never reused within a thread). */
  next: number
}

const INTERACTIVE = /^AX(Button|CheckBox|RadioButton|PopUpButton|MenuButton|MenuItem|MenuBarItem|Link|TextField|TextArea|ComboBox|Slider|Incrementor|Stepper|DisclosureTriangle|Tab|Cell|Row|ColorWell|SearchField|SecureTextField|Switch|SegmentedControl|DateField|TimeField|Toolbar)$/
const TEXTUAL = /^AX(StaticText|Heading|Image|ValueIndicator|ProgressIndicator|LevelIndicator)$/
const PRESSABLE = /^AX(Button|CheckBox|RadioButton|PopUpButton|MenuButton|MenuItem|MenuBarItem|Link|DisclosureTriangle|Cell|Row|ColorWell|Tab|Switch|Incrementor|Stepper)$/
const EDITABLE = /^AX(TextField|TextArea|ComboBox|SearchField|SecureTextField|DateField|TimeField)$/
/** Field labels that mean a secret even when the app didn't use a secure text field. */
const SECRET_LABEL = /\b(pass(word|code|phrase)?|passwd|pin( code)?|security code|cvv|cvc|one[- ]time code|verification code|2fa|otp)\b/i

export const short = (role: string): string => role.replace(/^AX/, '')

export function isSecure(n: { role: string; subrole?: string; name?: string; desc?: string; label?: string; secure?: boolean }): boolean {
  if (n.secure || n.subrole === 'AXSecureTextField' || n.role === 'AXSecureTextField') return true
  return EDITABLE.test(n.role) && SECRET_LABEL.test(`${n.label ?? ''} ${n.name ?? ''} ${n.desc ?? ''}`)
}

function labelOf(n: RawNode): string {
  const t = (n.name || n.desc || (n.role === 'AXStaticText' || n.role === 'AXHeading' ? n.value : '') || '').replace(/\s+/g, ' ').trim()
  return t.length > 100 ? `${t.slice(0, 99)}…` : t
}

/** Worth listing: something you can act on, or text/images that say what's on screen. */
function worthShowing(n: RawNode, label: string): boolean {
  if (n.w !== undefined && n.h !== undefined && (n.w < 2 || n.h < 2)) return false
  if (INTERACTIVE.test(n.role)) return !!label || EDITABLE.test(n.role) || !!n.value || n.role === 'AXCheckBox' || n.role === 'AXRadioButton'
  if (TEXTUAL.test(n.role)) return !!label
  return false
}

const sameThing = (a: { role: string; label: string; window: string }, b: { role: string; label: string; window: string }): boolean =>
  a.role === b.role && a.label === b.label && a.window === b.window

const dist = (a?: Rect, b?: Rect): number => {
  if (!a || !b) return 1e6
  const p = center(a), q = center(b)
  return Math.hypot(p.x - q.x, p.y - q.y)
}

/**
 * Turns a raw snapshot into elements with refs. An element that matches one in the previous snapshot
 * (same role, label and window, nearest position) keeps its ref, so refs the model already holds keep
 * working after the UI changes; new elements get new numbers.
 */
export function buildSnapshot(raw: RawSnapshot, prev?: AxSnapshot, at = Date.now()): AxSnapshot {
  let next = prev && prev.app === raw.app ? prev.next : 1
  const titles = new Map(raw.windows.map((w) => [w.index, w.title]))
  const used = new Set<string>()
  const pool = prev && prev.app === raw.app ? [...prev.elements] : []
  const elements: AxElement[] = []
  for (const n of raw.nodes) {
    const label = labelOf(n)
    if (!worthShowing(n, label)) continue
    const secure = isSecure({ ...n, label })
    const rect = n.x !== undefined && n.y !== undefined && n.w !== undefined && n.h !== undefined ? { x: n.x, y: n.y, width: n.w, height: n.h } : undefined
    const el: Omit<AxElement, 'ref'> = {
      role: n.role, subrole: n.subrole || undefined, label,
      value: secure || n.value === undefined || n.value === '' || (n.role === 'AXStaticText' && n.value === label) ? undefined : String(n.value).slice(0, 200),
      enabled: n.enabled !== false, focused: !!n.focused, secure,
      pressable: PRESSABLE.test(n.role), editable: EDITABLE.test(n.role),
      rect, path: n.path, win: n.win, window: titles.get(n.win) ?? '', name: n.name ?? '', desc: n.desc ?? ''
    }
    // Same element as before: keep its ref.
    let ref: string | undefined
    const candidates = pool.filter((p) => !used.has(p.ref) && sameThing(p, el))
    if (candidates.length) ref = candidates.sort((a, b) => dist(a.rect, rect) - dist(b.rect, rect))[0].ref
    if (!ref) ref = `e${next++}`
    used.add(ref)
    elements.push({ ref, ...el })
  }
  return {
    app: raw.app, pid: raw.pid, at, truncated: !!raw.truncated, elements, next,
    windows: raw.windows.map((w, i) => ({ ...w, ref: `w${i + 1}` }))
  }
}

/** The snapshot as the model reads it: one line per element, grouped by window, focused window first. */
export function formatSnapshot(s: AxSnapshot, o: { query?: string; limit?: number } = {}): string {
  const q = o.query?.toLowerCase().trim()
  const els = q ? s.elements.filter((e) => `${e.label} ${e.value ?? ''} ${short(e.role)}`.toLowerCase().includes(q)) : s.elements
  const limit = o.limit ?? 250
  const lines: string[] = []
  const wins = [...s.windows].sort((a, b) => Number(!!b.focused) - Number(!!a.focused) || a.index - b.index)
  lines.push(`App: ${s.app}${s.windows.length ? ` · ${s.windows.length} window${s.windows.length === 1 ? '' : 's'}` : ' · no windows'}`)
  let shown = 0
  for (const w of wins) {
    const mine = els.filter((e) => e.win === w.index)
    lines.push(`Window ${w.index + 1} "${w.title || '(untitled)'}"${w.focused ? ' (focused)' : ''}${w.minimized ? ' (minimized)' : ''}${mine.length ? ':' : ''}`)
    for (const e of mine) {
      if (shown >= limit) break
      lines.push(`  ${formatElement(e)}`)
      shown++
    }
  }
  if (shown >= limit && els.length > limit) lines.push(`… ${els.length - limit} more (use ui with query to narrow it down)`)
  if (s.truncated) lines.push('(The window has more elements than were read; use ui with window or query, or a screenshot.)')
  if (q && !els.length) lines.push(`(Nothing matching "${o.query}".)`)
  return lines.join('\n')
}

export function formatElement(e: AxElement): string {
  const role = e.secure ? 'SecureTextField' : short(e.subrole === 'AXSwitch' ? 'AXSwitch' : e.subrole === 'AXSearchField' ? 'AXSearchField' : e.role)
  const flags = [e.focused ? 'focused' : '', !e.enabled ? 'disabled' : '', e.secure ? 'password: the user types it' : ''].filter(Boolean)
  const val = e.value !== undefined ? ` = "${e.value.length > 80 ? `${e.value.slice(0, 79)}…` : e.value}"` : ''
  return `[${e.ref}] ${role}${e.label ? ` "${e.label}"` : ''}${val}${flags.length ? ` (${flags.join(', ')})` : ''}`
}

/** An element by ref from the thread's last snapshot. */
export function byRef(s: AxSnapshot | undefined, ref: string): AxElement | undefined {
  const r = ref.trim().replace(/^\[|\]$/g, '').toLowerCase()
  return s?.elements.find((e) => e.ref === r)
}

/**
 * The same element in a fresh snapshot (its path moved: windows reordered, rows added): same role and
 * label, preferring the same window title, then the nearest position.
 */
export function relocate(old: AxElement, fresh: AxSnapshot): AxElement | undefined {
  const same = fresh.elements.filter((e) => e.role === old.role && e.label === old.label)
  if (!same.length) return undefined
  return [...same].sort((a, b) => Number(b.window === old.window) - Number(a.window === old.window) || dist(a.rect, old.rect) - dist(b.rect, old.rect))[0]
}

/**
 * What a coordinate click at a screen point would hit: the smallest pressable or editable element
 * there (a button, not the label inside it), else the smallest listed element.
 */
export function elementAt(s: AxSnapshot | undefined, x: number, y: number): AxElement | undefined {
  const area = (e: AxElement): number => e.rect!.width * e.rect!.height
  const hits = (s?.elements ?? []).filter((e) => e.rect && contains(e.rect, x, y)).sort((a, b) => area(a) - area(b))
  return hits.find((e) => e.pressable || e.editable) ?? hits[0]
}

// ---------------------------------------------------------------------------------------------- state

/** A quick read of what's in front, before and after each action (state script). */
export interface UiState {
  app: string
  window: string
  windows: number
  sheets: number
  /** Children of the focused window (a cheap sign that its contents changed). */
  kids?: number
  focused?: { role: string; subrole?: string; label: string; value?: string; secure: boolean; x?: number; y?: number; w?: number; h?: number }
  /** The element the action targeted, read again. */
  target?: { exists: boolean; value?: string; enabled?: boolean; focused?: boolean; label?: string }
}

/** Two reads of the screen state are the same (the UI has settled). */
export const sameState = (a: UiState, b: UiState): boolean => JSON.stringify(a) === JSON.stringify(b)

const q = (s: string | undefined, n = 60): string => `"${(s ?? '').length > n ? `${(s ?? '').slice(0, n - 1)}…` : s ?? ''}"`

/**
 * What changed between two reads, for the model: the app, window, sheets/dialogs, focus, the focused
 * field's value and the target's value. `changed` is false when nothing it can see moved (the action may
 * have done nothing, or changed something only a screenshot shows).
 */
export function describeChange(before: UiState, after: UiState): { changed: boolean; text: string } {
  const out: string[] = []
  if (before.app !== after.app) out.push(`front app ${before.app} → ${after.app}`)
  if (before.window !== after.window) out.push(`window ${q(before.window)} → ${q(after.window)}`)
  if (after.windows !== before.windows && before.app === after.app) out.push(`${after.windows > before.windows ? 'a window opened' : 'a window closed'} (${after.windows} now)`)
  if (after.sheets > before.sheets) out.push('a dialog/sheet opened')
  if (after.sheets < before.sheets) out.push('a dialog/sheet closed')
  const bf = before.focused, af = after.focused
  const fname = (f?: UiState['focused']): string => (f ? `${short(f.role)}${f.label ? ` ${q(f.label, 40)}` : ''}` : 'nothing')
  if ((bf?.role ?? '') !== (af?.role ?? '') || (bf?.label ?? '') !== (af?.label ?? '')) out.push(`focus ${fname(bf)} → ${fname(af)}`)
  else if (af && !af.secure && bf?.value !== af.value) out.push(`${fname(af)} value ${q(bf?.value)} → ${q(af.value)}`)
  const bt = before.target, at = after.target
  if (bt && at) {
    if (bt.exists && !at.exists) out.push('the target element is gone')
    else if (at.exists) {
      if (bt.value !== at.value) out.push(`its value ${q(bt.value)} → ${q(at.value)}`)
      if (bt.enabled !== at.enabled) out.push(at.enabled ? 'it became enabled' : 'it became disabled')
      if (!bt.focused && at.focused && !out.some((l) => l.startsWith('focus'))) out.push('it is now focused')
    }
  }
  const contentChanged = before.kids !== undefined && after.kids !== undefined && before.kids !== after.kids
  if (!out.length && contentChanged) out.push('the window\'s contents changed')
  const now = `Now: ${after.app}${after.window ? ` › ${q(after.window)}` : ''}${af ? `, focus on ${fname(af)}${af.secure ? ' (password field)' : af.value ? ` = ${q(af.value, 80)}` : ''}` : ''}.`
  return out.length
    ? { changed: true, text: `Changed: ${out.join('; ')}. ${now}` }
    : { changed: false, text: `No change detected in the app, window, focus or values. ${now} If you expected one, the action may have missed: check with ui or a screenshot before going on.` }
}

// ---------------------------------------------------------------------------------------------- safety

export interface GuardInput {
  action: string
  app: string
  window?: string
  /** The element acted on (by ref, or under a click point). */
  el?: Pick<AxElement, 'role' | 'label' | 'secure'> & { subrole?: string; value?: string }
  /** The focused element, for typing without a ref. */
  focused?: UiState['focused']
  /** Whether this action types or sets text. */
  typing?: boolean
}

export interface Guard { kind: 'password' | 'payment' | 'authentication'; reason: string; ask: string }

/** System prompts for an admin password, Touch ID or a keychain: only the user answers those. */
const AUTH_APPS = /^(SecurityAgent|coreautha|coreauthd|UserNotificationCenter|loginwindow|ScreenSaverEngine|LocalAuthenticationRemoteService|Keychain Access|Passwords)$/i
const AUTH_WINDOW = /\b(enter (your |the )?(admin(istrator)?|login|mac) password|authenticate|authentication|unlock|touch id|keychain|wants to make changes|wants to use your confidential information)\b/i
/** Apple Pay and Wallet sheets. */
const PAY_SHEET = /\b(apple pay|wallet|passkit|passbook|pay with|double[- ]click (the )?(side|power) button|confirm with touch id|confirm payment)\b/i
const PAY_APPS = /^(Wallet|PassbookUIService|PassKit|Apple Pay)/i
/** Buttons that spend money or start a paid commitment. */
const BUY = /\b(buy( now| it| again)?|purchase|place (your |the )?order|complete (your |the )?(purchase|order|payment)|pay( now)?|checkout|check out|subscribe|start (my |your )?(free )?trial|upgrade( now)?|confirm (purchase|payment|subscription)|rent|pre-?order|redeem)\b/i
const PRICE = /([$€£¥₹]\s?\d|\d\s?(usd|eur|gbp)\b)/i
/** In the App Store, "Get" and "Install" start a purchase flow (Apple ID authentication). */
const STORE_BUTTON = /^(get|install|buy|purchase|subscribe|try free|free trial)\b/i

/**
 * Steps SahilBot must hand to the user instead of doing: typing into password fields, anything in a
 * system authentication prompt or an Apple Pay/Wallet sheet, and buttons that buy or subscribe in native
 * apps (App Store included). Returns why, or null.
 */
export function guardAction(g: GuardInput): Guard | null {
  const where = `${g.app}${g.window ? ` (${g.window})` : ''}`
  if (AUTH_APPS.test(g.app) || (g.typing && g.window && AUTH_WINDOW.test(g.window)))
    return { kind: 'authentication', reason: `a system password or Touch ID prompt in ${where}`, ask: `${g.app} is asking for your password or Touch ID. Please answer it yourself, then tell me when you're done.` }
  if (PAY_APPS.test(g.app) || PAY_SHEET.test(g.window ?? '') || (g.el && PAY_SHEET.test(g.el.label)))
    return { kind: 'payment', reason: `an Apple Pay / Wallet payment in ${where}`, ask: `There's a payment sheet open in ${where}. I don't confirm payments: please review and complete (or cancel) it yourself, then tell me when you're done.` }
  if (g.typing) {
    const target = g.el ?? (g.focused ? { role: g.focused.role, subrole: g.focused.subrole, label: g.focused.label, secure: g.focused.secure } : undefined)
    if (target && isSecure({ role: target.role, subrole: target.subrole, label: target.label, secure: target.secure }))
      return { kind: 'password', reason: `typing into a password field${target.label ? ` ("${target.label}")` : ''} in ${where}`, ask: `The next step is typing a password${target.label ? ` into "${target.label}"` : ''} in ${where}. I never type passwords: please type it yourself, then tell me when you're done.` }
  }
  if (g.el && !g.typing) {
    const label = `${g.el.label} ${g.el.value ?? ''}`
    // Buttons, links and menu items: a reminder titled "Buy milk" (static text, a row) is not a purchase.
    const press = /^AX(Button|MenuItem|Link|PopUpButton|MenuButton)$/.test(g.el.role)
    if (press && /^App Store$/i.test(g.app) && (STORE_BUTTON.test(g.el.label) || PRICE.test(label)))
      return { kind: 'payment', reason: `the App Store "${g.el.label}" button (starts a purchase)`, ask: `Getting or buying "${g.el.label}" in the App Store is a purchase step. Please do it yourself, then tell me when you're done.` }
    if (press && (BUY.test(g.el.label) || (PRICE.test(g.el.label) && /^AX(Button|Link|MenuItem)$/.test(g.el.role))))
      return { kind: 'payment', reason: `the "${g.el.label}" button in ${where} (buys or subscribes)`, ask: `Clicking "${g.el.label}" in ${where} would buy or subscribe to something. I leave purchases to you: please review it and click it yourself if you want it, then tell me when you're done.` }
  }
  return null
}

// ---------------------------------------------------------------------------------------------- SahilBot itself

/** How SahilBot recognizes its own processes and windows. */
export interface SelfInfo {
  /** The app's own process and its helpers (renderer, GPU, utility). */
  pids: number[]
  /** App names it runs under ("SahilBot"; "Electron" in development). */
  names: string[]
  bundleIds?: string[]
  /** Titles of its windows (only used when the app owning a window isn't known). */
  titles: string[]
  /** Where its visible windows are, in global screen points (the mini window included). */
  rects: Rect[]
}

/**
 * Why an action would land on SahilBot itself, or null. Computer use never clicks, types into or drives
 * SahilBot's own windows: its approval and purchase cards are only for the user's own clicks.
 */
export function selfTarget(self: SelfInfo | undefined, t: { app?: string; pid?: number; bundleId?: string; window?: string; point?: { x: number; y: number } }): string | null {
  if (!self) return null
  const app = (t.app ?? '').trim().toLowerCase()
  if (t.pid !== undefined && self.pids.includes(t.pid)) return 'That element belongs to SahilBot itself.'
  if (app && self.names.some((n) => n.toLowerCase() === app)) return `${t.app} is SahilBot itself.`
  if (t.bundleId && (self.bundleIds ?? []).some((b) => b.toLowerCase() === t.bundleId!.toLowerCase())) return 'That is SahilBot itself.'
  if (!app && t.window && self.titles.some((x) => x && x === t.window)) return `The window "${t.window}" is SahilBot's own.`
  if (t.point && self.rects.some((r) => contains(r, t.point!.x, t.point!.y))) return 'That point is on one of SahilBot\'s own windows.'
  return null
}

/** Clipboard text with anything that looks like a secret blanked out (the model never sees keys or passwords). */
export function redactClipboard(text: string): { text: string; redacted: boolean } {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    // Card numbers: 13-19 digits, optionally grouped.
    /\b(?:\d[ -]?){12,18}\d\b/g
  ]
  let out = text
  for (const re of patterns) out = out.replace(re, '[hidden: looks like a secret]')
  return { text: out, redacted: out !== text }
}

// ---------------------------------------------------------------------------------------------- System Settings

const SETTINGS_APPS = /^(System Settings|System Preferences)$/i
/** Panes (and controls) where a change weakens the Mac's security or grants an app power over it. */
const SECURITY_PANE = /\b(privacy|security|passwords?|users?( & | and )groups|login (items|password|options)|lock screen|touch id|filevault|firewall|sharing|remote (login|management)|profiles?|device management|screen time|accessibility|full disk access|screen (recording|& system audio recording)|automation|input monitoring|developer tools|app management|apple (id|account)|icloud|keychain|gatekeeper|allow applications|location services|camera|microphone|contacts|passkeys?)\b/i

/**
 * A hard stop for acting in System Settings on a security or privacy pane: clicking, typing or setting
 * values there always asks the user first, whatever the mode. Returns why, or null.
 */
export function settingsStop(app: string | undefined, window?: string, label?: string): string | null {
  if (!app || !SETTINGS_APPS.test(app.trim())) return null
  const hit = [window, label].find((s) => !!s && SECURITY_PANE.test(s))
  return hit ? `changing a security or privacy setting in System Settings ("${hit.slice(0, 60)}")` : null
}
