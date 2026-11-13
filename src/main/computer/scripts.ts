// JXA (JavaScript for Automation) sources run through `osascript -l JavaScript`. Each is a function of
// one JSON argument (never string-spliced into the script). They read and drive other apps through
// System Events (Accessibility permission) and post mouse events through CoreGraphics.

/** Menu-name matching, shared by the menu script and the unit tests: exact, then prefix, then contains; "..." = "…". */
export const MATCH_JS = `function (names, want) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\\.\\.\\.|\\u2026/g, '').replace(/\\s+/g, ' ').trim()
  const w = norm(want)
  if (!w) return -1
  let i = names.findIndex((n) => norm(n) === w)
  if (i < 0) i = names.findIndex((n) => norm(n).startsWith(w))
  if (i < 0) i = names.findIndex((n) => norm(n).includes(w))
  return i
}`

/** try/catch getter. */
const GET = `const get = (f, d) => { try { const v = f(); return v === undefined ? d : v } catch (e) { return d } }`

/**
 * The process to work in: by pid, by app name (activated first when asked, waiting until it is in
 * front), or the frontmost app.
 */
const PROC = `const proc = (se, a) => {
  if (a.pid) { const p = se.processes.whose({ unixId: a.pid }); if (p.length) return p[0] }
  if (a.app) {
    if (a.activate) {
      try { Application(a.app).activate() } catch (e) {}
      for (let i = 0; i < 30; i++) { const f = get(() => se.processes.whose({ frontmost: true })[0].name(), ''); if (f && (f === a.app || f.toLowerCase() === String(a.app).toLowerCase())) break; delay(0.1) }
    }
    let p = se.processes.whose({ name: a.app })
    if (!p.length) p = se.processes.whose({ displayedName: a.app })
    if (p.length) return p[0]
    if (!a.activate) return null
  }
  return se.processes.whose({ frontmost: true })[0]
}`

/** Walks to an element by path (window index, then child indexes). */
const RESOLVE = `const resolve = (p, path) => { let el = p.windows[path[0]]; for (let i = 1; i < path.length; i++) el = el.uiElements[path[i]]; return el }`

const VALUE_ROLES = `/^AX(TextField|TextArea|ComboBox|CheckBox|RadioButton|Slider|PopUpButton|ValueIndicator|Incrementor|ProgressIndicator|LevelIndicator|StaticText|Heading|SearchField|DateField|TimeField|Switch|Cell|MenuButton|Stepper)$/`
/** Roles whose children aren't worth walking (a button's image, a field's text). */
const LEAF_ROLES = `/^AX(StaticText|Button|CheckBox|RadioButton|TextField|TextArea|PopUpButton|MenuButton|Slider|Image|Incrementor|ComboBox|ScrollBar|ValueIndicator|SecureTextField|ProgressIndicator|ColorWell|DisclosureTriangle|Link|MenuBar|Stepper)$/`

/**
 * Snapshot: the app's windows and their elements (role, subrole, title, description, value, enabled,
 * focused, position, size). Reads each container's children in bulk (one Apple event per attribute).
 * Password fields' values are never read.
 */
export const SNAPSHOT = `(a) => {
  ${GET}
  ${PROC}
  const se = Application('System Events')
  const P = proc(se, a)
  if (!P) return { error: 'not running', app: a.app || '', windows: [], nodes: [] }
  const VALUE = ${VALUE_ROLES}
  const LEAF = ${LEAF_ROLES}
  const out = { app: get(() => P.name(), ''), pid: get(() => P.unixId()), windows: [], nodes: [], truncated: false }
  const fw = get(() => P.attributes.byName('AXFocusedWindow').value(), null)
  const fwName = fw ? get(() => fw.name(), null) : null
  const walk = (el, path, depth, win) => {
    if (depth >= a.maxDepth) return
    const kids = el.uiElements
    const k = get(() => kids.length, 0)
    if (!k) return
    const bulk = (prop) => { try { const v = kids[prop](); return Array.isArray(v) && v.length === k ? v : null } catch (e) { return null } }
    const roles = bulk('role'), subs = bulk('subrole'), names = bulk('name'), descs = bulk('description'), poss = bulk('position'), sizes = bulk('size'), ens = bulk('enabled'), focs = bulk('focused')
    for (let i = 0; i < k; i++) {
      if (out.nodes.length >= a.max) { out.truncated = true; return }
      const c = kids[i]
      const pick = (arr, prop) => (arr ? arr[i] : get(() => c[prop](), null))
      const role = pick(roles, 'role') || ''
      const subrole = pick(subs, 'subrole') || ''
      const node = { path: path.concat(i), depth: depth, win: win, role: role, subrole: subrole, name: String(pick(names, 'name') || ''), desc: String(pick(descs, 'description') || '') }
      const p = pick(poss, 'position'), s = pick(sizes, 'size')
      if (p && s) { node.x = p[0]; node.y = p[1]; node.w = s[0]; node.h = s[1] }
      node.enabled = pick(ens, 'enabled') !== false
      node.focused = !!pick(focs, 'focused')
      node.secure = subrole === 'AXSecureTextField' || role === 'AXSecureTextField'
      if (!node.secure && VALUE.test(role)) { const v = get(() => c.value(), null); if (v !== null && v !== undefined && typeof v !== 'object') node.value = String(v).slice(0, a.maxValue) }
      out.nodes.push(node)
      if (!LEAF.test(role)) walk(c, node.path, depth + 1, win)
    }
  }
  const wins = P.windows
  const n = get(() => wins.length, 0)
  for (let i = 0; i < n && i < a.maxWindows; i++) {
    const w = wins[i]
    const pos = get(() => w.position(), null), size = get(() => w.size(), null)
    const title = String(get(() => w.name(), '') || '')
    const minimized = !!get(() => w.attributes.byName('AXMinimized').value(), false)
    out.windows.push({ index: i, title: title, x: pos ? pos[0] : undefined, y: pos ? pos[1] : undefined, w: size ? size[0] : undefined, h: size ? size[1] : undefined, focused: fwName !== null && title === fwName, minimized: minimized })
    if (!minimized && (a.window === null || a.window === undefined || a.window === i)) walk(w, [i], 0, i)
  }
  return out
}`

