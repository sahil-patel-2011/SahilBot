import { describe, expect, test } from 'vitest'
import { buildSnapshot, byRef, describeChange, elementAt, formatSnapshot, guardAction, isSecure, redactClipboard, relocate, type RawSnapshot, type UiState } from '../../src/main/computer/ax'
import { clipToDisplays, describeDisplays, displayAt, displayByNumber, fitImage, imageLimits, makeFrame, toImage, toScreen, type DisplayInfo } from '../../src/main/computer/geometry'
import { parseCombo, riskyCombo } from '../../src/main/computer/keys'
import { MATCH_JS } from '../../src/main/computer/scripts'
import { waitForSettle } from '../../src/main/computer/settle'
import { clickFlags, computerTool, typingChunks } from '../../src/main/agent/tools/computer'

// Pure parts of computer use only: nothing here moves the mouse, types, or runs osascript.

const displays: DisplayInfo[] = [
  { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: false },
  { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, primary: true },
  { id: 3, bounds: { x: 1512, y: -200, width: 2560, height: 1440 }, scaleFactor: 2, primary: false }
]

describe('geometry: Retina and several displays', () => {
  test('full-display screenshots are one pixel per point, shrunk to the model limit', () => {
    expect(fitImage(displays[1].bounds, 2, { maxEdge: 1568 })).toEqual({ width: 1512, height: 982 })
    expect(fitImage(displays[2].bounds, 2, { maxEdge: 1568 })).toEqual({ width: 1568, height: 882 })
    expect(fitImage(displays[2].bounds, 2, imageLimits('claude-opus-5-5'))).toEqual({ width: 1920, height: 1080 })
  })
  test('window and region shots zoom to Retina pixels (never past the limit)', () => {
    expect(fitImage({ x: 0, y: 0, width: 400, height: 300 }, 2, { maxEdge: 1568, zoom: true })).toEqual({ width: 800, height: 600 })
    expect(fitImage({ x: 0, y: 0, width: 1000, height: 500 }, 2, { maxEdge: 1568, zoom: true })).toEqual({ width: 1568, height: 784 })
  })
  test('image limits per model', () => {
    expect(imageLimits('claude-opus-4-7').maxEdge).toBe(1920)
    expect(imageLimits('claude-sonnet-5').maxEdge).toBe(1920)
    expect(imageLimits('claude-sonnet-5-5').maxEdge).toBe(1568)
    expect(imageLimits('claude-opus-4-6').maxEdge).toBe(1568)
    expect(imageLimits('qwen3.5:9b').maxEdge).toBe(1568)
  })
  test('screenshot pixels map back to screen points, on any display', () => {
    const f = makeFrame(displays[2].bounds, 1568, 882, 'display 3')
    const p = toScreen(f, 784, 441)
    expect(p.x).toBeCloseTo(1512 + 1280)
    expect(p.y).toBeCloseTo(-200 + 720)
    expect(toImage(f, p.x, p.y)).toEqual({ x: 784, y: 441 })
    expect(toImage(f, -5, 0)).toBeUndefined()
    const left = makeFrame(displays[0].bounds, 1568, 882, 'display 2')
    expect(toScreen(left, 0, 0)).toEqual({ x: -1920, y: 0 })
  })
  test('which display, ordering, clipping', () => {
    expect(displayAt(displays, -10, 10)?.id).toBe(2)
    expect(displayAt(displays, 100, 100)?.id).toBe(1)
    expect(displayAt(displays, 1600, -100)?.id).toBe(3)
    expect(displayAt(displays, 100, 2000)).toBeUndefined()
    expect(displayByNumber(displays, 1)?.id).toBe(1)
    expect(displayByNumber(displays, 2)?.id).toBe(2)
    expect(displayByNumber(displays, 3)?.id).toBe(3)
    expect(clipToDisplays({ x: 1400, y: 900, width: 300, height: 300 }, displays)).toEqual({ x: 1512, y: 900, width: 188, height: 300 })
    expect(clipToDisplays({ x: 5000, y: 5000, width: 10, height: 10 }, displays)).toBeUndefined()
    expect(describeDisplays(displays)).toMatch(/^1 \(main\) 1512×982 pt @2x; 2 1920×1080 pt @1x at \(-1920, 0\)/)
  })
})

