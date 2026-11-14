import { contains, displayAt, ordered, type DisplayInfo, type Rect } from './geometry'

/**
 * The visible SahilBot cursor: computer use reports each step here and the overlay (a click-through
 * window over every display) shows where it acts. Contract between computer.ts and the overlay.
 * Points are screen points (global coordinates, origin top-left of the main display).
 */
export type OverlayAction =
  | { kind: 'move'; x: number; y: number; label?: string }
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right'; count?: number; label?: string }
  | { kind: 'drag'; x: number; y: number; x2: number; y2: number; label?: string }
  | { kind: 'scroll'; x: number; y: number; dy: number; label?: string }
  /** secure: the focused field is a password/secure field: the chip shows no text at all. */
  | { kind: 'type'; x?: number; y?: number; text: string; label?: string; secure?: boolean }
  | { kind: 'key'; keys: string; label?: string }
  | { kind: 'focus'; x: number; y: number; w: number; h: number; label?: string }
  | { kind: 'status'; label: string }
  | { kind: 'done' }

export interface Overlay {
  /** Shows a step. Resolves when its animation has played far enough for the real event to follow. */
  show(a: OverlayAction): Promise<void>
  /** Hides the cursor (run finished or stopped). */
  hide(): void
}

/** Until the overlay is wired, steps aren't shown. */
export const noOverlay: Overlay = { show: async () => undefined, hide: () => undefined }

// ------------------------------------------------------------------------------------------------
// Pure logic (no Electron): timing, labels, secret masking, display mapping, queueing. The windows
// live in overlay-window.ts; the page that draws lives in src/renderer/overlay.html.

export interface Point { x: number; y: number }

export const MOVE_MIN_MS = 180
export const MOVE_MAX_MS = 350
export const CLICK_MS = 250
/** The stop shortcut, as the pill shows it (Ctrl+Option+Esc). */
export const STOP_HINT = '⌃⌥⎋ to stop'
/** Pill size (points): the hover test and the placement use this box; the page never draws it larger. */
export const PILL = { width: 400, height: 40 }
const LABEL_MAX = 52

/** Glide time for a move: distance-based, 180–350 ms; 0 with Reduce Motion or no real distance. */
export function moveDuration(from: Point | undefined, to: Point, reduceMotion: boolean): number {
  if (reduceMotion || !from) return 0
  const d = Math.hypot(to.x - from.x, to.y - from.y)
  if (!Number.isFinite(d) || d < 2) return 0
  return Math.round(Math.min(MOVE_MAX_MS, MOVE_MIN_MS + Math.sqrt(d) * 5))
}

/** The display a point is on, or the nearest one when it's in a gap or off every screen. */
export function displayFor(displays: DisplayInfo[], p: Point): DisplayInfo | undefined {
  const hit = displayAt(displays, p.x, p.y)
  if (hit) return hit
  let best: DisplayInfo | undefined
  let dist = Infinity
  for (const d of displays) {
    const cx = Math.max(d.bounds.x, Math.min(p.x, d.bounds.x + d.bounds.width))
    const cy = Math.max(d.bounds.y, Math.min(p.y, d.bounds.y + d.bounds.height))
    const dd = Math.hypot(p.x - cx, p.y - cy)
    if (dd < dist) { dist = dd; best = d }
  }
  return best
}

/** A global point in a display window's own coordinates (each overlay window covers one display). */
export function toLocal(d: Pick<DisplayInfo, 'bounds'>, p: Point): Point {
  return { x: p.x - d.bounds.x, y: p.y - d.bounds.y }
}

/** One line, no control characters, at most `max` characters (never splitting an emoji). */
export function truncate(s: string, max = LABEL_MAX): string {
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : flat
}

/**
 * Text that could be a secret: passwords (one token mixing character kinds), PINs, one-time codes and
 * card numbers (digit runs), API keys and tokens, private keys. Errs towards hiding.
 */
