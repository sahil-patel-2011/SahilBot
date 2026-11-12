import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef } from '../types'

// Computer use: SahilBot sees the screen and moves the mouse and keyboard, like a person would.
// Screenshots come from macOS `screencapture` (Screen Recording permission); input goes through
// CoreGraphics events and System Events (Accessibility permission). Coordinates are screen points:
// screenshots are scaled so one image pixel = one point, and `ui` lists elements with their centers.

type Args = {
  action: 'screenshot' | 'ui' | 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'scroll' | 'type' | 'key' | 'open_app' | 'wait' | 'click_element' | 'menu' | 'apps'
  x?: number; y?: number; x2?: number; y2?: number; amount?: number; text?: string; keys?: string; app?: string; seconds?: number
  /** click_element: the button/field/item's name as shown by ui (and optionally its role). */
  name?: string; role?: string
  /** menu: the menu path, e.g. "File > Export > Export as PDF…". */
  path?: string
}

export interface ComputerDeps {
  /** Shrink SahilBot to a small window in the corner while it works (once per task). */
  enterMini(threadId: string): void
  /** Screenshot of the main display, scaled to points; PNG data URL plus size. */
  capture(file: string): Promise<{ dataUrl: string; width: number; height: number }>
  /** Accessibility permission (macOS shows its prompt when asked). */
  trusted(prompt: boolean): boolean
}

function sh(cmd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((ok, fail) => execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => (e ? fail(new Error((err || e.message).toString().trim().slice(0, 400))) : ok(out.toString()))))
}