describe('keyboard shortcuts', () => {
  test('modifiers are normalized and ordered', () => {
    expect(parseCombo('cmd+shift+T')).toEqual({ char: 't', using: ['shift down', 'command down'], label: 'shift+cmd+t' })
    expect(parseCombo('⌘⇧T')).toEqual(parseCombo('cmd+shift+t'))
    expect(parseCombo('Command-Shift-T')).toEqual(parseCombo('cmd+shift+t'))
    expect(parseCombo('ctrl+option+left')).toEqual({ code: 123, using: ['control down', 'option down'], label: 'ctrl+option+left' })
    expect(parseCombo('return')).toEqual({ code: 36, using: [], label: 'return' })
    expect(parseCombo('cmd+plus').char).toBe('+')
    expect(parseCombo('cmd++').char).toBe('+')
    expect(parseCombo('cmd+,').char).toBe(',')
    expect(parseCombo('F5').code).toBe(96)
    expect(() => parseCombo('hyper+k')).toThrow(/Unknown modifier/)
    expect(() => parseCombo('cmd+banana')).toThrow(/Unknown key/)
  })
  test('risky shortcuts always ask', () => {
    expect(riskyCombo(parseCombo('cmd+q'))).toMatch(/quitting/)
    expect(riskyCombo(parseCombo('cmd+option+escape'))).toMatch(/Force Quit/)
    expect(riskyCombo(parseCombo('cmd+shift+delete'))).toMatch(/Trash/)
    expect(riskyCombo(parseCombo('cmd+s'))).toBeNull()
    expect(riskyCombo(parseCombo('cmd+shift+q'))).toMatch(/log/)
  })
  test('click modifiers and typing chunks', () => {
    expect(clickFlags('cmd+shift')).toBe(0x100000 | 0x20000)
    expect(clickFlags()).toBe(0)
    expect(() => clickFlags('hyper')).toThrow()
    const chunks = typingChunks('a'.repeat(59) + '😀b', 60)
    expect(chunks).toEqual(['a'.repeat(59) + '😀', 'b'])
  })
})

// A Notes-like window: a toolbar button, a search field, a password field, a checkbox, static text.
const raw = (extra: RawSnapshot['nodes'] = [], windows?: RawSnapshot['windows']): RawSnapshot => ({
  app: 'Notes', pid: 42,
  windows: windows ?? [{ index: 0, title: 'Shopping', x: 0, y: 25, w: 800, h: 600, focused: true }],
  nodes: [
    ...extra,
    { path: [0, 0], depth: 0, win: 0, role: 'AXToolbar', x: 0, y: 25, w: 800, h: 50 },
    { path: [0, 0, 0], depth: 1, win: 0, role: 'AXButton', name: 'New Note', x: 10, y: 30, w: 30, h: 30, enabled: true },
    { path: [0, 0, 1], depth: 1, win: 0, role: 'AXTextField', subrole: 'AXSearchField', desc: 'Search', value: 'milk', x: 600, y: 30, w: 180, h: 24, focused: true },
    { path: [0, 1], depth: 0, win: 0, role: 'AXTextField', subrole: 'AXSecureTextField', name: 'Password', x: 100, y: 200, w: 200, h: 24 },
    { path: [0, 2], depth: 0, win: 0, role: 'AXTextField', name: 'Account PIN', value: '1234', x: 100, y: 240, w: 200, h: 24 },
    { path: [0, 3], depth: 0, win: 0, role: 'AXCheckBox', name: 'Pinned', value: '0', x: 100, y: 280, w: 20, h: 20 },
    { path: [0, 4], depth: 0, win: 0, role: 'AXStaticText', value: 'Buy milk', x: 100, y: 320, w: 100, h: 20 },
    { path: [0, 5], depth: 0, win: 0, role: 'AXGroup', x: 0, y: 0, w: 800, h: 600 },
    { path: [0, 6], depth: 0, win: 0, role: 'AXButton', name: 'Hidden', x: 0, y: 0, w: 0, h: 0 },
    { path: [0, 7], depth: 0, win: 0, role: 'AXButton', name: 'Disabled', enabled: false, x: 300, y: 300, w: 60, h: 20 }
  ]
})

