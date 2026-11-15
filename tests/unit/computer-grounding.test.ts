import { describe, expect, test } from 'vitest'
import type { Overlay } from '../../src/main/computer/overlay'
import { KEY, MOUSE, SNAPSHOT, STATE, VALUE } from '../../src/main/computer/scripts'
import { computerTool } from '../../src/main/agent/tools/computer'

// Grounding and waiting in the computer tool: zoom keeps the coordinate frame, wait_for waits for the UI,
// key repeats, and stalls get recovery steps. A fake osascript and a fake screen: nothing here touches the
// real screen, mouse or keyboard.

function rig(o: { appears?: number; state?: () => Record<string, unknown> } = {}) {
  const events: string[] = []
  const captures: Array<{ rect?: { x: number; y: number; width: number; height: number }; width?: number; height?: number }> = []
  let snaps = 0
  const overlay: Overlay = { async show() { /* the cursor */ }, hide() { /* the cursor */ } }
  const osa = async (fn: string, input: any): Promise<unknown> => {
    if (fn === STATE) return o.state?.() ?? { app: 'Numbers', window: 'Budget', windows: 1, sheets: 0 }
    if (fn === VALUE) return { none: true }
    if (fn === MOUSE) { events.push(`mouse:${input.kind}:${input.x},${input.y}`); return true }
    if (fn === KEY) { events.push(`key:${input.char ?? input.code}`); return true }
    if (fn === SNAPSHOT) {
      snaps++
      const ready = o.appears !== undefined && snaps >= o.appears
      return { app: 'Numbers', pid: 7, windows: [{ index: 0, title: 'Budget', x: 0, y: 25, w: 1000, h: 700, focused: true }], nodes: [
        { path: [0, 0], depth: 0, win: 0, role: 'AXButton', name: 'Share', x: 900, y: 30, w: 40, h: 20 },
        ...(ready ? [{ path: [0, 1], depth: 0, win: 0, role: 'AXStaticText', value: 'Export complete', x: 400, y: 300, w: 200, h: 20 }] : [])
      ] }
    }
    return true
  }
  const tool = computerTool({
    enterMini: () => undefined, trusted: () => true, overlay, osa,
    capture: async (_f, opts) => { captures.push(opts ?? {}); return { dataUrl: `data:image/png;base64,${captures.length}`, width: opts?.width ?? 1512, height: opts?.height ?? 982 } },
    displays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, primary: true }]
  })
  const ctx = { threadId: 't1', signal: new AbortController().signal, state: {}, model: 'claude-sonnet-5-5', askUser: async () => 'Done' } as never
  return { tool, ctx, events, captures, snaps: () => snaps }
}

describe('zoom: a close-up that keeps the coordinate frame', () => {
  test('the zoomed image is sharp (Retina pixels) and clicks still use the full screenshot\'s pixels', async () => {
    const r = rig()
    await r.tool.run({ action: 'screenshot' }, r.ctx)
    // Full screenshot: 1512×982 pixels = points. Zoom on a 100×50 point corner region.
    const z = await r.tool.run({ action: 'zoom', region: [700, 400, 800, 450] }, r.ctx)
    expect(r.captures[1]).toEqual({ rect: { x: 700, y: 400, width: 100, height: 50 }, width: 200, height: 100 })
    expect(z.images).toHaveLength(1)
    expect(z.text).toMatch(/stay in the LAST FULL screenshot's pixels \(1512×982\)/)
    // A click at (750, 425) lands on screen point (750, 425): the zoom didn't re-base the frame.
    await r.tool.run({ action: 'click', x: 750, y: 425 }, r.ctx)
    expect(r.events).toContain('mouse:click:750,425')
    await expect(r.tool.run({ action: 'zoom' }, r.ctx)).rejects.toThrow(/region/)
  }, 20_000)
  test('before: a region screenshot re-based the frame (still true for screenshot; zoom is the fix for close-ups)', async () => {
    const r = rig()
    await r.tool.run({ action: 'screenshot' }, r.ctx)
    await r.tool.run({ action: 'screenshot', region: [700, 400, 100, 50] }, r.ctx)
    await r.tool.run({ action: 'click', x: 50, y: 25 }, r.ctx)
    // (50, 25) in the 200×100 region image = screen point (725, 412.5).
    expect(r.events.at(-1)).toBe('mouse:click:725,413')
  }, 20_000)
})

describe('waiting for the UI instead of fixed sleeps', () => {
  test('wait_for returns as soon as the text shows', async () => {
    const r = rig({ appears: 3 })
    const t0 = Date.now()
    const out = await r.tool.run({ action: 'wait_for', query: 'export complete', seconds: 10 }, r.ctx)
    expect(out.text).toMatch(/"export complete" is showing in Numbers after [\d.]+s: e2 \(StaticText "Export complete"\)/)
    expect(r.snaps()).toBe(3)
    expect(Date.now() - t0).toBeLessThan(4000)
  }, 20_000)
  test('wait_for gives up at its limit and says what to try', async () => {
    const r = rig()
    const out = await r.tool.run({ action: 'wait_for', query: 'never there', seconds: 1 }, r.ctx)
    expect(out.text).toMatch(/didn't appear within 1s in Numbers\. Take a screenshot/)
  }, 20_000)
  test('wait_for without a query waits for the screen to settle', async () => {
    let n = 0
    const r = rig({ state: () => ({ app: 'Numbers', window: n++ < 3 ? `Loading ${n}` : 'Budget', windows: 1, sheets: 0 }) })
    const out = await r.tool.run({ action: 'wait_for' }, r.ctx)
    expect(out.text).toMatch(/settled after [\d.]+s\. Now: Numbers › "Budget"/)
  }, 20_000)
})

describe('keyboard navigation and stalls', () => {
  test('key repeat presses the key that many times in one call', async () => {
    const r = rig()
    const out = await r.tool.run({ action: 'key', keys: 'tab', repeat: 4 }, r.ctx)
    expect(r.events.filter((e) => e === 'key:48')).toHaveLength(4)
    expect(out.text).toMatch(/^Pressed tab 4 times\./)
  }, 20_000)
  test('the same click with no effect three times gets recovery steps (refs, zoom, keyboard, menus, Spotlight)', async () => {
    const r = rig()
    await r.tool.run({ action: 'screenshot' }, r.ctx)
    let out = await r.tool.run({ action: 'click', x: 600, y: 600 }, r.ctx)
    expect(out.text).not.toMatch(/Stuck/)
    out = await r.tool.run({ action: 'click', x: 600, y: 600 }, r.ctx)
    out = await r.tool.run({ action: 'click', x: 601, y: 599 }, r.ctx)
    expect(out.text).toMatch(/Stuck: The same click[\s\S]*1\. Read the app with ui[\s\S]*Zoom[\s\S]*Spotlight/)
    // One hint per stall: the next action starts counting again.
    out = await r.tool.run({ action: 'click', x: 600, y: 600 }, r.ctx)
    expect(out.text).not.toMatch(/Stuck/)
  }, 30_000)
})