export function looksSecret(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/.test(t)) return true
  if (/\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{12,}/.test(t)) return true
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-|\bAIza[0-9A-Za-z_-]{20,}|\beyJ[\w-]{8,}\.[\w-]{8,}\./.test(t)) return true
  // PINs, codes, card and account numbers.
  const digits = t.replace(/[\s-]/g, '')
  if (/^\d{4,19}$/.test(digits)) return true
  if (/\d{6,}/.test(t.replace(/[\s-]/g, ''))) return true
  if (/\s/.test(t)) return false
  if (/^https?:\/\/[^\s]+$/i.test(t) || /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(t)) return false
  // A long opaque token.
  if (t.length >= 20 && /^[A-Za-z0-9+/=_.-]+$/.test(t)) return true
  // A single word mixing three kinds of characters: password-like.
  if (t.length >= 8) {
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(t)).length
    if (kinds >= 3) return true
  }
  return false
}

/** The typing chip: "Typing…" alone for secure fields and secret-looking text; else the first few characters. */
export function typingChip(text: string, secure = false, show = 12): string {
  if (secure || looksSecret(text)) return 'Typing…'
  const line = text.split(/\r?\n/)[0] ?? ''
  const chars = Array.from(truncate(line, 1000))
  if (!chars.length) return 'Typing…'
  const head = chars.slice(0, show).join('')
  return `Typing “${head}${chars.length > show || text.includes('\n') ? '…' : ''}”`
}

/** Hides quoted text in a label that looks secret ('Typing "hunter2!X" into …'); all of it for secure fields. */
export function scrubLabel(label: string, secure = false): string {
  return label.replace(/(["“'‘])([^"”'’]*)(["”'’])/g, (m, a: string, inner: string, b: string) => (secure || looksSecret(inner) ? `${a}•••${b}` : m))
}

const MOD_GLYPH: Record<string, string> = { ctrl: '⌃', control: '⌃', option: '⌥', opt: '⌥', alt: '⌥', shift: '⇧', cmd: '⌘', command: '⌘', meta: '⌘' }
const MOD_ORDER = ['⌃', '⌥', '⇧', '⌘']
const KEY_GLYPH: Record<string, string> = {
  return: '↩', enter: '↩', escape: '⎋', esc: '⎋', tab: '⇥', space: 'Space', delete: '⌫', backspace: '⌫',
  forwarddelete: '⌦', up: '↑', down: '↓', left: '←', right: '→', home: '↖', end: '↘', pageup: '⇞', pagedown: '⇟', plus: '+', minus: '-'
}

/** "cmd+shift+t" → "⇧⌘T" (Mac order: ⌃⌥⇧⌘). */
export function keyGlyphs(keys: string): string {
  const parts = keys.toLowerCase().split(/[+\s]+/).filter(Boolean)
  const mods = new Set<string>()
  const rest: string[] = []
  for (const p of parts) {
    if (MOD_GLYPH[p]) mods.add(MOD_GLYPH[p])
    else rest.push(KEY_GLYPH[p] ?? (Array.from(p).length <= 3 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
  }
  return truncate(MOD_ORDER.filter((m) => mods.has(m)).join('') + rest.join(''), 16)
}

/** What the pill says when computer.ts gives no label. */
export function defaultLabel(a: OverlayAction): string {
  switch (a.kind) {
    case 'move': return 'Moving the pointer'
    case 'click': return a.button === 'right' ? 'Right-clicking' : a.count === 2 ? 'Double-clicking' : (a.count ?? 1) >= 3 ? 'Triple-clicking' : 'Clicking'
    case 'drag': return 'Dragging'
    case 'scroll': return a.dy < 0 ? 'Scrolling down' : 'Scrolling up'
    case 'type': return a.secure ? 'Typing in a secure field' : 'Typing'
    case 'key': return `Pressing ${keyGlyphs(a.keys)}`
    case 'focus': return 'Looking here'
    case 'status': return a.label
    case 'done': return ''
  }
}

/** The pill text for a step: its label (or a default), one line, short, secrets hidden. */
export function pillLabel(a: OverlayAction): string {
  const secure = a.kind === 'type' && (!!a.secure || looksSecret(a.text))
  const raw = 'label' in a && a.label ? a.label : defaultLabel(a)
  return truncate(scrubLabel(raw, secure)) || truncate(defaultLabel(a))
}

const inflate = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m })
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Where the status pill sits: bottom-center of the display (above the Dock), or top-center (below the
 * menu bar) when the step acts near the bottom spot, so the real click never lands on the Stop pill.
 */
