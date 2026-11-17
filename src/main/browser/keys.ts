// Key presses in the built-in browser (CDP Input.dispatchKeyEvent): "Escape", "Tab", "ArrowDown",
// "shift+Tab", "cmd+a". Enter is left to type submit=true / the enter step, where a purchase can be checked.

export interface CdpKey { key: string; code: string; windowsVirtualKeyCode: number; text?: string }
export interface CdpPress { modifiers: number; keys: CdpKey[] }

const NAMED: Record<string, CdpKey> = {
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }
}
/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const MODS: Record<string, number> = { alt: 1, option: 1, opt: 1, ctrl: 2, control: 2, cmd: 4, command: 4, meta: 4, '⌘': 4, shift: 8 }

/** "shift+Tab" → modifiers and keys; several keys in a row as "ArrowDown ArrowDown Enter" are not allowed with Enter. */
export function parseKeys(input: string): CdpPress[] {
  const presses = input.trim().split(/\s+/).filter(Boolean)
  if (!presses.length) throw new Error('No key given. Examples: "Escape", "Tab", "ArrowDown", "shift+Tab", "cmd+a".')
  if (presses.length > 10) throw new Error('At most 10 key presses at a time.')
  return presses.map((p) => {
    const parts = p.split('+').filter(Boolean)
    let modifiers = 0
    for (const m of parts.slice(0, -1)) {
      const bit = MODS[m.toLowerCase()]
      if (!bit) throw new Error(`Unknown modifier "${m}" (use cmd, ctrl, alt or shift).`)
      modifiers |= bit
    }
    const k = parts.at(-1)!
    if (/^(enter|return)$/i.test(k)) throw new Error('To press Enter, use type with submit=true (it checks a purchase first).')
    const named = NAMED[k.toLowerCase()]
    if (named) return { modifiers, keys: [named] }
    if (/^f([1-9]|1[0-2])$/i.test(k)) { const n = Number(k.slice(1)); return { modifiers, keys: [{ key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n }] } }
    if (k.length === 1) {
      const up = k.toUpperCase()
      const code = /[a-z]/i.test(k) ? `Key${up}` : /\d/.test(k) ? `Digit${k}` : ''
      // A shortcut (cmd/ctrl/alt) types nothing; a plain or shifted key types its character.
      const types = (modifiers & 7) === 0
      return { modifiers, keys: [{ key: k, code, windowsVirtualKeyCode: up.charCodeAt(0), ...(types ? { text: modifiers & 8 ? up : k } : {}) }] }
    }
    throw new Error(`Unknown key "${k}". Examples: Escape, Tab, ArrowDown, PageDown, shift+Tab, cmd+a.`)
  })
}
