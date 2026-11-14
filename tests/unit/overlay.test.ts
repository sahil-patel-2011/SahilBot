import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DisplayInfo } from '../../src/main/computer/geometry'
import {
  CLICK_MS, MOVE_MAX_MS, MOVE_MIN_MS, OverlayController, STOP_HINT, defaultLabel, displayFor, keyGlyphs, looksSecret, moveDuration,
  pageCursorCss, pillLabel, pillRect, scrubLabel, supersedes, tailDuration, toLocal, truncate, typingChip,
  type OverlayFrame, type OverlayHost, type Point
} from '../../src/main/computer/overlay'

// Pure parts of the SahilBot cursor overlay: no windows, no real mouse or keyboard.

const displays: DisplayInfo[] = [
  { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: false },
  { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, primary: true },
  { id: 3, bounds: { x: 1512, y: -200, width: 2560, height: 1440 }, scaleFactor: 2, primary: false }
]

class FakeHost implements OverlayHost {
  frames: OverlayFrame[] = []
  hides = 0
  reduce = false
  mouse: Point | undefined = { x: 100, y: 100 }
  ds = displays
  render(f: OverlayFrame): void { this.frames.push(f) }
  hide(): void { this.hides++ }
  cursor(): Point | undefined { return this.mouse }
  displays(): DisplayInfo[] { return this.ds }
  reduceMotion(): boolean { return this.reduce }
}