export function pillRect(d: Pick<DisplayInfo, 'bounds'>, avoid: Array<Point | Rect> = []): { rect: Rect; edge: 'top' | 'bottom' } {
  const b = d.bounds
  const width = Math.min(PILL.width, Math.max(160, b.width - 32))
  const x = Math.round(b.x + (b.width - width) / 2)
  const bottom: Rect = { x, y: Math.round(b.y + b.height - 104 - PILL.height), width, height: PILL.height }
  const top: Rect = { x, y: Math.round(b.y + 44), width, height: PILL.height }
  const hits = (r: Rect): boolean => avoid.some((p) => ('width' in p ? overlaps(inflate(r, 24), p) : contains(inflate(r, 32), p.x, p.y)))
  if (!hits(bottom)) return { rect: bottom, edge: 'bottom' }
  if (!hits(top)) return { rect: top, edge: 'top' }
  return { rect: bottom, edge: 'bottom' }
}

/** One step for the page to draw (global points; each window subtracts its own origin). */
export interface OverlayFrame {
  seq: number
  kind: 'move' | 'click' | 'drag' | 'scroll' | 'type' | 'key' | 'focus' | 'status'
  /** Where the cursor glides from and to (absent: the cursor stays where it is). */
  from?: Point
  to?: Point
  /** Drag end. */
  to2?: Point
  moveMs: number
  /** How long the effect after arriving plays (ripple, trail, scroll arrows, key chip). */
  tailMs: number
  button?: 'left' | 'right'
  count?: number
  dy?: number
  /** Typing chip text (already masked) or the key glyphs. */
  chip?: string
  box?: Rect
  label: string
  hint: string
  pill: { displayId: number; rect: Rect }
  reduceMotion: boolean
}

/** What the controller draws on (the Electron windows; a fake in tests). */
export interface OverlayHost {
  render(f: OverlayFrame): void
  hide(): void
  /** The real mouse position: the first glide of a run starts there. */
  cursor(): Point | undefined
  displays(): DisplayInfo[]
  reduceMotion(): boolean
}

/** Rough length of the effect played after the cursor arrives. */
export function tailDuration(a: OverlayAction, reduceMotion: boolean): number {
  switch (a.kind) {
    case 'click': return reduceMotion ? 160 : CLICK_MS + Math.max(0, Math.min(3, a.count ?? 1) - 1) * 110
    case 'drag': return reduceMotion ? 0 : Math.round(Math.min(650, Math.max(260, Math.hypot(a.x2 - a.x, a.y2 - a.y) * 0.6)))
    case 'scroll': return reduceMotion ? 300 : 650
    case 'key': return 900
    case 'focus': return 1400
    default: return 0
  }
}

const targetOf = (a: OverlayAction): Point | undefined => {
  switch (a.kind) {
    case 'move': case 'click': case 'drag': case 'scroll': return { x: a.x, y: a.y }
    case 'type': return a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : undefined
    default: return undefined
  }
}

/** Whether a newer step makes a queued (not yet shown) one pointless. Clicks, drags, typing and keys always play. */
export function supersedes(next: OverlayAction, pending: OverlayAction): boolean {
  if (pending.kind === 'status') return next.kind !== 'done'
  if (pending.kind === 'move') return !!targetOf(next)
  if (pending.kind === 'focus') return next.kind === 'focus'
  return false
}

