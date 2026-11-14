import { JXA_GET } from './types'

// Reading what an app shows through the Accessibility API, for apps whose scripting can't read their
// content (Messages' transcript, Slack, System Settings panes). The text goes to the model as data
// written by other people (untrusted), in reading order. Password fields are skipped.

/**
 * Text in an app's windows: static text, text areas, headings, links, cells and labelled buttons, top to
 * bottom and left to right, without activating the app. electron: turns on Chromium's accessibility tree
 * first (Slack, VS Code and other Electron apps only expose their content once asked).
 */
export const AX_TEXT = `(a) => {
  ${JXA_GET}
  const se = Application('System Events')
  let ps = se.processes.whose({ name: a.app })
  if (!ps.length) ps = se.processes.whose({ displayedName: a.app })
  if (!ps.length) return { error: 'not running' }
  const P = ps[0]
  if (a.electron) {
    try {
      ObjC.import('ApplicationServices')
      const el = $.AXUIElementCreateApplication(P.unixId())
      $.AXUIElementSetAttributeValue(el, $('AXManualAccessibility'), $.kCFBooleanTrue)
      delay(0.3)
    } catch (e) {}
  }
  const TEXT = /^AX(StaticText|TextArea|TextField|Heading|Link|Cell|Button|MenuButton|CheckBox|RadioButton|PopUpButton|Image)$/
  const SKIP = /^AX(ScrollBar|SecureTextField|MenuBar|Toolbar)$/
  const out = []
  let seen = 0
  const walk = (el, depth) => {
    if (depth > a.maxDepth || out.length >= a.max || seen > a.maxNodes) return
    const kids = el.uiElements
    const k = get(() => kids.length, 0)
    if (!k) return
    const bulk = (prop) => { try { const v = kids[prop](); return Array.isArray(v) && v.length === k ? v : null } catch (e) { return null } }
    const roles = bulk('role'), subs = bulk('subrole'), names = bulk('name'), descs = bulk('description'), poss = bulk('position')
    for (let i = 0; i < k; i++) {
      seen++
      if (out.length >= a.max) return
      const c = kids[i]
      const role = (roles ? roles[i] : get(() => c.role(), '')) || ''
      const sub = (subs ? subs[i] : get(() => c.subrole(), '')) || ''
      if (SKIP.test(role) || sub === 'AXSecureTextField') continue
      if (TEXT.test(role)) {
        let t = ''
        if (/^AX(StaticText|TextArea|TextField|Heading|Cell)$/.test(role)) { const v = get(() => c.value(), null); if (v !== null && v !== undefined && typeof v !== 'object') t = String(v) }
        if (!t) t = String((names ? names[i] : get(() => c.name(), '')) || (descs ? descs[i] : get(() => c.description(), '')) || '')
        t = t.replace(/\\s+/g, ' ').trim()
        if (t) { const p = poss ? poss[i] : get(() => c.position(), null); out.push({ role: role.replace(/^AX/, ''), text: t.slice(0, a.maxText), x: p ? p[0] : 0, y: p ? p[1] : 0 }) }
        if (/^AX(StaticText|TextField|Button|CheckBox|RadioButton|PopUpButton|Image|Link)$/.test(role)) continue
      }
      walk(c, depth + 1)
    }
  }
  const wins = P.windows
  const n = get(() => wins.length, 0)
  const titles = []
  for (let i = 0; i < n && i < a.maxWindows; i++) { titles.push(String(get(() => wins[i].name(), '') || '')); walk(wins[i], 0) }
  return { app: get(() => P.name(), a.app), windows: titles, items: out, truncated: out.length >= a.max }
}`

export interface AxTextItem { role: string; text: string; x: number; y: number }
export interface AxTextResult { app?: string; windows?: string[]; items?: AxTextItem[]; truncated?: boolean; error?: string }

export const axTextInput = (app: string, o: { electron?: boolean; max?: number; maxWindows?: number } = {}): Record<string, unknown> =>
  ({ app, electron: !!o.electron, max: o.max ?? 600, maxNodes: 12_000, maxDepth: 30, maxText: 2000, maxWindows: o.maxWindows ?? 1 })

/**
 * The collected text as lines in reading order (rows by y, then x), with exact repeats next to each
 * other dropped (AX often reports a label and its value twice). Roles are kept for buttons and links so
 * the model can tell controls from content.
 */
export function formatAxText(r: AxTextResult, o: { maxChars?: number } = {}): string {
  const items = [...(r.items ?? [])].sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y))
  const lines: string[] = []
  for (const it of items) {
    const line = /^(Button|Link|CheckBox|RadioButton|PopUpButton|MenuButton)$/.test(it.role) ? `[${it.role}] ${it.text}` : it.text
    if (lines[lines.length - 1] !== line) lines.push(line)
  }
  const text = lines.join('\n')
  const max = o.maxChars ?? 30_000
  return `${r.windows?.length ? `Window: ${r.windows.filter(Boolean).join(' | ') || '(untitled)'}\n` : ''}${text.length > max ? `${text.slice(0, max)}\n… (more not shown)` : text}${r.truncated ? '\n(Only part of the window was read.)' : ''}`
}