describe('accessibility snapshot', () => {
  test('lists what you can act on, with refs, values and flags', () => {
    const s = buildSnapshot(raw(), undefined, 1)
    expect(s.elements.map((e) => `${e.ref} ${e.role} ${e.label}`)).toEqual([
      'e1 AXButton New Note', 'e2 AXTextField Search', 'e3 AXTextField Password', 'e4 AXTextField Account PIN', 'e5 AXCheckBox Pinned', 'e6 AXStaticText Buy milk', 'e7 AXButton Disabled'
    ])
    expect(byRef(s, 'e3')?.secure).toBe(true)
    // A field labeled like a secret is treated as one, and its value is never shown.
    expect(byRef(s, 'e4')).toMatchObject({ secure: true, value: undefined })
    expect(byRef(s, '[E2]')).toMatchObject({ editable: true, focused: true, value: 'milk' })
    expect(byRef(s, 'e1')?.pressable).toBe(true)
    const text = formatSnapshot(s)
    expect(text).toContain('App: Notes · 1 window')
    expect(text).toContain('Window 1 "Shopping" (focused):')
    expect(text).toContain('[e2] SearchField "Search" = "milk" (focused)')
    expect(text).toContain('[e3] SecureTextField "Password" (password: the user types it)')
    expect(text).toContain('[e7] Button "Disabled" (disabled)')
    expect(text).not.toContain('1234')
    expect(formatSnapshot(s, { query: 'pin' })).toContain('[e5] CheckBox "Pinned" = "0"')
    expect(formatSnapshot(s, { query: 'zzz' })).toContain('Nothing matching')
  })
  test('refs stay stable when the UI changes', () => {
    const first = buildSnapshot(raw(), undefined, 1)
    const added = raw([{ path: [0, 9], depth: 0, win: 0, role: 'AXButton', name: 'Share', x: 50, y: 30, w: 30, h: 30 }])
    const second = buildSnapshot(added, first, 2)
    expect(byRef(second, 'e1')?.label).toBe('New Note')
    expect(byRef(second, 'e5')?.label).toBe('Pinned')
    expect(second.elements.find((e) => e.label === 'Share')?.ref).toBe('e8')
    // Another app: numbering starts over.
    expect(buildSnapshot({ ...raw(), app: 'Mail' }, second).elements[0].ref).toBe('e1')
  })
  test('finding an element again after its path moved', () => {
    const before = buildSnapshot(raw(), undefined, 1)
    // Another window came to the front: the Shopping window is now index 1.
    const shifted: RawSnapshot = { ...raw(), windows: [{ index: 0, title: 'Other' }, { index: 1, title: 'Shopping' }], nodes: raw().nodes.map((n) => ({ ...n, path: [1, ...n.path.slice(1)], win: 1 })) }
    const moved = buildSnapshot(shifted, undefined, 2)
    const again = relocate(byRef(before, 'e5')!, moved)
    expect(again?.path).toEqual([1, 3])
    expect(relocate({ ...byRef(before, 'e5')!, label: 'Gone' }, moved)).toBeUndefined()
  })
  test('a coordinate click hits the button, not the text inside it', () => {
    const s = buildSnapshot(raw([{ path: [0, 8], depth: 0, win: 0, role: 'AXStaticText', value: 'New', x: 15, y: 35, w: 10, h: 10 }]), undefined, 1)
    expect(elementAt(s, 20, 40)?.label).toBe('New Note')
    expect(elementAt(s, 150, 330)?.label).toBe('Buy milk')
    expect(elementAt(s, 5000, 5000)).toBeUndefined()
  })
  test('secure field detection', () => {
    expect(isSecure({ role: 'AXTextField', subrole: 'AXSecureTextField' })).toBe(true)
    expect(isSecure({ role: 'AXTextField', label: 'Verification code' })).toBe(true)
    expect(isSecure({ role: 'AXTextField', label: 'Email' })).toBe(false)
    expect(isSecure({ role: 'AXStaticText', label: 'Forgot password?' })).toBe(false)
  })
})