export interface ControllerOptions {
  /** Hide everything after this long without a step (a safety net: computer.ts/index.ts call hide()). */
  idleHideMs?: number
  /** show() never waits longer than this, whatever the animation. */
  maxWaitMs?: number
}

/**
 * Plays steps in order. show() resolves once the cursor has arrived (the move animation), so the real
 * event lands as it gets there. Queued steps a newer one supersedes (pointer moves, status text) are
 * dropped; with a backlog, glides run at half length so the cursor catches up instead of lagging.
 */
export class OverlayController implements Overlay {
  private pos: Point | undefined
  private queue: Array<{ a: OverlayAction; resolve: () => void }> = []
  private running = false
  private seq = 0
  private idle: ReturnType<typeof setTimeout> | null = null
  private shown = false
  private readonly idleHideMs: number
  private readonly maxWaitMs: number

  constructor(private host: OverlayHost | null, o: ControllerOptions = {}) {
    this.idleHideMs = o.idleHideMs ?? 90_000
    this.maxWaitMs = o.maxWaitMs ?? 1200
  }

  get visible(): boolean { return this.shown }
  /** Where the SahilBot cursor is (global points), if it is showing. */
  get position(): Point | undefined { return this.pos }

  show(a: OverlayAction): Promise<void> {
    if (!this.host) return Promise.resolve()
    if (a.kind === 'done') { this.hide(); return Promise.resolve() }
    return new Promise<void>((resolve) => {
      this.queue = this.queue.filter((q) => { if (supersedes(a, q.a)) { q.resolve(); return false } return true })
      this.queue.push({ a, resolve })
      void this.pump()
    })
  }

  hide(): void {
    for (const q of this.queue) q.resolve()
    this.queue = []
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    this.pos = undefined
    if (this.shown) { this.shown = false; try { this.host?.hide() } catch { /* window gone */ } }
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!
        let wait = 0
        try { wait = this.play(item.a, this.queue.length) } catch { wait = 0 }
        if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, this.maxWaitMs)))
        item.resolve()
      }
    } finally {
      this.running = false
    }
  }

  /** Draws one step; returns how long show() should wait (the glide). */
  private play(a: OverlayAction, backlog: number): number {
    const host = this.host!
    if (a.kind === 'done') return 0
    const ds = host.displays()
    if (!ds.length) return 0
    const reduce = !!host.reduceMotion()
    const target = targetOf(a)
    const from = this.pos ?? (target ? host.cursor() ?? target : undefined)
    let moveMs = target ? moveDuration(from, target, reduce) : 0
    if (backlog >= 2) moveMs = Math.round(moveMs / 2)
    const to2 = a.kind === 'drag' ? { x: a.x2, y: a.y2 } : undefined
    const box = a.kind === 'focus' ? { x: a.x, y: a.y, width: a.w, height: a.h } : undefined
    const anchor = target ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined) ?? this.pos ?? host.cursor() ?? { x: ordered(ds)[0].bounds.x + 1, y: ordered(ds)[0].bounds.y + 1 }
    const disp = displayFor(ds, anchor) ?? ordered(ds)[0]
    const avoid: Array<Point | Rect> = [anchor, ...(to2 ? [to2] : []), ...(box ? [box] : [])]
    const pill = pillRect(disp, avoid)
    const frame: OverlayFrame = {
      seq: ++this.seq,
      kind: a.kind,
      from: target ? from : undefined,
      to: target,
      to2,
      moveMs,
      tailMs: tailDuration(a, reduce),
      button: a.kind === 'click' ? a.button ?? 'left' : undefined,
      count: a.kind === 'click' ? Math.max(1, Math.min(3, a.count ?? 1)) : undefined,
      dy: a.kind === 'scroll' ? a.dy : undefined,
      chip: a.kind === 'type' ? typingChip(a.text, a.secure) : a.kind === 'key' ? keyGlyphs(a.keys) : undefined,
      box,
      label: pillLabel(a),
      hint: STOP_HINT,
      pill: { displayId: disp.id, rect: pill.rect },
      reduceMotion: reduce
    }
    host.render(frame)
    this.shown = true
    if (to2) this.pos = to2
    else if (target) this.pos = target
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.hide(), this.idleHideMs)
    return moveMs
  }
}

