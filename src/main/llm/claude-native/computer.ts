import type { WireTool } from '../client'

// Claude's native computer use (computer_toolset_20260801) on top of SahilBot's own computer tool.
//
// Reference: shared/tool-use-concepts.md § Client-Side Tools: Computer Use, shared/model-migration.md →
// Migrating to Claude Opus 5.5 → Breaking change 4 (and the computer use page it points to):
// - the tools entry is {"type": "computer_toolset_20260801"} with no name and no display size, plus an
//   optional `configs` map that turns members off ({"zoom": {"enabled": false}});
// - Claude's calls are tool_use blocks whose `name` is the member (screenshot, left_click, type, …) and
//   which carry "toolset_name": "computer"; there can be several per turn, run in order;
// - every tool_result echoes "toolset_name": "computer"; only screenshot/zoom need an image;
// - coordinates are pixels of the full screenshots returned to Claude, origin top left;
// - after a failed action the rest of the batch is answered with HALT_TEXT, unexecuted.
//
// SahilBot's computer tool already maps "pixels of the last screenshot" to screen points (Retina and
// several displays, computer/geometry.ts), so a native call translates to the same action with the same
// x,y. The loop runs it through the same validation, permissions, hard stops, overlay and approvals as
// any computer call: only the name and arguments are rewritten here.
//
// Members SahilBot's tool can't do exactly (zoom, middle_click, left_mouse_down/up, cursor_position,
// hold_key) are switched off with configs, so Claude never plans around them. Zoom especially: its
// coordinates stay in the full screenshot's space, while SahilBot's region screenshot re-bases them.

export const TOOLSET_TYPE = 'computer_toolset_20260801'
export const TOOLSET_NAME = 'computer'

/** All 17 toolset members (the computer use page's member table). */
export const TOOLSET_MEMBERS = [
  'screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag',
  'mouse_move', 'left_mouse_down', 'left_mouse_up', 'cursor_position', 'scroll', 'type', 'key', 'hold_key', 'wait'
] as const

/** Members turned off: SahilBot's computer tool has no exact equivalent. */
export const DISABLED_MEMBERS = ['zoom', 'middle_click', 'left_mouse_down', 'left_mouse_up', 'cursor_position', 'hold_key'] as const

/** The exact text the toolset expects for actions skipped after an earlier failure in the same turn. */
export const HALT_TEXT = 'Not executed: an earlier computer action in this turn failed.'

/** The tools entry. Fixed, so the tools prefix (and the prompt cache) never changes. */
export function toolsetDef(): Record<string, unknown> {
  return { type: TOOLSET_TYPE, configs: Object.fromEntries(DISABLED_MEMBERS.map((m) => [m, { enabled: false }])) }
}

export const isToolsetMember = (name: string): boolean => (TOOLSET_MEMBERS as readonly string[]).includes(name)

// ------------------------------------------------------------------------------------- the alias

/**
 * SahilBot's own computer tool stays available for what the toolset doesn't do (reading apps through the
 * Accessibility API, clicking elements by ref, menus, apps, windows, the clipboard), under another name:
 * the toolset can't share a request with another tool named "computer". Screenshots and coordinate
 * actions are left to the toolset, so the only screenshots that set the coordinate frame are the
 * toolset's own full screenshots.
 */
export const ALIAS_NAME = 'mac_ui'
export const ALIAS_ACTIONS = [
  'ui', 'apps', 'windows', 'clipboard_read', 'clipboard_write', 'click_ref', 'type_ref', 'set_value', 'press', 'click_element',
  'open_app', 'activate_app', 'quit_app', 'focus_window', 'menu', 'paste_text', 'copy', 'select_all'
] as const

const COORDINATE_PROPS = ['x', 'y', 'x2', 'y2', 'coords', 'amount', 'dx', 'display', 'region', 'seconds']

