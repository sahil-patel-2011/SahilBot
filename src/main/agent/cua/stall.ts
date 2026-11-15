// Loop and stall detection for computer use, with recovery strategies (agent/cua). Pure.
//
// A stall is the agent acting without getting anywhere: the same action on the same target again and again,
// several actions in a row that changed nothing on screen, repeated errors, or going back and forth between
// two actions. Each kind gets concrete recovery steps, in the order that usually works on a Mac: read the
// app's elements (Accessibility refs beat pixels), zoom in on small targets, scroll the target into view,
// keyboard navigation, the menu bar (and its Help search), relaunching or switching apps with open -a /
// Spotlight, and waiting for the UI to finish loading instead of sleeping.

export interface ActionRecord {
  /** Tool name (computer, mac_ui, browser, app…). */
  tool: string
  /** The action within the tool (click, type, key…) or ''. */
  action: string
  /** What it acted on: a ref, a rounded point, keys, a URL… ('' when none). */
  target: string
  /** The result said something changed (false: "no change"; undefined: can't tell). */
  changed?: boolean
  /** The call failed. */
  error?: boolean
}

export type StallKind = 'repeat' | 'no-effect' | 'errors' | 'oscillation'

export interface Stall {
  kind: StallKind
  /** In words, for the model and the timeline. */
  text: string
  /** Recovery steps to try, best first. */
  recover: string[]
}

/** Read-only actions: looking doesn't count toward "no effect" (but repeating a read still counts as a repeat). */
const READS = new Set(['screenshot', 'zoom', 'ui', 'apps', 'windows', 'wait', 'wait_for', 'clipboard_read', 'snapshot', 'get_text', 'find', 'tabs', 'read', 'list'])

const key = (r: ActionRecord): string => `${r.tool}:${r.action}:${r.target}`

/** A record from a tool call's name, arguments and result (the loop's view of any tool). */
export function recordOf(tool: string, argsJson: string, result: { status?: string; text?: string; display?: string }): ActionRecord {
  let a: Record<string, unknown> = {}
  try { a = JSON.parse(argsJson || '{}') as Record<string, unknown> } catch { /* not JSON */ }
  const action = String(a.action ?? a.member ?? '')
  const pt = typeof a.x === 'number' && typeof a.y === 'number' ? `${Math.round(a.x / 8) * 8},${Math.round(a.y / 8) * 8}` : ''
  const coord = Array.isArray(a.coordinate) && a.coordinate.length === 2 ? `${Math.round(Number(a.coordinate[0]) / 8) * 8},${Math.round(Number(a.coordinate[1]) / 8) * 8}` : ''
  const target = String(a.ref ?? a.keys ?? a.path ?? a.url ?? a.app ?? a.window ?? (pt || coord) ?? '').slice(0, 120) + (a.text ? `|${String(a.text).slice(0, 40)}` : '')
  const text = `${result.display ?? ''}\n${result.text ?? ''}`
  const noChange = /\(no change\)|No change detected|nothing changed|Nothing was copied|didn't change/i.test(text)
  const changedWords = /\bChanged:|Now: .*›|opened|navigated|Pressed .*Changed|value .* → /i.test(text)
  return { tool, action, target, error: result.status !== undefined && result.status !== 'ok', changed: noChange ? false : changedWords ? true : undefined }
}

/**
 * Whether the recent actions are stuck, and how to get unstuck. `recent` is oldest first; only the last
 * eight matter. Returns null when the agent is making progress (or it's too early to tell).
 */
export function detectStall(recent: ActionRecord[], o: { computer?: boolean } = {}): Stall | null {
  const last = recent.slice(-8)
  if (last.length < 3) return null
  const tail = last.slice(-5)
  // A, B, A, B, A, B: going back and forth.
  if (last.length >= 6) {
    const s = last.slice(-6).map(key)
    if (s[0] === s[2] && s[2] === s[4] && s[1] === s[3] && s[3] === s[5] && s[0] !== s[1]) return { kind: 'oscillation', text: 'Going back and forth between the same two actions.', recover: strategies('oscillation', last.at(-1)!, o) }
  }
  // The same action on the same target three times in the last five.
  const counts = new Map<string, number>()
  for (const r of tail) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1)
  const [rk, rn] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const acting = (r: ActionRecord): boolean => !READS.has(r.action)
  const repeated = tail.find((r) => key(r) === rk)!
  if (rn >= 3 && (acting(repeated) || rn >= 4)) {
    return { kind: 'repeat', text: `The same ${repeated.action || repeated.tool}${repeated.target ? ` on ${repeated.target.split('|')[0]}` : ''} ran ${rn} times in the last ${tail.length} steps.`, recover: strategies('repeat', repeated, o) }
  }
  // Four acting steps in a row that changed nothing.
  const acts = last.filter(acting)
  const lastActs = acts.slice(-4)
  if (lastActs.length >= 4 && lastActs.every((r) => r.changed === false)) {
    return { kind: 'no-effect', text: `The last ${lastActs.length} actions changed nothing on screen.`, recover: strategies('no-effect', lastActs.at(-1)!, o) }
  }
  // Three errors in the last five.
  const errs = tail.filter((r) => r.error)
  if (errs.length >= 3) return { kind: 'errors', text: `${errs.length} of the last ${tail.length} steps failed.`, recover: strategies('errors', errs.at(-1)!, o) }
  return null
}

/** Recovery steps for a stall, best first, phrased as tool actions SahilBot has. */
export function strategies(kind: StallKind, r: ActionRecord, o: { computer?: boolean } = {}): string[] {
  const browser = r.tool === 'browser'
  const coord = /^-?\d+,-?\d+$/.test(r.target.split('|')[0])
  const out: string[] = []
  if (browser) {
    out.push('Take a fresh snapshot and use a ref from it (the page may have changed under you).')
    if (kind !== 'errors') out.push('Scroll the element into view, or use find to locate it by its text.')
    out.push('Use the keyboard: Tab to the control and press Enter or Space.')
    out.push('Check for a dialog, cookie banner or overlay covering the page and close it first.')
    out.push('Wait for the page to finish loading (wait_for the text you expect) instead of retrying.')
    return out
  }
  if (coord || kind === 'no-effect') out.push('Read the app with ui and act on the element by ref (click_ref / type_ref / set_value / press) instead of pixels.')
  if (coord) out.push('Zoom on the target (zoom with a region around it) to check exactly where it is before clicking again.')
  out.push('Take a fresh screenshot: a dialog, sheet or popover may be in the way (press escape to close it if it is not part of the task).')
  if (kind !== 'errors') out.push('Scroll the area: the target may be off screen or in a list that needs scrolling.')
  out.push('Use the keyboard: Tab / arrow keys to move focus, Return or Space to press, or the app\'s shortcut.')
  out.push('Use the menu bar (menu {path: "File > …"}); the Help menu\'s search box (cmd+shift+/) finds any menu item by name.')
  if (o.computer !== false) out.push('Bring the app back with open_app (open -a) or Spotlight (cmd+space, type the app name, Return) if it lost focus or isn\'t responding.')
  out.push('If the app is still loading, use wait_for (until it settles or a given text appears) instead of acting again.')
  if (kind === 'errors') out.unshift('Read the last error carefully: it usually says what to do (a permission, a missing ref, a disabled item).')
  return out
}

/** A stall as one note for the model. */
export const stallNote = (s: Stall): string => `[From the app] Stuck: ${s.text} Don't repeat it. Try, in order:\n${s.recover.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
