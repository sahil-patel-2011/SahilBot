import { Script } from 'node:vm'
import { describe, expect, test } from 'vitest'
import { settingsStop } from '../../src/main/computer/ax'
import { chooseInputMethod, CLIP, describeRestore, textLanded, withTemporaryClipboard, type ClipboardIO, type ClipboardRead, type SavedClipboard } from '../../src/main/computer/clipboard'
import type { Overlay, OverlayAction } from '../../src/main/computer/overlay'
import { KEY, MOUSE, STATE, TYPE, VALUE, wrap } from '../../src/main/computer/scripts'
import { computerTool } from '../../src/main/agent/tools/computer'

// Pure parts of text entry and the cursor: a fake clipboard and a fake osascript. Nothing here touches
// the real clipboard, mouse or keyboard.

/** An in-memory pasteboard with a change count, like NSPasteboard. */
function fakeClipboard(start: { text?: string; concealed?: boolean } = { text: 'user clip' }) {
  const s = { text: start.text as string | undefined, concealed: !!start.concealed, count: 7 }
  const saves = new Map<SavedClipboard, { text?: string; concealed: boolean }>()
  const io: ClipboardIO & { state: typeof s; userCopies(t: string): void; failWrite?: boolean } = {
    state: s,
    userCopies(t) { s.text = t; s.concealed = false; s.count++ },
    async save() { const saved: SavedClipboard = { changeCount: s.count, items: s.text === undefined ? 0 : 1, bytes: s.text?.length ?? 0, concealed: s.concealed || undefined }; saves.set(saved, { text: s.concealed ? undefined : s.text, concealed: s.concealed }); return saved },
    async writeText(t) { if (io.failWrite) throw new Error('pasteboard busy'); s.text = t; s.concealed = false; return ++s.count },
    async changeCount() { return s.count },
    async restore(saved) { const v = saves.get(saved)!; s.text = v.concealed ? undefined : v.text; s.concealed = false; s.count++ },
    async read(): Promise<ClipboardRead> { return { text: s.concealed ? undefined : s.text, changeCount: s.count, concealed: s.concealed, types: s.text ? ['public.utf8-plain-text'] : [] } },
    discard(saved) { saves.delete(saved) }
  }
  return io
}

describe('putting the user\'s clipboard back after a paste', () => {
  test('restored after the paste', async () => {
    const c = fakeClipboard()
    let during = ''
    const r = await withTemporaryClipboard(c, 'héllo 👋', async () => { during = c.state.text!; return 'yes' })
    expect(during).toBe('héllo 👋')
    expect(r).toEqual({ result: 'yes', restore: 'restored', error: undefined })
    expect(c.state.text).toBe('user clip')
    expect(describeRestore(r.restore)).toMatch(/put back/)
  })
  test('restored even when the paste fails, and the error still surfaces', async () => {
    const c = fakeClipboard()
    await expect(withTemporaryClipboard(c, 'x', async () => { throw new Error('app crashed') })).rejects.toThrow('app crashed')
    expect(c.state.text).toBe('user clip')
  })
  test('a new copy by the user meanwhile is kept, not overwritten', async () => {
    const c = fakeClipboard()
    const r = await withTemporaryClipboard(c, 'ours', async () => { c.userCopies('their new copy'); return 1 })
    expect(r.restore).toBe('kept-new-copy')
    expect(c.state.text).toBe('their new copy')
  })
  test('a password manager\'s concealed item is never kept: the clipboard ends empty', async () => {
    const c = fakeClipboard({ text: 'hunter2', concealed: true })
    const r = await withTemporaryClipboard(c, 'ours', async () => 1)
    expect(r.restore).toBe('cleared-concealed')
    expect(c.state.text).toBeUndefined()
  })
  test('a failed write leaves the clipboard untouched', async () => {
    const c = fakeClipboard()
    c.failWrite = true
    await expect(withTemporaryClipboard(c, 'ours', async () => 1)).rejects.toThrow('pasteboard busy')
    expect(c.state.text).toBe('user clip')
    expect(c.state.count).toBe(7)
  })
  test('the pasteboard script compiles (checked with node, never run)', () => {
    expect(() => new Script(wrap(CLIP))).not.toThrow()
    expect(() => new Script(wrap(VALUE))).not.toThrow()
    expect(() => new Script(wrap(STATE))).not.toThrow()
    // Clipboard managers are told to skip SahilBot's temporary text.
    expect(CLIP).toContain('org.nspasteboard.TransientType')
    expect(CLIP).toContain('org.nspasteboard.ConcealedType')
  })
})