/** Runs a JXA function with JSON input (never string-spliced into the script). */
async function jxa(fn: string, input: unknown): Promise<unknown> {
  const script = `ObjC.import('CoreGraphics'); ObjC.import('AppKit'); function run(argv) { const a = JSON.parse(argv[0]); return JSON.stringify((${fn})(a)); }`
  const out = await sh('osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(input)])
  return JSON.parse(out || 'null')
}

// CoreGraphics mouse events. Types: 1/2 left down/up, 3/4 right down/up, 5 moved, 6 left dragged.
const MOUSE = `(a) => {
  const post = (type, x, y, button, clicks) => {
    const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button)
    if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks)
    $.CGEventPost(0, e)
  }
  const pause = (ms) => { const t = Date.now() + ms; while (Date.now() < t) {} }
  if (a.kind === 'move') post(5, a.x, a.y, 0)
  if (a.kind === 'click' || a.kind === 'double') {
    post(5, a.x, a.y, 0); pause(30)
    post(1, a.x, a.y, 0, 1); post(2, a.x, a.y, 0, 1)
    if (a.kind === 'double') { pause(60); post(1, a.x, a.y, 0, 2); post(2, a.x, a.y, 0, 2) }
  }
  if (a.kind === 'right') { post(5, a.x, a.y, 1); pause(30); post(3, a.x, a.y, 1); post(4, a.x, a.y, 1) }
  if (a.kind === 'drag') {
    post(5, a.x, a.y, 0); pause(40); post(1, a.x, a.y, 0, 1)
    const steps = 12
    for (let i = 1; i <= steps; i++) { post(6, a.x + (a.x2 - a.x) * i / steps, a.y + (a.y2 - a.y) * i / steps, 0); pause(15) }
    post(2, a.x2, a.y2, 0, 1)
  }
  if (a.kind === 'scroll') {
    post(5, a.x, a.y, 0); pause(30)
    const e = $.CGEventCreateScrollWheelEvent(null, 1, 1, a.amount)
    $.CGEventPost(0, e)
  }
  return true
}`

// Elements of the frontmost app's windows with their centers, for models that can't see images.
const UI = `(a) => {
  const se = Application('System Events')
  if (a.app) { try { Application(a.app).activate(); delay(0.6) } catch (e) {} }
  const p = se.processes.whose({ frontmost: true })[0]
  const out = { app: p.name(), elements: [] }
  const seen = (el, depth) => {
    if (out.elements.length >= a.max || depth > 8) return
    let role = '', name = '', pos = null, size = null
    try { role = el.role() } catch (e) {}
    try { name = el.name() || el.description() || el.title() || '' } catch (e) {}
    try { pos = el.position(); size = el.size() } catch (e) {}
    if (pos && size && size[0] > 2 && size[1] > 2 && /Button|TextField|TextArea|CheckBox|RadioButton|PopUpButton|MenuButton|Link|Tab|Cell|StaticText|ComboBox|Slider|MenuItem|Row|Image|Heading|Toolbar|SearchField|DisclosureTriangle|Stepper|ColorWell|Incrementor/.test(role) && (name || /TextField|TextArea|SearchField/.test(role))) {
      let value = ''
      try { value = String(el.value() ?? '').slice(0, 60) } catch (e) {}
      out.elements.push({ role: role.replace(/^AX/, ''), name: String(name).slice(0, 80), value, x: Math.round(pos[0] + size[0] / 2), y: Math.round(pos[1] + size[1] / 2) })
    }
    let kids = []
    try { kids = el.uiElements() } catch (e) {}
    for (const k of kids) seen(k, depth + 1)
  }
  for (const w of p.windows()) seen(w, 0)
  return out
}`

// Click an app menu item by its path through System Events (works without coordinates).
const MENU = `(a) => {
  const se = Application('System Events')
  if (a.app) { try { Application(a.app).activate(); delay(0.5) } catch (e) {} }
  const p = se.processes.whose({ frontmost: true })[0]
  const parts = a.path.split('>').map((s) => s.trim()).filter(Boolean)
  let item = p.menuBars[0].menuBarItems.byName(parts[0])
  let menu = item.menus[0]
  for (let i = 1; i < parts.length; i++) {
    const it = menu.menuItems.byName(parts[i])
    if (i === parts.length - 1) { it.click(); return { app: p.name(), clicked: parts.join(' > ') } }
    menu = it.menus[0]
  }
  item.click()
  return { app: p.name(), clicked: parts[0] }
}`

const APPS = `() => Application('System Events').processes.whose({ backgroundOnly: false })().map((p) => ({ name: p.name(), front: p.frontmost() }))`

const KEYCODES: Record<string, number> = { return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126, pageup: 116, pagedown: 121, home: 115, end: 119, forwarddelete: 117, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96 }

async function pressKeys(combo: string): Promise<void> {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const mods = parts.map((m) => ({ cmd: 'command down', command: 'command down', shift: 'shift down', alt: 'option down', option: 'option down', opt: 'option down', ctrl: 'control down', control: 'control down', fn: 'function down' } as Record<string, string>)[m]).filter(Boolean)
  const using = mods.length ? ` using {${mods.join(', ')}}` : ''
  const stmt = KEYCODES[key] !== undefined ? `key code ${KEYCODES[key]}${using}` : `keystroke ${JSON.stringify(key)}${using}`
  await sh('osascript', ['-e', `tell application "System Events" to ${stmt}`])
}

export function computerTool(d: ComputerDeps): ToolDef<Args> {
  // One OK per task: after the first approved action in a chat, control continues until it's idle for 15 min.
  const granted = new Map<string, number>()
  const isGranted = (threadId: string): boolean => (granted.get(threadId) ?? 0) > Date.now() - 15 * 60_000
  let currentThread = ''

  return {
    name: 'computer',
    label: 'Computer',
    core: true,
    untrusted: true,
    effect: (a) => (['screenshot', 'ui', 'wait', 'apps'].includes(a.action) ? 'read' : 'write_external'),
    // Asks once per task before taking control; then routine clicks and typing run.
    consequential: (a) => !['screenshot', 'ui', 'wait', 'apps'].includes(a.action) && !isGranted(currentThread),
    describe: (a) => a.action === 'type' ? `Take control of your Mac and type "${(a.text ?? '').slice(0, 80)}"` : a.action === 'open_app' ? `Take control of your Mac: open ${a.app}` : `Take control of your mouse and keyboard (${a.action.replace('_', ' ')}${a.x !== undefined ? ` at ${a.x}, ${a.y}` : ''}). SahilBot shrinks to a small window so you can watch; press Stop anytime.`,
    description: 'Use the Mac like a person: see the screen and control the mouse and keyboard, for apps that have no other tool. Start with screenshot (if you can see images) or ui (a list of the front app\'s buttons, fields and text with their x,y centers). Coordinates are screen points. Actions: click_element(name, role?) clicks a button/field/item by its name from ui (most reliable); menu(path like "File > Export > PDF…", app?) picks a menu item; apps lists open apps; ui(app?) reads an app\'s window (brings it to the front); click/double_click/right_click(x,y), move(x,y), drag(x,y,x2,y2), scroll(x,y,amount: negative = down), type(text), key(keys like "cmd+c", "return", "cmd+shift+t"), open_app(app), wait(seconds). After each action, take a screenshot or ui again to check what happened. Prefer the browser tool for websites and app tools (Notes, Calendar, Cursor) when they exist. Never type passwords; stop and ask the user for CAPTCHAs and 2-factor codes.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'ui', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'open_app', 'wait', 'click_element', 'menu', 'apps'] },
        name: { type: 'string', description: 'For click_element: the element name shown by ui' },
        role: { type: 'string', description: 'For click_element: optional role to disambiguate, e.g. Button' },
        path: { type: 'string', description: 'For menu: e.g. "File > Export > Export as PDF…"' },
        x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        amount: { type: 'integer', minimum: -50, maximum: 50, description: 'For scroll: lines; negative scrolls down' },
        text: { type: 'string', description: 'For type' },
        keys: { type: 'string', description: 'For key, e.g. "cmd+v", "return", "escape"' },
        app: { type: 'string', description: 'For open_app, e.g. "Finder", "Numbers"' },
        seconds: { type: 'number', minimum: 0.2, maximum: 10 }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { enum: ['click', 'double_click', 'right_click', 'move', 'scroll'] } } }, then: { required: ['x', 'y'] } },
        { if: { properties: { action: { const: 'drag' } } }, then: { required: ['x', 'y', 'x2', 'y2'] } },
        { if: { properties: { action: { const: 'type' } } }, then: { required: ['text'] } },
        { if: { properties: { action: { const: 'key' } } }, then: { required: ['keys'] } },
        { if: { properties: { action: { const: 'open_app' } } }, then: { required: ['app'] } },
        { if: { properties: { action: { const: 'click_element' } } }, then: { required: ['name'] } },
        { if: { properties: { action: { const: 'menu' } } }, then: { required: ['path'] } }
      ]
    },
    async run(a, ctx) {
      currentThread = ctx.threadId
      const acting = !['screenshot', 'ui', 'wait', 'apps'].includes(a.action)
      if (acting) {
        if (!d.trusted(true)) throw new Error('SahilBot needs Accessibility permission to use the mouse and keyboard. macOS just showed the prompt: the user should turn SahilBot on in System Settings → Privacy & Security → Accessibility, then you can try again.')
        granted.set(ctx.threadId, Date.now())
        d.enterMini(ctx.threadId)
      }
      switch (a.action) {
        case 'screenshot': {
          const dir = mkdtempSync(join(tmpdir(), 'sb-shot-'))
          try {
            d.enterMini(ctx.threadId)
            const shot = await d.capture(join(dir, 'screen.png'))
            return { text: `Screenshot of the screen (${shot.width}×${shot.height} points; use these coordinates).`, display: 'Looked at the screen', images: [shot.dataUrl] }
          } catch (e) {
            throw new Error(/could not create image|not permitted|denied/i.test((e as Error).message) ? 'SahilBot needs Screen Recording permission to see the screen: System Settings → Privacy & Security → Screen Recording. Meanwhile use the ui action instead.' : (e as Error).message)
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        }
        case 'ui': {
          if (!d.trusted(true)) throw new Error('Reading other apps needs Accessibility permission: System Settings → Privacy & Security → Accessibility → SahilBot.')
          const r = (await jxa(UI, { max: 200, app: a.app ?? null })) as { app: string; elements: Array<{ role: string; name: string; value: string; x: number; y: number }> }
          return { text: `Front app: ${r.app}\n${r.elements.map((e) => `- ${e.role} "${e.name}"${e.value ? ` = "${e.value}"` : ''} at (${e.x}, ${e.y})`).join('\n') || '(no readable elements: take a screenshot instead)'}`, display: `Read ${r.app}'s window` }
        }
        case 'apps': {
          const r = (await jxa(APPS, {})) as Array<{ name: string; front: boolean }>
          return { text: r.map((x) => `- ${x.name}${x.front ? ' (in front)' : ''}`).join('\n'), display: `${r.length} apps open` }
        }
        case 'click_element': {
          // Find it in the front app's window by name (and role), then click its center.
          const r = (await jxa(UI, { max: 400, app: a.app ?? null })) as { app: string; elements: Array<{ role: string; name: string; x: number; y: number }> }
          const want = a.name!.toLowerCase()
          const pool = r.elements.filter((e) => !a.role || e.role.toLowerCase().includes(a.role.toLowerCase()))
          const hit = pool.find((e) => e.name.toLowerCase() === want) ?? pool.find((e) => e.name.toLowerCase().includes(want))
          if (!hit) throw new Error(`No element named "${a.name}" in ${r.app}. Read the window with ui to see what's there, or take a screenshot.`)
          await jxa(MOUSE, { kind: 'click', x: hit.x, y: hit.y })
          return { text: `Clicked ${hit.role} "${hit.name}" in ${r.app} at (${hit.x}, ${hit.y}). Check the result with ui or a screenshot.`, display: `clicked "${hit.name.slice(0, 40)}"` }
        }
        case 'menu': {
          try {
            const r = (await jxa(MENU, { path: a.path, app: a.app ?? null })) as { app: string; clicked: string }
            return { text: `Chose ${r.clicked} in ${r.app}.`, display: `menu: ${r.clicked.slice(0, 50)}` }
          } catch (e) {
            throw new Error(`Couldn't find the menu item "${a.path}" (${(e as Error).message.slice(0, 120)}). Menu names must match exactly, including "…".`)
          }
        }
        case 'click': case 'double_click': case 'right_click': case 'move': {
          await jxa(MOUSE, { kind: a.action === 'double_click' ? 'double' : a.action === 'right_click' ? 'right' : a.action === 'move' ? 'move' : 'click', x: a.x, y: a.y })
          return { text: `${a.action.replace('_', ' ')} at (${a.x}, ${a.y}). Check the result with a screenshot or ui.`, display: `${a.action.replace('_', ' ')} at ${Math.round(a.x!)}, ${Math.round(a.y!)}` }
        }
        case 'drag':
          await jxa(MOUSE, { kind: 'drag', x: a.x, y: a.y, x2: a.x2, y2: a.y2 })
          return { text: `Dragged from (${a.x}, ${a.y}) to (${a.x2}, ${a.y2}).`, display: 'dragged' }
        case 'scroll':
          try { await jxa(MOUSE, { kind: 'scroll', x: a.x, y: a.y, amount: a.amount ?? -5 }) } catch { await pressKeys((a.amount ?? -5) < 0 ? 'pagedown' : 'pageup') }
          return { text: `Scrolled ${(a.amount ?? -5) < 0 ? 'down' : 'up'}.`, display: `scrolled ${(a.amount ?? -5) < 0 ? 'down' : 'up'}` }
        case 'type':
          // Typed in chunks so long text doesn't drop characters.
          for (const chunk of a.text!.match(/[\s\S]{1,200}/g) ?? []) await sh('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(chunk)}`])
          return { text: `Typed ${a.text!.length} characters.`, display: `typed "${a.text!.slice(0, 40)}"` }
        case 'key':
          await pressKeys(a.keys!)
          return { text: `Pressed ${a.keys}.`, display: `pressed ${a.keys}` }
        case 'open_app':
          await sh('open', ['-a', a.app!])
          await new Promise((r) => setTimeout(r, 1200))
          return { text: `Opened ${a.app}.`, display: `opened ${a.app}` }
        case 'wait':
          await new Promise((r) => setTimeout(r, Math.min(10, a.seconds ?? 1) * 1000))
          return { text: `Waited ${a.seconds ?? 1}s.`, display: 'waited' }
      }
    }
  }
}