/**
 * One quick read of what's in front: app, focused window, window and sheet counts, the focused element
 * (value only if it isn't a password field) and, when given, the target element by path.
 */
export const STATE = `(a) => {
  ${GET}
  ${RESOLVE}
  const se = Application('System Events')
  const P = se.processes.whose({ frontmost: true })[0]
  const out = { app: get(() => P.name(), ''), window: '', windows: get(() => P.windows.length, 0), sheets: 0 }
  const fw = get(() => P.attributes.byName('AXFocusedWindow').value(), null)
  if (fw) { out.window = String(get(() => fw.name(), '') || ''); out.sheets = get(() => fw.sheets.length, 0); out.kids = get(() => fw.uiElements.length, undefined) }
  const fe = get(() => P.attributes.byName('AXFocusedUIElement').value(), null)
  if (fe) {
    const role = get(() => fe.role(), '') || ''
    const subrole = get(() => fe.subrole(), '') || ''
    const secure = subrole === 'AXSecureTextField' || role === 'AXSecureTextField'
    const f = { role: role, subrole: subrole || undefined, label: String(get(() => fe.name(), '') || get(() => fe.description(), '') || '').slice(0, 100), secure: secure }
    if (!secure) { const v = get(() => fe.value(), null); if (v !== null && v !== undefined && typeof v !== 'object') f.value = String(v).slice(0, 200) }
    out.focused = f
  }
  if (a.target) {
    const tp = a.target.pid ? get(() => se.processes.whose({ unixId: a.target.pid })[0], null) : P
    const el = tp ? get(() => resolve(tp, a.target.path), null) : null
    const role = el ? get(() => el.role(), null) : null
    if (!role) out.target = { exists: false }
    else {
      const t = { exists: true, enabled: get(() => el.enabled(), undefined), focused: get(() => el.focused(), undefined), label: String(get(() => el.name(), '') || get(() => el.description(), '') || '').slice(0, 100) }
      const sub = get(() => el.subrole(), '')
      if (sub !== 'AXSecureTextField' && role !== 'AXSecureTextField') { const v = get(() => el.value(), null); if (v !== null && v !== undefined && typeof v !== 'object') t.value = String(v).slice(0, 200) }
      out.target = t
    }
  }
  return out
}`

/**
 * Acts on one element by path, after checking it is still the element the snapshot saw (same role, and
 * same title/description when it had one). ops: press (AXPress), action (a named AX action), focus,
 * set_value, raise (a window: AXRaise + bring the app to the front), read. Password fields refuse focus
 * for typing and set_value.
 */