describe('typing or pasting', () => {
  test('short plain ASCII is typed; long, multi-line or non-ASCII text is pasted', () => {
    expect(chooseInputMethod('hello world').method).toBe('type')
    expect(chooseInputMethod('a'.repeat(40)).method).toBe('type')
    expect(chooseInputMethod('a'.repeat(41)).method).toBe('paste')
    expect(chooseInputMethod('line one\nline two').method).toBe('paste')
    expect(chooseInputMethod('tab\there').method).toBe('paste')
    expect(chooseInputMethod('café').method).toBe('paste')
    expect(chooseInputMethod('👍').method).toBe('paste')
    expect(chooseInputMethod('你好').method).toBe('paste')
    expect(chooseInputMethod('“quoted”').method).toBe('paste')
    expect(chooseInputMethod('你好', 'type').method).toBe('type')
    expect(chooseInputMethod('hi', 'paste').method).toBe('paste')
  })
  test('did the text land?', () => {
    expect(textLanded(undefined, undefined, 'x')).toBe('unknown')
    expect(textLanded('', 'Dear Ann,\r\nthanks', 'Dear Ann,\nthanks')).toBe('yes')
    expect(textLanded('', 'line one line two', 'line one\nline two')).toBe('yes')
    expect(textLanded('', 'something else', 'hello')).toBe('no')
    expect(textLanded('hello', 'hello', 'hello')).toBe('no')
    expect(textLanded('', '(555) 123-4567', '5551234567')).toBe('yes')
    expect(textLanded('', 'emoji 👋 ok', '👋')).toBe('yes')
  })
})

describe('System Settings hard stops', () => {
  test('security and privacy panes always ask; others don\'t', () => {
    expect(settingsStop('System Settings', 'Privacy & Security')).toMatch(/security or privacy/)
    expect(settingsStop('System Settings', 'Screen Recording')).toMatch(/security or privacy/)
    expect(settingsStop('System Settings', 'Displays', 'FileVault')).toMatch(/FileVault/)
    expect(settingsStop('System Settings', 'Displays', 'Brightness')).toBeNull()
    expect(settingsStop('Notes', 'Privacy & Security')).toBeNull()
  })
})

// ------------------------------------------------------------------ the cursor goes first

type Ev = string

function rig(o: { focused?: { role: string; label: string; secure?: boolean }; app?: string; window?: string } = {}) {
  const events: Ev[] = []
  const field = { value: '' }
  const clip = fakeClipboard()
  let selected = false
  const focused = o.focused ?? { role: 'AXTextArea', label: 'Body' }
  const overlay: Overlay & { hidden: number } = {
    hidden: 0,
    async show(a: OverlayAction) { events.push(`show:${a.kind}`); if (a.kind === 'type') shown.push(a) },
    hide() { overlay.hidden++; events.push('hide') }
  }
  const shown: Array<Extract<OverlayAction, { kind: 'type' }>> = []
  const osa = async (fn: string, input: any): Promise<unknown> => {
    if (fn === STATE) return { app: o.app ?? 'TextEdit', window: o.window ?? 'Untitled', windows: 1, sheets: 0, focused: { ...focused, secure: !!focused.secure, value: focused.secure ? undefined : field.value.slice(0, 200), x: 100, y: 100, w: 400, h: 300 } }
    if (fn === VALUE) return focused.secure ? { role: focused.role, secure: true } : { role: focused.role, secure: false, value: field.value, x: 100, y: 100, w: 400, h: 300 }
    if (fn === MOUSE) { events.push(`osa:mouse:${input.kind}`); return true }
    if (fn === TYPE) { events.push('osa:type'); field.value += input.text; return true }
    if (fn === KEY) {
      events.push(`osa:key:${input.char ?? input.code}`)
      const cmd = (input.using ?? []).includes('command down')
      if (cmd && input.char === 'v') { field.value = selected ? clip.state.text ?? '' : field.value + (clip.state.text ?? ''); selected = false }
      if (cmd && input.char === 'a') selected = true
      if (cmd && input.char === 'c') clip.userCopies(field.value)
      if (input.code === 51 && selected) { field.value = ''; selected = false }
      return true
    }
    return true
  }
  const tool = computerTool({ enterMini: () => undefined, capture: async () => ({ dataUrl: '', width: 1, height: 1 }), trusted: () => true, displays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, primary: true }], overlay, osa, clipboard: clip })
  const ctrl = new AbortController()
  const asked: string[] = []
  const ctx = { threadId: 't1', signal: ctrl.signal, state: {}, askUser: async (q: string) => { asked.push(q); return 'Done' } } as never
  return { tool, ctx, ctrl, events, field, clip, overlay, asked, shown }
}

/** Every real input event comes right after the cursor showed it. */
function everyEventShownFirst(events: Ev[]): void {
  events.forEach((e, i) => { if (e.startsWith('osa:')) expect(events[i - 1], `${e} at ${i} in ${events.join(' ')}`).toMatch(/^show:(click|move|drag|scroll|type|key|focus)$/) })
}