describe('verifying an action', () => {
  const base: UiState = { app: 'Notes', window: 'Shopping', windows: 1, sheets: 0, kids: 5, focused: { role: 'AXTextField', label: 'Search', value: 'milk', secure: false } }
  test('no change is reported as such', () => {
    const c = describeChange(base, { ...base })
    expect(c.changed).toBe(false)
    expect(c.text).toMatch(/No change detected/)
  })
  test('app, window, dialog, focus and value changes', () => {
    expect(describeChange(base, { ...base, app: 'Mail', window: 'Inbox' }).text).toMatch(/front app Notes → Mail; window "Shopping" → "Inbox"/)
    expect(describeChange(base, { ...base, sheets: 1 }).text).toMatch(/a dialog\/sheet opened/)
    expect(describeChange(base, { ...base, windows: 2 }).text).toMatch(/a window opened \(2 now\)/)
    expect(describeChange(base, { ...base, focused: { role: 'AXTextArea', label: 'Body', secure: false } }).text).toMatch(/focus TextField "Search" → TextArea "Body"/)
    expect(describeChange(base, { ...base, focused: { ...base.focused!, value: 'milk and eggs' } }).text).toMatch(/value "milk" → "milk and eggs"/)
    expect(describeChange({ ...base, target: { exists: true, value: '0' } }, { ...base, target: { exists: true, value: '1' } }).text).toMatch(/its value "0" → "1"/)
    expect(describeChange({ ...base, target: { exists: true } }, { ...base, target: { exists: false } }).text).toMatch(/target element is gone/)
    expect(describeChange(base, { ...base, kids: 7 }).text).toMatch(/contents changed/)
  })
  test('password values never show up', () => {
    const t = describeChange(base, { ...base, focused: { role: 'AXTextField', subrole: 'AXSecureTextField', label: 'Password', secure: true } }).text
    expect(t).toMatch(/password field/)
  })
  test('waits until two reads agree, or times out', async () => {
    let t = 0
    const seq = [1, 2, 3, 3, 3]
    let i = 0
    const r = await waitForSettle(async () => seq[Math.min(i++, seq.length - 1)], (a, b) => a === b, { timeoutMs: 5000, intervalMs: 100, sleep: async (ms) => { t += ms }, now: () => t })
    expect(r).toMatchObject({ state: 3, stable: true, reads: 4 })
    let n = 0
    const never = await waitForSettle(async () => n++, (a, b) => a === b, { timeoutMs: 500, intervalMs: 100, sleep: async (ms) => { t += ms }, now: () => t })
    expect(never.stable).toBe(false)
    const ctrl = new AbortController(); ctrl.abort()
    await expect(waitForSettle(async () => 1, () => true, { timeoutMs: 500, intervalMs: 10, signal: ctrl.signal, sleep: async () => undefined })).rejects.toThrow(/stopped/)
  })
})

describe('steps handed to the user', () => {
  const field = (label: string, o: Record<string, unknown> = {}) => ({ role: 'AXTextField', label, secure: false, ...o })
  test('passwords', () => {
    expect(guardAction({ action: 'type_ref', app: 'Mail', el: { ...field('Password'), secure: true }, typing: true })?.kind).toBe('password')
    expect(guardAction({ action: 'type', app: 'Mail', focused: { role: 'AXTextField', subrole: 'AXSecureTextField', label: '', secure: true }, typing: true })?.kind).toBe('password')
    expect(guardAction({ action: 'type', app: 'Mail', focused: { role: 'AXTextField', label: 'Subject', secure: false }, typing: true })).toBeNull()
  })
  test('system authentication prompts', () => {
    expect(guardAction({ action: 'click', app: 'SecurityAgent', el: { role: 'AXButton', label: 'OK', secure: false } })?.kind).toBe('authentication')
    expect(guardAction({ action: 'type', app: 'System Settings', window: 'System Settings wants to make changes', typing: true, focused: { role: 'AXTextField', label: 'User Name', secure: false } })?.kind).toBe('authentication')
  })
  test('payments and purchases in native apps', () => {
    expect(guardAction({ action: 'click', app: 'App Store', el: { role: 'AXButton', label: 'Get', secure: false } })?.kind).toBe('payment')
    expect(guardAction({ action: 'click', app: 'App Store', el: { role: 'AXButton', label: '$4.99', secure: false } })?.kind).toBe('payment')
    expect(guardAction({ action: 'click', app: 'App Store', el: { role: 'AXButton', label: 'Open', secure: false } })).toBeNull()
    expect(guardAction({ action: 'click', app: 'Music', el: { role: 'AXButton', label: 'Subscribe', secure: false } })?.kind).toBe('payment')
    expect(guardAction({ action: 'click', app: 'Safari', window: 'Pay with Apple Pay', el: { role: 'AXButton', label: 'Continue', secure: false } })?.kind).toBe('payment')
    expect(guardAction({ action: 'key', app: 'PassbookUIService', typing: false })?.kind).toBe('payment')
    // A reminder titled "Buy milk" is text, not a purchase button.
    expect(guardAction({ action: 'click', app: 'Reminders', el: { role: 'AXStaticText', label: 'Buy milk', secure: false } })).toBeNull()
    expect(guardAction({ action: 'click', app: 'Notes', el: { role: 'AXButton', label: 'New Note', secure: false } })).toBeNull()
  })
  test('clipboard secrets are blanked', () => {
    expect(redactClipboard('key sk-ant-api03-abcdefghijklmnop rest').text).toBe('key [hidden: looks like a secret] rest')
    expect(redactClipboard('card 4111 1111 1111 1111').redacted).toBe(true)
    expect(redactClipboard('hello world 2026').redacted).toBe(false)
  })
})