export const ELEMENT = `(a) => {
  ${GET}
  ${RESOLVE}
  const se = Application('System Events')
  const P = a.pid ? get(() => se.processes.whose({ unixId: a.pid })[0], null) : se.processes.whose({ frontmost: true })[0]
  if (!P) return { missing: true, why: 'app not running' }
  const el = get(() => resolve(P, a.path), null)
  const role = el ? get(() => el.role(), null) : null
  if (!role) return { missing: true }
  const subrole = get(() => el.subrole(), '') || ''
  const name = String(get(() => el.name(), '') || ''), desc = String(get(() => el.description(), '') || '')
  if (a.expect && (a.expect.role !== role || (a.expect.name && a.expect.name !== name) || (a.expect.desc && a.expect.desc !== desc))) return { mismatch: true, role: role, name: name }
  const secure = subrole === 'AXSecureTextField' || role === 'AXSecureTextField'
  const actions = () => get(() => el.actions.name(), [])
  const res = { role: role, subrole: subrole, name: name, secure: secure, done: false }
  if (a.op === 'press') {
    try { el.actions.byName('AXPress').perform(); res.done = true } catch (e) { res.actions = actions(); res.error = String(e).slice(0, 160) }
  } else if (a.op === 'action') {
    try { el.actions.byName(a.action).perform(); res.done = true } catch (e) { res.actions = actions(); res.error = String(e).slice(0, 160) }
  } else if (a.op === 'focus') {
    if (secure && a.forTyping) return Object.assign(res, { refused: 'secure' })
    try { el.focused = true; res.done = !!get(() => el.focused(), false) } catch (e) { res.error = String(e).slice(0, 160) }
  } else if (a.op === 'set_value') {
    if (secure) return Object.assign(res, { refused: 'secure' })
    try { el.value = a.value; res.done = true } catch (e) { res.error = String(e).slice(0, 160) }
  } else if (a.op === 'raise') {
    try { el.actions.byName('AXRaise').perform(); res.done = true } catch (e) { res.error = String(e).slice(0, 160) }
    try { P.frontmost = true } catch (e) {}
  } else if (a.op === 'actions') {
    res.actions = actions(); res.done = true
  }
  const pos = get(() => el.position(), null), size = get(() => el.size(), null)
  if (pos && size) { res.x = pos[0]; res.y = pos[1]; res.w = size[0]; res.h = size[1] }
  if (!secure) { const v = get(() => el.value(), null); if (v !== null && v !== undefined && typeof v !== 'object') res.value = String(v).slice(0, 200) }
  return res
}`

/**
 * Menu bar: walks a path like "File > Export > PDF…" (case-insensitive; "..." matches "…"; prefixes
 * work). The last item is clicked if enabled; if it opens a submenu, or the path names a top menu, its
 * items are listed instead. A miss returns the names at that level so the model can correct itself.
 */
export const MENU = `(a) => {
  ${GET}
  ${PROC}
  const match = ${MATCH_JS}
  const se = Application('System Events')
  const P = proc(se, a)
  if (!P) return { error: (a.app || 'The app') + ' is not running.' }
  const parts = String(a.path).split('>').map((s) => s.trim()).filter(Boolean)
  const list = (items) => { const n = get(() => items.name(), []); const en = get(() => items.enabled(), []); return n.map((x, i) => (x ? x + (en[i] === false ? ' (disabled)' : '') : null)).filter(Boolean) }
  const bar = get(() => P.menuBars[0].menuBarItems, null)
  if (!bar) return { error: 'This app has no menu bar SahilBot can read.' }
  const top = get(() => bar.name(), [])
  let i = match(top, parts[0])
  if (i < 0) return { app: P.name(), missing: 0, options: top.filter(Boolean) }
  let menu = bar[i].menus[0]
  const walked = [top[i]]
  if (parts.length === 1) return { app: P.name(), listed: walked.join(' > '), options: list(menu.menuItems) }
  for (let d = 1; d < parts.length; d++) {
    const items = menu.menuItems
    const names = get(() => items.name(), [])
    i = match(names, parts[d])
    if (i < 0) return { app: P.name(), missing: d, walked: walked.join(' > '), options: list(items) }
    walked.push(names[i])
    const item = items[i]
    const sub = get(() => item.menus.length, 0)
    if (d === parts.length - 1) {
      if (sub) return { app: P.name(), listed: walked.join(' > '), options: list(item.menus[0].menuItems) }
      if (get(() => item.enabled(), true) === false) return { app: P.name(), disabled: walked.join(' > ') }
      item.click()
      return { app: P.name(), clicked: walked.join(' > ') }
    }
    if (!sub) return { app: P.name(), missing: d + 1, walked: walked.join(' > '), options: [] }
    menu = item.menus[0]
  }
  return { error: 'empty path' }
}`