export function aliasTool(computer: WireTool): WireTool {
  const p = computer.function.parameters as { properties?: Record<string, Record<string, unknown>>; allOf?: Array<{ if?: { properties?: { action?: { const?: string; enum?: string[] } } } }>; [k: string]: unknown }
  const allowed = new Set<string>(ALIAS_ACTIONS)
  const properties = Object.fromEntries(Object.entries(p.properties ?? {}).filter(([k]) => !COORDINATE_PROPS.includes(k)).map(([k, v]) =>
    k === 'action' ? [k, { ...v, enum: ALIAS_ACTIONS.filter((a) => ((v.enum as string[] | undefined) ?? []).includes(a)) }] : [k, v]))
  const allOf = (p.allOf ?? []).filter((c) => {
    const a = c.if?.properties?.action
    const names = a?.const !== undefined ? [a.const] : a?.enum ?? []
    return names.some((n) => allowed.has(n))
  })
  return {
    type: 'function',
    function: {
      name: ALIAS_NAME,
      description: `Read and operate Mac apps through the Accessibility API (the computer toolset sees the screen and uses coordinates; this tool uses elements):
- ui {app?, window?, query?}: the app's windows and elements with refs like e12, values, focus and disabled state.
- click_ref {ref, modifiers?}, type_ref {ref, text, clear?, submit?}, set_value {ref, value}, press {ref, ax_action}: act on an element by ref.
- apps, windows {app?}, open_app {app}, activate_app {app}, focus_window {window}, quit_app {app} (asks first), menu {path: "File > Export > PDF…"}.
- paste_text {text, ref?} (fast for long or non-ASCII text; the clipboard is put back), copy {ref?}, select_all {ref?}, clipboard_read, clipboard_write {text}.
Prefer refs over coordinates when ui lists the element. SahilBot never types passwords or confirms payments: those steps go to the user.`,
      parameters: { ...p, properties, allOf }
    }
  }
}

// ------------------------------------------------------------------------------------- translation

export type Translated = { args: Record<string, unknown> } | { error: string }

const point = (v: unknown): { x: number; y: number } | undefined => {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return { x: Math.round(v[0] as number), y: Math.round(v[1] as number) }
}

/** Claude's modifier text ("shift", "ctrl+shift", "super") → SahilBot's ("shift", "ctrl+shift", "cmd"). */
export function modifiers(text: unknown): string | undefined | { error: string } {
  if (text === undefined || text === null || text === '') return undefined
  if (typeof text !== 'string') return { error: 'Modifier keys go in text, e.g. "shift" or "ctrl+shift".' }
  const map: Record<string, string> = { shift: 'shift', ctrl: 'ctrl', control: 'ctrl', alt: 'option', option: 'option', opt: 'option', super: 'cmd', cmd: 'cmd', command: 'cmd', meta: 'cmd', win: 'cmd' }
  const out: string[] = []
  for (const part of text.toLowerCase().split(/[+\s]+/).filter(Boolean)) {
    const m = map[part]
    if (!m) return { error: `Unknown modifier "${part}". Use shift, ctrl, alt or super (cmd on this Mac).` }
    if (!out.includes(m)) out.push(m)
  }
  return out.join('+') || undefined
}

/** xdotool-style key names (Return, Page_Down, BackSpace, KP_Enter, super+c) → SahilBot's combos. */
export function normalizeKey(text: string): string {
  const named: Record<string, string> = {
    return: 'return', enter: 'return', kp_enter: 'enter', tab: 'tab', space: 'space', backspace: 'backspace', back_space: 'backspace',
    // xdotool's Delete is forward delete; the Mac's delete key is backspace.
    delete: 'forwarddelete', escape: 'escape', esc: 'escape', up: 'up', down: 'down', left: 'left', right: 'right',
    page_up: 'pageup', prior: 'pageup', page_down: 'pagedown', next: 'pagedown', home: 'home', end: 'end', caps_lock: 'capslock',
    super: 'cmd', super_l: 'cmd', super_r: 'cmd', meta: 'cmd', cmd: 'cmd', command: 'cmd', alt: 'option', alt_l: 'option', alt_r: 'option',
    option: 'option', ctrl: 'ctrl', control: 'ctrl', control_l: 'ctrl', control_r: 'ctrl', shift: 'shift', shift_l: 'shift', shift_r: 'shift',
    minus: 'minus', plus: 'plus', equal: 'equal', comma: 'comma', period: 'period', slash: 'slash', backslash: 'backslash', semicolon: 'semicolon'
  }
  return text.trim().split(/\s*\+\s*/).map((k) => {
    const lower = k.toLowerCase()
    if (named[lower]) return named[lower]
    if (/^f([1-9]|1[0-2])$/.test(lower)) return lower
    if (/^kp_\d$/.test(lower)) return lower.slice(3)
    return k.length === 1 ? k : lower.replace(/_/g, '')
  }).join('+')
}