describe('menu matching (runs inside the menu script)', () => {
  const match = new Function(`return (${MATCH_JS})`)() as (names: Array<string | null>, want: string) => number
  test('exact, ellipsis, case, prefix, contains', () => {
    const names = ['New Note', null, 'Export as PDF…', 'Print…', 'Close']
    expect(match(names, 'close')).toBe(4)
    expect(match(names, 'Export as PDF...')).toBe(2)
    expect(match(names, 'export')).toBe(2)
    expect(match(names, 'pdf')).toBe(2)
    expect(match(names, 'Print')).toBe(3)
    expect(match(names, 'Share')).toBe(-1)
    expect(match(names, '')).toBe(-1)
  })
})

describe('the computer tool', () => {
  const tool = computerTool({ enterMini: () => undefined, capture: async () => ({ dataUrl: '', width: 1, height: 1 }), trusted: () => false })
  test('reads are reads; quitting and risky keys always ask', () => {
    const eff = tool.effect as (a: never, c: { roots: string[] }) => string
    expect(eff({ action: 'ui' } as never, { roots: [] })).toBe('read')
    expect(eff({ action: 'clipboard_read' } as never, { roots: [] })).toBe('read')
    expect(eff({ action: 'clipboard_write', text: 'x' } as never, { roots: [] })).toBe('write_local')
    expect(eff({ action: 'click_ref', ref: 'e1' } as never, { roots: [] })).toBe('write_external')
    expect(tool.consequential!({ action: 'click', x: 1, y: 1 }, { threadId: 't' })).toBe(true)
    expect(tool.consequential!({ action: 'quit_app', app: 'Numbers' }, { threadId: 't' })).toBe(true)
    expect(tool.consequential!({ action: 'clipboard_write', text: 'x' }, { threadId: 't' })).toBe(false)
    expect(tool.hardStop!({ action: 'quit_app', app: 'Numbers' })).toMatch(/quitting Numbers/)
    expect(tool.hardStop!({ action: 'key', keys: 'cmd+q' })).toMatch(/quitting/)
    expect(tool.hardStop!({ action: 'menu', path: 'Finder > Empty Trash…' })).toMatch(/Empty Trash/)
    expect(tool.hardStop!({ action: 'menu', path: 'File > Save' })).toBeNull()
    expect(tool.hardStop!({ action: 'key', keys: 'cmd+s' })).toBeNull()
  })
  test('without Accessibility permission nothing is driven', async () => {
    const ctx = { threadId: 't', signal: new AbortController().signal, state: {} } as never
    await expect(tool.run({ action: 'click', x: 1, y: 1 }, ctx)).rejects.toThrow(/Accessibility permission/)
    await expect(tool.run({ action: 'ui' }, ctx)).rejects.toThrow(/Accessibility permission/)
  })
  test('the schema keeps Claude-compatible shape', () => {
    expect((tool.parameters as { properties: Record<string, unknown> }).properties.action).toBeTruthy()
    expect(tool.description).toMatch(/click_ref/)
  })
})