// ------------------------------------------------------------------------------------------------
// The browser panel's in-page cursor: CSS only (inserted with webContents.insertCSS), so it adds no
// DOM nodes (the page's MutationObserver and the agent's "page changed" check never see it) and page
// scripts can't touch it. Points are CSS pixels of the page's viewport.

const CURSOR_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='30' viewBox='0 0 26 30'><path d='M3 2 L3 22 L8.6 17.4 L12.3 26 L16 24.4 L12.4 16 L20 16 Z' fill='%23FF6A1A' stroke='white' stroke-width='2' stroke-linejoin='round'/><circle cx='21' cy='24' r='4.6' fill='%2317120F' stroke='white' stroke-width='1.6'/><circle cx='19.6' cy='24' r='0.9' fill='white'/><circle cx='22.4' cy='24' r='0.9' fill='white'/></svg>`

/** CSS for one in-page cursor step: glide from→to, then a pulse on the element box (click) or a "Typing…" tag. */
export function pageCursorCss(o: { id: string; from: Point; to: Point; box?: Rect; moveMs: number; kind: 'click' | 'type'; reduceMotion?: boolean }): string {
  const n = (v: number): string => `${Math.round(Number.isFinite(v) ? v : 0)}px`
  const id = o.id.replace(/[^a-z0-9_-]/gi, '')
  const ms = o.reduceMotion ? 0 : Math.max(0, Math.round(o.moveMs))
  const box = o.box
  const label = o.kind === 'type' ? "content: 'Typing…' !important; padding: 7px 11px 7px 30px !important; color: #fff !important; font: 600 11px/16px -apple-system, system-ui, sans-serif !important; background-color: rgba(23,18,15,.88) !important; border-radius: 4px 15px 15px 15px !important; width: auto !important; height: auto !important; white-space: nowrap !important;" : "content: '' !important; width: 26px !important; height: 30px !important;"
  return `@keyframes sb-glide-${id} { from { transform: translate(${n(o.from.x)}, ${n(o.from.y)}); } to { transform: translate(${n(o.to.x)}, ${n(o.to.y)}); } }
@keyframes sb-pulse-${id} { 0% { box-shadow: 0 0 0 0 rgba(255,106,26,.55); opacity: 1; } 70% { box-shadow: 0 0 0 10px rgba(255,106,26,0); opacity: 1; } 100% { box-shadow: 0 0 0 12px rgba(255,106,26,0); opacity: 0; } }
html::after { ${label} position: fixed !important; left: -3px !important; top: -2px !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;
  background-image: url("data:image/svg+xml;utf8,${CURSOR_SVG}") !important; background-repeat: no-repeat !important; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)) !important;
  transform: translate(${n(o.to.x)}, ${n(o.to.y)}); animation: sb-glide-${id} ${ms}ms cubic-bezier(.22,.8,.26,1) both !important; }
${box ? `html::before { content: '' !important; position: fixed !important; z-index: 2147483646 !important; pointer-events: none !important; display: block !important;
  left: ${n(box.x - 3)} !important; top: ${n(box.y - 3)} !important; width: ${n(box.width + 6)} !important; height: ${n(box.height + 6)} !important;
  border: 2px solid rgba(255,106,26,.9) !important; border-radius: 6px !important; box-sizing: border-box !important; background: rgba(255,106,26,.07) !important;
  animation: sb-pulse-${id} ${o.kind === 'click' ? CLICK_MS * 3 : 1600}ms ease-out ${ms}ms both !important; }` : ''}`
}