describe('the visible cursor is shown before every real action', () => {
  test('click, move, drag, scroll and keys', async () => {
    const r = rig()
    await r.tool.run({ action: 'click', x: 200, y: 200, coords: 'screen' }, r.ctx)
    await r.tool.run({ action: 'move', x: 300, y: 300, coords: 'screen' }, r.ctx)
    await r.tool.run({ action: 'drag', x: 10, y: 10, x2: 400, y2: 400, coords: 'screen' }, r.ctx)
    await r.tool.run({ action: 'scroll', x: 500, y: 500, amount: -3, coords: 'screen' }, r.ctx)
    await r.tool.run({ action: 'key', keys: 'cmd+s' }, r.ctx)
    expect(r.events.filter((e) => e.startsWith('osa:'))).toEqual(['osa:mouse:click', 'osa:mouse:move', 'osa:mouse:drag', 'osa:mouse:scroll', 'osa:key:s'])
    expect(r.events.filter((e) => e === 'show:status')).toHaveLength(5)
    everyEventShownFirst(r.events)
  }, 20_000)

  test('short text is typed; long unicode text is pasted and the clipboard put back', async () => {
    const r = rig()
    const typed = await r.tool.run({ action: 'type', text: 'hello' }, r.ctx)
    expect(typed.text).toMatch(/^Typed 5 characters \(short plain text\)/)
    expect(typed.text).toContain('The field shows the text.')
    const long = 'Grüße aus Zürich 👋 — 你好，世界。\nSecond line.'
    const pasted = await r.tool.run({ action: 'type', text: long }, r.ctx)
    expect(pasted.text).toMatch(/^Pasted/)
    expect(pasted.text).toContain('The field shows the text.')
    expect(pasted.text).toContain('clipboard was put back')
    expect(r.field.value).toBe(`hello${long}`)
    expect(r.clip.state.text).toBe('user clip')
    expect(r.events.filter((e) => e.startsWith('osa:'))).toEqual(['osa:type', 'osa:key:v'])
    everyEventShownFirst(r.events)
    // The typing bubble shows the (non-secret) text with the field's position.
    expect(r.shown[0]).toMatchObject({ kind: 'type', text: 'hello', x: 300, y: 250, secure: false })
  }, 20_000)

  test('paste_text, select_all and copy', async () => {
    const r = rig()
    const p = await r.tool.run({ action: 'paste_text', text: 'abc' }, r.ctx)
    expect(p.text).toMatch(/^Pasted 3 characters \(asked to paste\)/)
    expect(r.field.value).toBe('abc')
    expect(r.clip.state.text).toBe('user clip')
    await r.tool.run({ action: 'select_all' }, r.ctx)
    const c = await r.tool.run({ action: 'copy', restore: true }, r.ctx)
    expect(c.text).toMatch(/^Copied 3 characters:\nabc/)
    expect(c.text).toMatch(/clipboard was put back/)
    expect(r.clip.state.text).toBe('user clip')
    expect(r.events.filter((e) => e.startsWith('osa:'))).toEqual(['osa:key:v', 'osa:key:a', 'osa:key:c'])
    everyEventShownFirst(r.events)
  }, 20_000)

  test('copied secrets are hidden from the model', async () => {
    const r = rig()
    r.field.value = 'key sk-ant-abcdefghijklmnop123'
    const c = await r.tool.run({ action: 'copy' }, r.ctx)
    expect(c.text).not.toContain('sk-ant-abcdefghijklmnop123')
    expect(c.text).toContain('hidden')
  }, 20_000)

  test('nothing is typed into a password field; the cursor never shows its text', async () => {
    const r = rig({ focused: { role: 'AXTextField', label: 'Password', secure: true } })
    const out = await r.tool.run({ action: 'type', text: 'hunter2' }, r.ctx)
    expect(out.display).toMatch(/handed to you/)
    expect(r.asked[0]).toMatch(/never type passwords/)
    expect(r.events.some((e) => e.startsWith('osa:'))).toBe(false)
    expect(r.field.value).toBe('')
  }, 20_000)

  test('Stop hides the cursor', async () => {
    const r = rig()
    await r.tool.run({ action: 'click', x: 200, y: 200, coords: 'screen' }, r.ctx)
    r.ctrl.abort()
    await new Promise((ok) => setTimeout(ok, 20))
    expect(r.events).toContain('show:done')
    expect(r.overlay.hidden).toBe(1)
  }, 20_000)

  test('after reading a System Settings privacy pane, clicks there are hard stops', async () => {
    const r = rig({ app: 'System Settings', window: 'Privacy & Security' })
    await r.tool.run({ action: 'move', x: 10, y: 10, coords: 'screen' }, r.ctx)
    expect(r.tool.hardStop!({ action: 'click', x: 10, y: 10 })).toMatch(/security or privacy setting/)
    expect(r.tool.hardStop!({ action: 'scroll', amount: -3 })).toBeNull()
    expect(r.tool.hardStop!({ action: 'screenshot' })).toBeNull()
  }, 20_000)
})