describe('animation timing', () => {
  test('glides take 180–350 ms, longer for longer distances', () => {
    const o = { x: 0, y: 0 }
    const short = moveDuration(o, { x: 30, y: 0 }, false)
    const mid = moveDuration(o, { x: 400, y: 300 }, false)
    const far = moveDuration(o, { x: 4000, y: 2000 }, false)
    expect(short).toBeGreaterThanOrEqual(MOVE_MIN_MS)
    expect(mid).toBeGreaterThan(short)
    expect(far).toBe(MOVE_MAX_MS)
    for (const d of [3, 10, 100, 500, 1000, 3000]) {
      const ms = moveDuration(o, { x: d, y: 0 }, false)
      expect(ms).toBeGreaterThanOrEqual(MOVE_MIN_MS)
      expect(ms).toBeLessThanOrEqual(MOVE_MAX_MS)
    }
  })
  test('no distance, no start point or Reduce Motion: jump (0 ms)', () => {
    expect(moveDuration({ x: 5, y: 5 }, { x: 5.5, y: 5 }, false)).toBe(0)
    expect(moveDuration(undefined, { x: 500, y: 5 }, false)).toBe(0)
    expect(moveDuration({ x: 0, y: 0 }, { x: 900, y: 500 }, true)).toBe(0)
    expect(moveDuration({ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, false)).toBe(0)
  })
  test('effects after arriving: click ripple 250 ms (more for double/triple), shorter with Reduce Motion', () => {
    expect(tailDuration({ kind: 'click', x: 1, y: 1 }, false)).toBe(CLICK_MS)
    expect(tailDuration({ kind: 'click', x: 1, y: 1, count: 2 }, false)).toBeGreaterThan(CLICK_MS)
    expect(tailDuration({ kind: 'click', x: 1, y: 1 }, true)).toBeLessThan(CLICK_MS)
    expect(tailDuration({ kind: 'drag', x: 0, y: 0, x2: 2000, y2: 0 }, false)).toBeLessThanOrEqual(650)
    expect(tailDuration({ kind: 'drag', x: 0, y: 0, x2: 2000, y2: 0 }, true)).toBe(0)
  })
})

describe('display mapping', () => {
  test('a point maps to its display and that window\'s own coordinates (negative offsets too)', () => {
    expect(displayFor(displays, { x: -100, y: 50 })?.id).toBe(2)
    expect(toLocal(displayFor(displays, { x: -100, y: 50 })!, { x: -100, y: 50 })).toEqual({ x: 1820, y: 50 })
    expect(displayFor(displays, { x: 700, y: 400 })?.id).toBe(1)
    expect(toLocal(displays[2], { x: 1600, y: -150 })).toEqual({ x: 88, y: 50 })
  })
  test('a point in a gap or off every screen goes to the nearest display', () => {
    expect(displayFor(displays, { x: 700, y: 1200 })?.id).toBe(1)
    expect(displayFor(displays, { x: 9000, y: 0 })?.id).toBe(3)
    expect(displayFor([], { x: 0, y: 0 })).toBeUndefined()
  })
  test('the pill sits bottom-center, and moves to the top when the step acts near it', () => {
    const main = displays[1]
    const p = pillRect(main)
    expect(p.edge).toBe('bottom')
    expect(p.rect.x + p.rect.width / 2).toBeCloseTo(main.bounds.width / 2, 0)
    expect(p.rect.y + p.rect.height).toBeLessThan(main.bounds.height - 60)
    const near = { x: main.bounds.width / 2, y: p.rect.y + 10 }
    const moved = pillRect(main, [near])
    expect(moved.edge).toBe('top')
    expect(moved.rect.y).toBeGreaterThanOrEqual(main.bounds.y + 30)
    // On a display with a negative origin it stays inside that display.
    const left = pillRect(displays[2])
    expect(left.rect.y).toBeGreaterThan(-200)
    expect(left.rect.x).toBeGreaterThan(1512)
  })
})

describe('labels and secret masking', () => {
  test('labels are one short line without control characters, never splitting an emoji', () => {
    expect(truncate('Clicking\nSave\u0007 in   Numbers')).toBe('Clicking Save in Numbers')
    const long = truncate('Clicking the very long button label that goes on and on and on forever in Numbers', 30)
    expect(Array.from(long)).toHaveLength(30)
    expect(long.endsWith('…')).toBe(true)
    const emoji = truncate('😀'.repeat(20), 5)
    expect(emoji).toBe('😀😀😀😀…')
    expect(truncate('a‮evil')).toBe('a evil')
  })
  test('secret-looking text: passwords, PINs, codes, card numbers, keys and tokens', () => {
    for (const s of ['hunter2!X', 'P@ssw0rd123', '123456', '4111 1111 1111 1111', '0423', 'sk-ant-api03-abcdefghijklmnop', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig', 'dGhpcyBpcyBhIGxvbmcgdG9rZW4=', '-----BEGIN PRIVATE KEY-----']) {
      expect(looksSecret(s), s).toBe(true)
    }
    for (const s of ['Hello world', 'Quarterly report', 'jeff@example.com', 'https://example.com/a1?b=2', 'Meeting notes for Tuesday', '', 'Numbers']) {
      expect(looksSecret(s), s).toBe(false)
    }
  })
  test('the typing chip shows the first few characters of ordinary text only', () => {
    expect(typingChip('Hello world, this is long')).toBe('Typing “Hello world,…”')
    expect(typingChip('Hi')).toBe('Typing “Hi”')
    expect(typingChip('first line\nsecond')).toBe('Typing “first line…”')
    expect(typingChip('Hello world', true)).toBe('Typing…')
    expect(typingChip('hunter2!X')).toBe('Typing…')
    expect(typingChip('123456')).toBe('Typing…')
    expect(typingChip('')).toBe('Typing…')
  })
  test('quoted secrets in labels are hidden; secure fields hide every quote', () => {
    expect(scrubLabel('Typing "hunter2!X" into Password')).toBe('Typing "•••" into Password')
    expect(scrubLabel('Clicking "Save" in Numbers')).toBe('Clicking "Save" in Numbers')
    expect(scrubLabel('Typing “Hello” here', true)).toBe('Typing “•••” here')
    expect(pillLabel({ kind: 'type', text: 'Hello', secure: true, label: 'Typing "Hello" into Password' })).toBe('Typing "•••" into Password')
    expect(pillLabel({ kind: 'type', text: 'P@ssw0rd123', label: 'Typing "P@ssw0rd123"' })).toBe('Typing "•••"')
    expect(pillLabel({ kind: 'click', x: 1, y: 1, label: 'Clicking Save in Numbers' })).toBe('Clicking Save in Numbers')
    expect(pillLabel({ kind: 'type', text: 'abc', secure: true })).toBe('Typing in a secure field')
  })
  test('default labels tell double, right and triple clicks apart; keys use Mac glyphs', () => {
    expect(defaultLabel({ kind: 'click', x: 0, y: 0 })).toBe('Clicking')
    expect(defaultLabel({ kind: 'click', x: 0, y: 0, count: 2 })).toBe('Double-clicking')
    expect(defaultLabel({ kind: 'click', x: 0, y: 0, count: 3 })).toBe('Triple-clicking')
    expect(defaultLabel({ kind: 'click', x: 0, y: 0, button: 'right' })).toBe('Right-clicking')
    expect(defaultLabel({ kind: 'scroll', x: 0, y: 0, dy: -5 })).toBe('Scrolling down')
    expect(defaultLabel({ kind: 'key', keys: 'cmd+s' })).toBe('Pressing ⌘S')
    expect(keyGlyphs('cmd+shift+t')).toBe('⇧⌘T')
    expect(keyGlyphs('ctrl+option+left')).toBe('⌃⌥←')
    expect(keyGlyphs('return')).toBe('↩')
    expect(keyGlyphs('f5')).toBe('F5')
    expect(keyGlyphs('⌘s')).toBe('⌘S')
    expect(keyGlyphs('capslock')).toBe('Capslock')
    expect(STOP_HINT).toContain('⌃⌥⎋')
  })
})

describe('controller: queueing, coalescing, reduce motion', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  test('show() resolves once the glide has played, starting from the real mouse', async () => {
    const host = new FakeHost()
    const ctl = new OverlayController(host)
    let done = false
    const p = ctl.show({ kind: 'click', x: 700, y: 400, label: 'Clicking Save in Numbers' }).then(() => { done = true })
    const f = host.frames[0]
    expect(f.from).toEqual({ x: 100, y: 100 })
    expect(f.to).toEqual({ x: 700, y: 400 })
    expect(f.moveMs).toBe(moveDuration({ x: 100, y: 100 }, { x: 700, y: 400 }, false))
    expect(f.pill.displayId).toBe(1)
    expect(f.label).toBe('Clicking Save in Numbers')
    await vi.advanceTimersByTimeAsync(f.moveMs - 5)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    await p
    expect(done).toBe(true)
    // The next glide starts where the cursor is now.
    void ctl.show({ kind: 'move', x: -500, y: 300 })
    expect(host.frames[1].from).toEqual({ x: 700, y: 400 })
    expect(host.frames[1].pill.displayId).toBe(2)
  })

  test('Reduce Motion: no glide, show() resolves at once', async () => {
    const host = new FakeHost()
    host.reduce = true
    const ctl = new OverlayController(host)
    let done = false
    void ctl.show({ kind: 'click', x: 900, y: 600 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    expect(host.frames[0].moveMs).toBe(0)
    expect(host.frames[0].reduceMotion).toBe(true)
  })

  test('rapid steps: queued pointer moves and status text a newer step supersedes are dropped; clicks always play', async () => {
    const host = new FakeHost()
    const ctl = new OverlayController(host)
    const all = Promise.all([
      ctl.show({ kind: 'click', x: 600, y: 600 }),
      ctl.show({ kind: 'move', x: 610, y: 10 }),
      ctl.show({ kind: 'status', label: 'Thinking' }),
      ctl.show({ kind: 'move', x: 20, y: 600 }),
      ctl.show({ kind: 'click', x: 30, y: 30, count: 2 })
    ])
    await vi.advanceTimersByTimeAsync(5000)
    await all
    expect(host.frames.map((f) => f.kind)).toEqual(['click', 'click'])
    expect(host.frames[1].count).toBe(2)
    expect(host.frames[1].from).toEqual({ x: 600, y: 600 })
  })

  test('a backlog plays glides at half length so the cursor catches up', async () => {
    const host = new FakeHost()
    const ctl = new OverlayController(host)
    const all = Promise.all([
      ctl.show({ kind: 'click', x: 1400, y: 900 }),
      ctl.show({ kind: 'click', x: 100, y: 100 }),
      ctl.show({ kind: 'click', x: 1400, y: 100 }),
      ctl.show({ kind: 'click', x: 100, y: 900 })
    ])
    await vi.advanceTimersByTimeAsync(5000)
    await all
    const full = moveDuration({ x: 1400, y: 900 }, { x: 100, y: 100 }, false)
    expect(host.frames[1].moveMs).toBe(Math.round(full / 2))
    expect(host.frames[3].moveMs).toBe(moveDuration({ x: 1400, y: 100 }, { x: 100, y: 900 }, false))
  })

  test('supersede rules', () => {
    expect(supersedes({ kind: 'click', x: 0, y: 0 }, { kind: 'move', x: 1, y: 1 })).toBe(true)
    expect(supersedes({ kind: 'key', keys: 'a' }, { kind: 'move', x: 1, y: 1 })).toBe(false)
    expect(supersedes({ kind: 'key', keys: 'a' }, { kind: 'status', label: 'x' })).toBe(true)
    expect(supersedes({ kind: 'click', x: 0, y: 0 }, { kind: 'click', x: 1, y: 1 })).toBe(false)
    expect(supersedes({ kind: 'focus', x: 0, y: 0, w: 1, h: 1 }, { kind: 'focus', x: 1, y: 1, w: 1, h: 1 })).toBe(true)
  })

  test('typing, keys, focus and drags carry what the page draws', async () => {
    const host = new FakeHost()
    const ctl = new OverlayController(host)
    void ctl.show({ kind: 'type', x: 300, y: 200, text: 'Hello world, again', label: 'Typing in Notes' })
    void ctl.show({ kind: 'type', text: 'hunter2!X', secure: true })
    void ctl.show({ kind: 'key', keys: 'cmd+s' })
    void ctl.show({ kind: 'focus', x: 10, y: 20, w: 100, h: 30 })
    void ctl.show({ kind: 'drag', x: 50, y: 50, x2: 400, y2: 300 })
    await vi.advanceTimersByTimeAsync(5000)
    const [t1, t2, k, fo, dr] = host.frames
    expect(t1.chip).toBe('Typing “Hello world,…”')
    expect(t2.chip).toBe('Typing…')
    expect(t2.label).toBe('Typing in a secure field')
    expect(t2.to).toBeUndefined()
    expect(k.chip).toBe('⌘S')
    expect(k.moveMs).toBe(0)
    expect(fo.box).toEqual({ x: 10, y: 20, width: 100, height: 30 })
    expect(dr.to).toEqual({ x: 50, y: 50 })
    expect(dr.to2).toEqual({ x: 400, y: 300 })
    expect(JSON.stringify(host.frames)).not.toContain('hunter2')
    // After the drag the cursor is at the drop point.
    expect(ctl.position).toEqual({ x: 400, y: 300 })
  })

  test('hide() and done: pending steps resolve, the host hides, the next run starts from the real mouse', async () => {
    const host = new FakeHost()
    const ctl = new OverlayController(host)
    const a = ctl.show({ kind: 'click', x: 1000, y: 800 })
    const b = ctl.show({ kind: 'click', x: 10, y: 10 })
    ctl.hide()
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all([a, b])
    expect(host.hides).toBe(1)
    expect(ctl.visible).toBe(false)
    host.mouse = { x: 5, y: 5 }
    void ctl.show({ kind: 'move', x: 50, y: 50 })
    expect(host.frames.at(-1)!.from).toEqual({ x: 5, y: 5 })
    await ctl.show({ kind: 'done' })
    expect(host.hides).toBe(2)
  })

  test('idle safety net hides the overlay; show() never waits past the cap; no host or no displays resolve at once', async () => {
    const host = new FakeHost()
    const ctl = new OverlayController(host, { idleHideMs: 3000, maxWaitMs: 100 })
    let done = false
    void ctl.show({ kind: 'click', x: 1500, y: 900 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(101)
    expect(done).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.hides).toBe(1)

    await expect(new OverlayController(null).show({ kind: 'click', x: 1, y: 1 })).resolves.toBeUndefined()
    const empty = new FakeHost()
    empty.ds = []
    const c2 = new OverlayController(empty)
    let ok = false
    void c2.show({ kind: 'click', x: 1, y: 1 }).then(() => { ok = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(ok).toBe(true)
    expect(empty.frames).toHaveLength(0)
  })

  test('a host that throws never breaks the action', async () => {
    const host = new FakeHost()
    host.render = () => { throw new Error('window gone') }
    const ctl = new OverlayController(host)
    let ok = false
    void ctl.show({ kind: 'click', x: 1, y: 1 }).then(() => { ok = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(ok).toBe(true)
  })
})

describe('browser panel cursor CSS', () => {
  test('glides from→to, pulses the element box, shows "Typing…" and never the text', () => {
    const css = pageCursorCss({ id: 'c1', from: { x: 10, y: 20 }, to: { x: 300, y: 400 }, box: { x: 280, y: 390, width: 40, height: 20 }, moveMs: 240, kind: 'click' })
    expect(css).toContain('translate(10px, 20px)')
    expect(css).toContain('translate(300px, 400px)')
    expect(css).toContain('240ms')
    expect(css).toContain('pointer-events: none')
    expect(css).toContain('html::before')
    const typing = pageCursorCss({ id: 'c2', from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, moveMs: 200, kind: 'type', reduceMotion: true })
    expect(typing).toContain("content: 'Typing…'")
    expect(typing).toContain('0ms')
    expect(typing).not.toContain('html::before')
  })
  test('ids and numbers are sanitized', () => {
    const css = pageCursorCss({ id: 'x"};body{display:none', from: { x: Number.NaN, y: 1 }, to: { x: 2, y: 3 }, moveMs: 100, kind: 'click' })
    expect(css).not.toContain('"}')
    expect(css).toContain('sb-glide-xbodydisplaynone')
    expect(css).toContain('translate(0px, 1px)')
  })
})
