// Keyboard shortcuts for computer use: "cmd+shift+t", "ctrl+option+left", "cmd+plus", "return".
// Named keys are sent by key code (layout-independent); characters by keystroke (so "cmd+z" means Z on
// any layout). Modifiers are normalized so "Command+Shift+T" and "⌘⇧T" mean the same thing.

export type Modifier = 'command down' | 'shift down' | 'option down' | 'control down' | 'function down'

export interface KeyCombo {
  /** Key code for a named key, or the character to type. */
  code?: number
  char?: string
  using: Modifier[]
  /** Canonical text, e.g. "cmd+shift+t". */
  label: string
}

export const KEYCODES: Record<string, number> = {
  return: 36, enter: 76, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, pageup: 116, pagedown: 121, home: 115, end: 119, forwarddelete: 117, del: 117,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  capslock: 57, help: 114
}

const MODS: Record<string, Modifier> = {
  cmd: 'command down', command: 'command down', meta: 'command down', super: 'command down', win: 'command down', '⌘': 'command down',
  shift: 'shift down', '⇧': 'shift down',
  alt: 'option down', option: 'option down', opt: 'option down', '⌥': 'option down',
  ctrl: 'control down', control: 'control down', '⌃': 'control down', '^': 'control down',
  fn: 'function down'
}
const SHORT: Record<Modifier, string> = { 'command down': 'cmd', 'shift down': 'shift', 'option down': 'option', 'control down': 'ctrl', 'function down': 'fn' }
const ORDER: Modifier[] = ['control down', 'option down', 'shift down', 'command down', 'function down']

/** Words for characters that can't be written inside a "+"-separated combo. */
const CHAR_NAMES: Record<string, string> = { plus: '+', minus: '-', equal: '=', equals: '=', comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\', semicolon: ';', quote: "'", backquote: '`', grave: '`', bracketleft: '[', bracketright: ']' }
/** Aliases for named keys. */
const KEY_ALIASES: Record<string, string> = { arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down', ret: 'return', '↩': 'return', '⏎': 'return', '⌫': 'delete', '⎋': 'escape', '⇥': 'tab', pgup: 'pageup', pgdn: 'pagedown', 'page up': 'pageup', 'page down': 'pagedown' }

/**
 * Parses a shortcut. Accepts "+", "-" (between words) or spaces as separators and the ⌘⇧⌥⌃ symbols.
 * A single capital letter means the letter, not shift (shortcut menus show "⌘T"); write shift
 * explicitly. Throws on an unknown modifier or an empty key.
 */
export function parseCombo(input: string): KeyCombo {
  let s = input.trim()
  if (!s) throw new Error('No key given.')
  // Glued symbols: "⌘⇧T" → "⌘+⇧+T".
  s = s.replace(/([⌘⇧⌥⌃])(?=\S)/g, '$1+')
  // "cmd++" → the key is "+".
  let parts: string[]
  if (/\+\+$/.test(s)) parts = [...s.slice(0, -2).split('+'), '+']
  else if (s === '+') parts = ['+']
  else parts = s.split(/\s*\+\s*|(?<=\b(?:cmd|command|shift|alt|option|opt|ctrl|control|fn))[-\s]+/i)
  parts = parts.map((p) => p.trim()).filter((p) => p.length)
  const keyRaw = parts.pop()
  if (!keyRaw) throw new Error(`No key in "${input}".`)
  const using: Modifier[] = []
  for (const p of parts) {
    const m = MODS[p.toLowerCase()]
    if (!m) throw new Error(`Unknown modifier "${p}" in "${input}". Use cmd, shift, option, ctrl or fn.`)
    if (!using.includes(m)) using.push(m)
  }
  using.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
  const lower = keyRaw.toLowerCase()
  const name = KEY_ALIASES[lower] ?? lower
  const mods = using.map((m) => SHORT[m])
  if (KEYCODES[name] !== undefined) return { code: KEYCODES[name], using, label: [...mods, name].join('+') }
  const char = CHAR_NAMES[name] ?? (keyRaw.length === 1 ? keyRaw : undefined)
  if (char === undefined) throw new Error(`Unknown key "${keyRaw}". Use a single character or a key name like return, tab, escape, left, f5.`)
  // Letters as lowercase: keystroke "T" would add shift on its own.
  const c = /^[A-Z]$/.test(char) ? char.toLowerCase() : char
  return { char: c, using, label: [...mods, c].join('+') }
}

/**
 * Shortcuts that do something big to the Mac or lose work: they always ask first, even mid-task.
 * Returns why, or null.
 */
export function riskyCombo(k: KeyCombo): string | null {
  const has = (m: Modifier): boolean => k.using.includes(m)
  const only = (...ms: Modifier[]): boolean => k.using.length === ms.length && ms.every(has)
  if (k.char === 'q' && only('command down')) return 'quitting the app in front (unsaved work may be lost)'
  if (k.char === 'q' && has('command down') && has('control down')) return 'locking the screen'
  if (k.char === 'q' && has('command down') && has('shift down')) return 'logging out of macOS'
  if (k.code === KEYCODES.escape && has('command down') && has('option down')) return 'opening Force Quit'
  if (k.code === KEYCODES.delete && has('command down') && has('shift down')) return 'emptying the Trash'
  if (k.code === KEYCODES.delete && only('command down')) return 'moving the selection to the Trash (in Finder) or deleting it'
  if (k.char === 'w' && has('command down') && has('option down')) return 'closing every window of the app in front'
  return null
}