/** Open windows of every app in the Dock (or one app): title, position, size, minimized. */
export const WINDOWS = `(a) => {
  ${GET}
  const se = Application('System Events')
  const procs = a.app ? se.processes.whose({ name: a.app })() : se.processes.whose({ backgroundOnly: false })()
  const out = []
  for (const p of procs.slice(0, 40)) {
    const ws = p.windows
    const n = get(() => ws.length, 0)
    if (!n) continue
    const names = get(() => ws.name(), []), poss = get(() => ws.position(), []), sizes = get(() => ws.size(), [])
    const front = get(() => p.frontmost(), false)
    for (let i = 0; i < n && i < 20; i++) {
      out.push({ app: get(() => p.name(), ''), pid: get(() => p.unixId()), index: i, title: String(names[i] || ''), x: poss[i] ? poss[i][0] : undefined, y: poss[i] ? poss[i][1] : undefined, w: sizes[i] ? sizes[i][0] : undefined, h: sizes[i] ? sizes[i][1] : undefined, front: front && i === 0, minimized: !!get(() => ws[i].attributes.byName('AXMinimized').value(), false) })
    }
  }
  return out
}`

export const APPS = `() => Application('System Events').processes.whose({ backgroundOnly: false })().map((p) => ({ name: p.name(), front: p.frontmost() }))`

/** Brings an app to the front (launching it if needed) and waits up to 5 s until it is. */
export const ACTIVATE = `(a) => {
  ${GET}
  try { Application(a.app).activate() } catch (e) { return { error: String(e).slice(0, 160) } }
  const se = Application('System Events')
  for (let i = 0; i < 50; i++) {
    const f = get(() => se.processes.whose({ frontmost: true })[0].name(), '')
    if (f.toLowerCase() === String(a.app).toLowerCase() || get(() => se.processes.whose({ frontmost: true })[0].displayedName(), '').toLowerCase() === String(a.app).toLowerCase()) return { front: f }
    delay(0.1)
  }
  return { front: get(() => se.processes.whose({ frontmost: true })[0].name(), ''), timeout: true }
}`

export const QUIT = `(a) => { try { Application(a.app).quit(); return { ok: true } } catch (e) { return { error: String(e).slice(0, 160) } } }`

/** One shortcut or named key, with modifiers, through System Events. */
export const KEY = `(a) => {
  const se = Application('System Events')
  const opts = a.using && a.using.length ? { using: a.using } : {}
  if (a.code !== undefined && a.code !== null) se.keyCode(a.code, opts); else se.keystroke(a.char, opts)
  return true
}`

/** Types text as keystrokes (the caller chunks long text). */
export const TYPE = `(a) => { Application('System Events').keystroke(a.text); return true }`

// CoreGraphics mouse events. Types: 1/2 left down/up, 3/4 right down/up, 5 moved, 6 left dragged.
// Flags (modifier clicks): cmd 0x100000, shift 0x20000, option 0x80000, ctrl 0x40000.
export const MOUSE = `(a) => {
  const post = (type, x, y, button, clicks) => {
    const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button)
    if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks)
    if (a.flags) $.CGEventSetFlags(e, a.flags)
    $.CGEventPost(0, e)
  }
  const pause = (ms) => { const t = Date.now() + ms; while (Date.now() < t) {} }
  if (a.kind === 'move') post(5, a.x, a.y, 0)
  if (a.kind === 'click' || a.kind === 'double' || a.kind === 'triple') {
    post(5, a.x, a.y, 0); pause(30)
    const n = a.kind === 'triple' ? 3 : a.kind === 'double' ? 2 : 1
    for (let c = 1; c <= n; c++) { post(1, a.x, a.y, 0, c); post(2, a.x, a.y, 0, c); if (c < n) pause(60) }
  }
  if (a.kind === 'right') { post(5, a.x, a.y, 1); pause(30); post(3, a.x, a.y, 1); post(4, a.x, a.y, 1) }
  if (a.kind === 'drag') {
    post(5, a.x, a.y, 0); pause(40); post(1, a.x, a.y, 0, 1); pause(60)
    const steps = 16
    for (let i = 1; i <= steps; i++) { post(6, a.x + (a.x2 - a.x) * i / steps, a.y + (a.y2 - a.y) * i / steps, 0); pause(15) }
    pause(60); post(2, a.x2, a.y2, 0, 1)
  }
  if (a.kind === 'scroll') {
    post(5, a.x, a.y, 0); pause(30)
    // CGEventCreateScrollWheelEvent2 isn't variadic, so the JXA bridge can call it (units 1 = lines).
    let e = null
    try { e = $.CGEventCreateScrollWheelEvent2(null, 1, 2, a.dy || 0, a.dx || 0, 0) } catch (err) {}
    if (!e) e = $.CGEventCreateScrollWheelEvent(null, 1, 1, a.dy || 0)
    $.CGEventPost(0, e)
  }
  return true
}`

/** Wraps a function source so osascript runs it with one JSON argument and prints JSON back. */
export function wrap(fn: string): string {
  return `ObjC.import('CoreGraphics'); ObjC.import('AppKit'); function run(argv) { const a = JSON.parse(argv[0]); return JSON.stringify((${fn})(a)); }`
}