/** One toolset member call → SahilBot's computer tool arguments (or why it can't be done here). */
export function translateComputer(member: string, input: Record<string, unknown>): Translated {
  if ((DISABLED_MEMBERS as readonly string[]).includes(member)) return { error: `${member} isn't available on this Mac. Use screenshot, the click actions, left_click_drag, mouse_move, scroll, type, key or wait.` }
  const coordinate = point(input.coordinate)
  const needPoint = (what: string): { error: string } => ({ error: `${what} needs coordinate [x, y] in the pixels of the latest screenshot.` })
  switch (member) {
    case 'screenshot':
      return { args: { action: 'screenshot' } }
    case 'left_click': case 'right_click': case 'double_click': case 'triple_click': {
      if (!coordinate) return needPoint(member)
      const mods = modifiers(input.text)
      if (mods && typeof mods === 'object') return mods
      const action = member === 'left_click' ? 'click' : member
      return { args: { action, x: coordinate.x, y: coordinate.y, ...(mods ? { modifiers: mods } : {}) } }
    }
    case 'mouse_move':
      if (!coordinate) return needPoint(member)
      return { args: { action: 'move', x: coordinate.x, y: coordinate.y } }
    case 'left_click_drag': {
      const start = point(input.start_coordinate)
      if (!start || !coordinate) return { error: 'left_click_drag needs start_coordinate and coordinate, each [x, y] in the pixels of the latest screenshot.' }
      if (input.text) return { error: 'Dragging with modifier keys held isn\'t available here; drag without them.' }
      return { args: { action: 'drag', x: start.x, y: start.y, x2: coordinate.x, y2: coordinate.y } }
    }
    case 'scroll': {
      const dir = input.scroll_direction
      if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return { error: 'scroll needs scroll_direction: "up", "down", "left" or "right".' }
      if (input.text) return { error: 'Scrolling with modifier keys held isn\'t available here; scroll without them (use left/right to scroll sideways).' }
      const clicks = typeof input.scroll_amount === 'number' && Number.isFinite(input.scroll_amount) ? Math.max(1, Math.round(input.scroll_amount)) : 3
      // A wheel click scrolls about three lines on macOS; SahilBot's scroll counts lines (negative = down / left).
      const lines = Math.min(50, clicks * 3)
      const vertical = dir === 'up' ? lines : dir === 'down' ? -lines : 0
      const sideways = dir === 'right' ? lines : dir === 'left' ? -lines : 0
      return { args: { action: 'scroll', ...(coordinate ? { x: coordinate.x, y: coordinate.y } : {}), amount: vertical, ...(sideways ? { dx: sideways } : {}) } }
    }
    case 'type':
      if (typeof input.text !== 'string' || !input.text) return { error: 'type needs text.' }
      return { args: { action: 'type', text: input.text } }
    case 'key': {
      if (typeof input.text !== 'string' || !input.text.trim()) return { error: 'key needs text, e.g. "Return" or "super+s".' }
      const repeat = input.repeat === undefined ? 1 : Number(input.repeat)
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) return { error: 'repeat is a whole number from 1 to 100.' }
      // SahilBot presses a combination once per call: a repeat over 1 is answered, not half-done.
      if (repeat > 1) return { error: `Pressing a key several times in one call isn't available here: send key "${input.text}" once per call (${repeat} calls), or type the text.` }
      return { args: { action: 'key', keys: normalizeKey(input.text) } }
    }
    case 'wait': {
      const d = typeof input.duration === 'number' && Number.isFinite(input.duration) ? input.duration : 1
      return { args: { action: 'wait', seconds: Math.min(10, Math.max(0.2, d)) } }
    }
    default:
      return { error: `Unknown computer action "${member}".` }
  }
}
