import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef, ToolContext, ToolOutput } from '../types'
import { buildSnapshot, byRef, describeChange, elementAt, formatSnapshot, guardAction, isSecure, redactClipboard, relocate, sameState, selfTarget, settingsStop, short, type AxElement, type AxSnapshot, type Guard, type RawSnapshot, type SelfInfo, type UiState } from '../../computer/ax'
import { chooseInputMethod, describeRestore, jxaClipboard, textLanded, withTemporaryClipboard, type ClipboardIO, type InputMethod, type JxaRunner } from '../../computer/clipboard'
import { center, clipToDisplays, describeDisplays, displayAt, displayByNumber, fitImage, imageLimits, makeFrame, ordered, toScreen, type DisplayInfo, type Frame, type Rect } from '../../computer/geometry'
import { parseCombo, riskyCombo, type KeyCombo } from '../../computer/keys'
import { noOverlay, type Overlay, type OverlayAction } from '../../computer/overlay'
import { ACTIVATE, APPS, ELEMENT, KEY, MENU, MOUSE, QUIT, SNAPSHOT, STATE, TYPE, VALUE, WINDOWS, wrap } from '../../computer/scripts'
import { waitForSettle } from '../../computer/settle'
import { type ActionRecord, detectStall, recordOf, stallNote } from '../cua/stall'

// Computer use: SahilBot sees the screen and drives the Mac like a person would, for apps that have no
// other tool. Accessibility first: `ui` reads the app's windows through the macOS Accessibility API and
// gives every button, field and item a ref (e1, e2…); actions target refs (click_ref, type_ref,
// set_value, press) and fall back to coordinates. Every action reads the screen state before and after,
// waits for the UI to settle, and reports what changed (or that nothing did).
// Screenshots: macOS `screencapture` (Screen Recording permission), of a display, a window or a region,
// sized for the model; each records how its pixels map to screen points (Retina, several displays).
// Input: CoreGraphics events and System Events (Accessibility permission).
// Safety: one OK per task (per chat); quitting apps and risky shortcuts always ask; password fields,
// system password/Touch ID prompts, Apple Pay sheets and buy/subscribe buttons are handed to the user.
// The mini window's Stop and Ctrl+Option+Esc stop the run (the abort signal is checked between steps).
// Text: short plain ASCII is typed; long, multi-line or non-ASCII text is pasted (the user's clipboard is
// saved and put back) and every entry is checked against the field's value afterwards.
// The visible cursor (overlay.ts) is shown right before every real pointer or keyboard event, with a
// status line per step; it is hidden when the run stops or computer use goes idle.

type Action =
  | 'screenshot' | 'zoom' | 'ui' | 'apps' | 'windows' | 'wait' | 'wait_for' | 'clipboard_read'
  | 'click' | 'double_click' | 'triple_click' | 'right_click' | 'move' | 'drag' | 'scroll' | 'type' | 'key'
  | 'click_ref' | 'type_ref' | 'set_value' | 'press' | 'click_element'
  | 'open_app' | 'activate_app' | 'quit_app' | 'focus_window' | 'menu' | 'clipboard_write'
  | 'paste_text' | 'copy' | 'select_all'

type Args = {
  action: Action
  ref?: string; ref2?: string
  x?: number; y?: number; x2?: number; y2?: number
  /** x/y are pixels of the latest screenshot (default once there is one) or global screen points. */
  coords?: 'screenshot' | 'screen'
  amount?: number; dx?: number
  text?: string; clear?: boolean; submit?: boolean
  /** type/type_ref: type key by key, paste, or choose (default). */
  method?: 'auto' | 'type' | 'paste'
  /** copy: put the user's clipboard back after reading what was copied. */
  restore?: boolean
  keys?: string
  /** key: press the combination this many times (Tab ×4, Down ×3). */
  repeat?: number
  /** wait_for: wait until the query's text is gone instead of shown. */
  gone?: boolean
  /** Held during a click: "cmd", "shift", "cmd+shift"… */
  modifiers?: string
  app?: string
  /** A window: its ref from `windows` (w3) or part of its title. */
  window?: string
  display?: number
  region?: number[]
  /** set_value: the new value. */
  value?: string
  /** press: the AX action (AXPress, AXShowMenu, AXIncrement, AXDecrement, AXConfirm, AXCancel, AXPick, AXRaise). */
  ax_action?: string
  /** ui: only elements whose name/value contains this. */
  query?: string
  /** click_element (older form): element name and role. */
  name?: string; role?: string
  /** menu: "File > Export > Export as PDF…". */
  path?: string
  seconds?: number
}

export interface ComputerDeps {
  /** Shrink SahilBot to a small window in the corner while it works (once per task). */
  enterMini(threadId: string): void
  /**
   * Screenshot. With rect (global points): that area, resized to width×height pixels. Without: the main
   * display scaled to points. PNG data URL plus the image size.
   */
  capture(file: string, opts?: { rect?: Rect; width?: number; height?: number }): Promise<{ dataUrl: string; width: number; height: number }>
  /** Accessibility permission (macOS shows its prompt when asked). */
  trusted(prompt: boolean): boolean
  /** How often (ms) the Accessibility card checks for the switch, and how long it waits (tests shorten both). */
  axPoll?: { everyMs?: number; timeoutMs?: number }
  /** Displays in global points (Electron's screen); optional so older callers still work. */
  displays?(): DisplayInfo[]
  /** SahilBot's own processes and windows: never clicked, typed into or driven by computer use. */
  self?(): SelfInfo
  /** The visible cursor: every pointer and keyboard step is shown on it first (default: none). */
  overlay?: Overlay
  /** Runs a JXA function with JSON input (default: osascript). Tests pass a fake. */
  osa?: JxaRunner
  /** The clipboard (default: the real pasteboard through JXA). Tests pass a fake. */
  clipboard?: ClipboardIO
}

/** What other tools (the app tool) use to drive the Mac through computer use, with its guards and cursor. */
export interface ComputerControl {
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>
  /** The chat already said OK to computer use for this task. */
  isGranted(threadId: string): boolean
  /** The run is over: shows "done" on the cursor and hides it. */
  finish(): void
}

let current: ComputerControl | undefined
/** The computer tool registered in this app, for tools built on top of it. */
export const computerControl = (): ComputerControl | undefined => current

const READ = new Set<Action>(['screenshot', 'zoom', 'ui', 'apps', 'windows', 'wait', 'wait_for', 'clipboard_read'])
/** Acting actions that can't change a setting by themselves (no System Settings hard stop). */
const NAVIGATE = new Set<Action>(['open_app', 'activate_app', 'focus_window', 'move', 'scroll', 'copy', 'select_all', 'clipboard_write'])
/** Opening an app or bringing it to the front: works without Accessibility. */
const OPENS = new Set<Action>(['open_app', 'activate_app'])
/** How long computer use stays idle before the cursor is put away. */
const IDLE_MS = 20_000
/** Apps SahilBot never quits (itself, and parts of macOS). */
const NO_QUIT = /^(sahilbot|electron|finder|dock|systemuiserver|windowserver|loginwindow|controlcenter|notificationcenter)$/i
/** Menu items that always ask, even mid-task. */
const RISKY_MENU = /^(quit|force quit|log out|shut down|restart|sleep|lock screen|empty trash|erase|delete (all|account|permanently)|secure empty trash|close all)/i
/** The Accessibility card in the chat (the app adds the one-tap button that opens the switch). */
export const AX_CARD = 'To click, type and read other apps for you, SahilBot needs Accessibility. Tap the button, turn on SahilBot in the list, and this task carries on by itself.'
/** What the model is told when Accessibility stays off: one stable line, so it explains instead of retrying or guessing. */
export const AX_OFF = 'Accessibility permission is off, so SahilBot can\'t click, type or read other apps yet.'
const MOD_FLAGS: Record<string, number> = { cmd: 0x100000, command: 0x100000, shift: 0x20000, option: 0x80000, alt: 0x80000, opt: 0x80000, ctrl: 0x40000, control: 0x40000 }

function sh(cmd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((ok, fail) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => (e ? fail(new Error((err || e.message).toString().trim().slice(0, 400))) : ok(out.toString()))))
}

/** Runs a JXA function with JSON input (never string-spliced into the script). */
const osascriptJxa: JxaRunner = async (fn, input, timeout) => {
  const out = await sh('osascript', ['-l', 'JavaScript', '-e', wrap(fn), JSON.stringify(input ?? {})], timeout)
  return JSON.parse(out || 'null')
}

/** Modifier flags for a click ("cmd+shift" → CGEvent flags). */
export function clickFlags(mods?: string): number {
  if (!mods) return 0
  let f = 0
  for (const m of mods.toLowerCase().split(/[+\s,]+/).filter(Boolean)) {
    if (MOD_FLAGS[m] === undefined) throw new Error(`Unknown modifier "${m}". Use cmd, shift, option or ctrl.`)
    f |= MOD_FLAGS[m]
  }
  return f
}

/** Splits text for typing: short chunks so apps don't drop characters, never splitting a surrogate pair. */
export function typingChunks(text: string, size = 60): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, width: r.width + 2 * p, height: r.height + 2 * p })

type ValueRead = { none?: boolean; role?: string; secure?: boolean; value?: string; selected?: number; x?: number; y?: number; w?: number; h?: number }

export function computerTool(d: ComputerDeps): ToolDef<Args> & { control: ComputerControl } {
  const jxa = <T = unknown>(fn: string, input: unknown, timeout = 20_000): Promise<T> => (d.osa ?? osascriptJxa)(fn, input ?? {}, timeout) as Promise<T>
  let clipIO: ClipboardIO | undefined
  const clip = (): ClipboardIO => (clipIO ??= d.clipboard ?? jxaClipboard((fn, input, t) => jxa(fn, input, t)))
  const overlay = d.overlay ?? noOverlay
  /** The latest read of what's in front (any chat): System Settings hard stops for coordinate actions. */
  let lastFront: UiState | undefined

  // One OK per task: after the first approved action in a chat, control continues until it's idle for 15 min.
  const granted = new Map<string, number>()
  const isGranted = (threadId: string): boolean => (granted.get(threadId) ?? 0) > Date.now() - 15 * 60_000
  /** Per chat: the last ui snapshot (refs), the last screenshot's frame, the last windows list. */
  const snapshots = new Map<string, AxSnapshot>()
  const frames = new Map<string, Frame>()
  const windowLists = new Map<string, Array<{ ref: string; app: string; pid?: number; index: number; title: string; rect?: Rect }>>()

  const alive = (ctx: ToolContext): void => { if (ctx.signal.aborted) throw new DOMException('Stopped by the user.', 'AbortError') }
  const displays = (): DisplayInfo[] => { try { return d.displays?.() ?? [] } catch { return [] } }

  const probe = async (target?: { pid?: number; path: number[] }): Promise<UiState> => {
    const s = await jxa<UiState>(STATE, { target })
    if (s && typeof s === 'object') lastFront = s
    return s
  }

  // ------------------------------------------------------------------ the visible cursor
  let idle: ReturnType<typeof setTimeout> | undefined
  let showing = false
  const watched = new WeakSet<AbortSignal>()

  /**
   * Shows a step on the cursor, right before the real event. Never blocks a step for long or fails it:
   * the cursor is there so the user can follow along, not part of the action. A Stop pressed while it
   * animates is honoured before the event goes out.
   */
  async function show(ctx: ToolContext, step: OverlayAction): Promise<void> {
    if (!watched.has(ctx.signal)) {
      watched.add(ctx.signal)
      ctx.signal.addEventListener('abort', () => finish(), { once: true })
    }
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => finish(), IDLE_MS)
    idle.unref?.()
    showing = true
    let t: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([overlay.show(step), new Promise<void>((r) => { t = setTimeout(r, 1500); t.unref?.() })])
    } catch { /* the cursor never fails a step */ } finally {
      if (t) clearTimeout(t)
    }
    alive(ctx)
  }

  /** The run is over (stopped, or idle): "done" on the cursor, then hide it. */
  function finish(): void {
    if (idle) { clearTimeout(idle); idle = undefined }
    if (!showing) return
    showing = false
    let t: ReturnType<typeof setTimeout> | undefined
    void Promise.race([Promise.resolve().then(() => overlay.show({ kind: 'done' })), new Promise<void>((r) => { t = setTimeout(r, 1500); t.unref?.() })])
      .catch(() => undefined)
      .finally(() => { if (t) clearTimeout(t); try { overlay.hide() } catch { /* nothing to hide */ } })
  }

  /** A short, non-secret status line for a step. */
  const statusLabel = (a: Args): string => {
    const el = a.ref ? elLabel(a.ref) : ''
    switch (a.action) {
      case 'screenshot': return 'Looking at the screen'
      case 'zoom': return 'Zooming in'
      case 'wait_for': return a.query ? `Waiting for "${a.query.slice(0, 40)}"` : 'Waiting for the screen to settle'
      case 'ui': return `Reading ${a.app ?? 'the app in front'}`
      case 'apps': return 'Checking which apps are open'
      case 'windows': return 'Listing windows'
      case 'wait': return 'Waiting'
      case 'clipboard_read': return 'Reading the clipboard'
      case 'clipboard_write': return 'Copying to the clipboard'
      case 'copy': return 'Copying the selection'
      case 'select_all': return `Selecting all${el ? ` in ${el}` : ''}`
      case 'type': case 'type_ref': case 'paste_text': return `Typing${el ? ` into ${el}` : ''}`
      case 'set_value': return `Setting ${el || 'a value'}`
      case 'click_ref': case 'press': return `Clicking ${el || 'an element'}`
      case 'click_element': return `Clicking "${(a.name ?? '').slice(0, 40)}"`
      case 'key': return `Pressing ${a.keys}`
      case 'menu': return `Choosing ${(a.path ?? '').slice(0, 60)}`
      case 'open_app': return `Opening ${a.app}`
      case 'activate_app': return `Switching to ${a.app}`
      case 'quit_app': return `Quitting ${a.app}`
      case 'focus_window': return 'Bringing a window forward'
      case 'drag': return 'Dragging'
      case 'scroll': return 'Scrolling'
      default: return a.action.replace('_', ' ')
    }
  }
  const elLabel = (ref: string): string => { const e = byRef(snapshotsAny(ref), ref); return e ? `"${e.label.slice(0, 40)}"` : '' }
  const snapshotsAny = (ref: string): AxSnapshot | undefined => { for (const s of snapshots.values()) if (byRef(s, ref)) return s; return undefined }
  const mid = (r?: { x?: number; y?: number; w?: number; h?: number }): { x: number; y: number } | undefined =>
    r && r.x !== undefined && r.y !== undefined && r.w !== undefined && r.h !== undefined ? center({ x: r.x, y: r.y, width: r.w, height: r.h }) : undefined
  /** Text for the cursor's typing bubble: never anything that looks like a secret. */
  const bubble = (text: string): string => { const r = redactClipboard(text); return r.text.length > 200 ? `${r.text.slice(0, 199)}…` : r.text }

  /**
   * Refuses any action that would land on SahilBot itself: its process (or helpers), its app name, its
   * window titles, or a point on one of its windows (the mini window with Stop included).
   */
  async function notSelf(a: Args, tid: string): Promise<void> {
    let self: SelfInfo | undefined
    try { self = d.self?.() } catch { self = undefined }
    if (!self) return
    const why: Array<string | null> = []
    const snap = snapshots.get(tid)
    const el = a.ref ? byRef(snap, a.ref) : undefined
    const el2 = a.ref2 ? byRef(snap, a.ref2) : undefined
    if (['click_ref', 'press', 'type_ref', 'set_value'].includes(a.action) || (a.ref && ['click', 'double_click', 'triple_click', 'right_click', 'move', 'drag', 'scroll', 'paste_text', 'copy', 'select_all'].includes(a.action))) {
      why.push(selfTarget(self, { app: snap?.app, pid: snap?.pid, window: el?.window }))
      if (el?.rect) why.push(selfTarget(self, { point: center(el.rect) }))
      if (el2?.rect) why.push(selfTarget(self, { point: center(el2.rect) }))
    }
    if (['click', 'double_click', 'triple_click', 'right_click', 'move', 'drag', 'scroll'].includes(a.action) && !a.ref && a.x !== undefined && a.y !== undefined) {
      try { why.push(selfTarget(self, { point: pointOf(tid, a, 1) })) } catch { /* reported by the action */ }
      if (a.action === 'drag' && a.x2 !== undefined) { try { why.push(selfTarget(self, { point: pointOf(tid, a, 2) })) } catch { /* reported by the action */ } }
    }
    if (['open_app', 'activate_app', 'quit_app', 'ui', 'click_element', 'menu', 'focus_window'].includes(a.action) && a.app) why.push(selfTarget(self, { app: a.app }))
    if (a.action === 'focus_window' && a.window) {
      const w = /^w\d+$/i.test(a.window.trim()) ? windowLists.get(tid)?.find((x) => x.ref === a.window!.trim().toLowerCase()) : undefined
      why.push(w ? selfTarget(self, { app: w.app, pid: w.pid }) : selfTarget(self, { window: a.window }))
    }
    if (a.action === 'ui' && a.window && /^w\d+$/i.test(a.window.trim())) {
      const w = windowLists.get(tid)?.find((x) => x.ref === a.window!.trim().toLowerCase())
      if (w) why.push(selfTarget(self, { app: w.app, pid: w.pid }))
    }
    // Keystrokes and menu choices go to the app in front.
    if (['type', 'key', 'menu', 'click_element', 'paste_text', 'copy', 'select_all'].includes(a.action) && !a.app && !a.ref) {
      const front = await probe().catch(() => undefined)
      if (front) why.push(selfTarget(self, { app: front.app }))
    }
    const hit = why.find(Boolean)
    if (hit) throw new Error(`${hit} Computer use never clicks, types into or drives SahilBot's own windows: its approval and purchase cards are only for the user. Work in the other app, or ask the user.`)
  }

  /** Reads state, runs the action, waits for the UI to settle, and says what changed. */
  async function verified(ctx: ToolContext, act: () => Promise<void>, o: { target?: { pid?: number; path: number[] }; before?: UiState; timeoutMs?: number } = {}): Promise<{ text: string; changed: boolean; after: UiState }> {
    const before = o.before ?? await probe(o.target).catch(() => undefined)
    alive(ctx)
    await act()
    const settled = await waitForSettle(() => probe(o.target), sameState, { timeoutMs: o.timeoutMs ?? 2500, intervalMs: 150, initialDelayMs: 120, signal: ctx.signal }).catch((e) => {
      if ((e as Error).name === 'AbortError') throw e
      return undefined
    })
    if (!settled) return { text: '(Couldn\'t read the screen state afterwards: check with ui or a screenshot.)', changed: true, after: before ?? { app: '', window: '', windows: 0, sheets: 0 } }
    if (!before) return { text: `Now: ${settled.state.app}${settled.state.window ? ` › "${settled.state.window}"` : ''}.`, changed: true, after: settled.state }
    const c = describeChange(before, settled.state)
    return { text: `${c.text}${settled.stable ? '' : ' (The screen was still changing when SahilBot stopped waiting; look again before the next step.)'}`, changed: c.changed, after: settled.state }
  }

  /** Recent actions per chat, for stall detection (agent/cua/stall.ts). */
  const recent = new Map<string, ActionRecord[]>()

  /**
   * Notes the action and, when the last few got nowhere (the same action again, nothing changing, errors, back
   * and forth), adds recovery steps to the result. In a Planner + executor run the planner's session does this.
   */
  function stallCheck(tid: string, input: Args, ctx: ToolContext, out: ToolOutput | undefined, error?: string): ToolOutput {
    const list = [...(recent.get(tid) ?? []), recordOf('computer', JSON.stringify(input), { status: error ? 'error' : 'ok', text: out?.text ?? error, display: out?.display })].slice(-10)
    recent.set(tid, list)
    if (!out) return out as unknown as ToolOutput
    if (ctx.state?.cua?.active) return out
    const st = detectStall(list, { computer: true })
    if (!st) return out
    // One hint per stall: the count starts over.
    recent.set(tid, [])
    return { ...out, text: `${out.text}\n\n${stallNote(st)}` }
  }

  /** Hands a step to the user: asks them to do it and waits (nobody there: the agent is told to stop that part). */
  async function handOff(g: Guard, ctx: ToolContext): Promise<ToolOutput> {
    const answer = await ctx.askUser(g.ask, ['Done', 'Skip it'])
    if (/^\(Nobody can answer/.test(answer)) return { text: `Not done: this step needs the user (${g.reason}), and nobody is here to do it. Don't try another way; leave it for the user and say so in your report.`, display: `left for you: ${g.kind}` }
    return { text: `Handed to the user (${g.reason}). They answered: "${answer.slice(0, 200)}". Don't do this step yourself. Check where things stand with ui or a screenshot, then carry on with the rest.`, display: `handed to you: ${g.kind}` }
  }

  /** The thread's snapshot, if it is recent and of the app in front. */
  const freshSnapshot = (tid: string, app?: string): AxSnapshot | undefined => {
    const s = snapshots.get(tid)
    return s && Date.now() - s.at < 120_000 && (!app || s.app === app) ? s : undefined
  }

  async function snapshot(tid: string, o: { app?: string; pid?: number; activate?: boolean; window?: number }): Promise<AxSnapshot> {
    const raw = await jxa<RawSnapshot>(SNAPSHOT, { app: o.app, pid: o.pid, activate: !!o.activate, window: o.window, max: 700, maxDepth: 14, maxWindows: 6, maxValue: 200 }, 45_000)
    if (raw?.error) throw new Error(raw.error === 'not running' ? `${o.app ?? 'That app'} isn't running. Open it with open_app first.` : raw.error)
    const snap = buildSnapshot(raw, snapshots.get(tid))
    snapshots.set(tid, snap)
    return snap
  }

  type ElementResult = { missing?: boolean; mismatch?: boolean; refused?: string; done?: boolean; error?: string; actions?: string[]; value?: string; secure?: boolean; x?: number; y?: number; w?: number; h?: number }

  /**
   * Runs an element operation on a ref. If the element moved (windows reordered, list changed), the app
   * is read again and the same element (role + label, nearest) is found; if it's gone, says so.
   */
  async function onElement(tid: string, ref: string, op: Record<string, unknown>): Promise<{ el: AxElement; snap: AxSnapshot; res: ElementResult }> {
    let snap = snapshots.get(tid)
    let el = byRef(snap, ref)
    if (!snap || !el) throw new Error(`No element ${ref} in the last ui snapshot. Read the app with ui first and use a ref from it.`)
    const run = (e: AxElement): Promise<ElementResult> => jxa<ElementResult>(ELEMENT, { pid: snap!.pid, path: e.path, expect: { role: e.role, name: e.name, desc: e.desc }, ...op })
    let res = await run(el)
    if (res.missing || res.mismatch) {
      snap = await snapshot(tid, { pid: snap.pid })
      const again = relocate(el, snap)
      if (!again) throw new Error(`${ref} (${short(el.role)} "${el.label}") is no longer on screen. Read the app again with ui.`)
      el = again
      res = await run(el)
      if (res.missing || res.mismatch) throw new Error(`${ref} (${short(el.role)} "${el.label}") keeps changing; read the app again with ui or use a screenshot.`)
    }
    return { el, snap, res }
  }

  /** Screen point for x,y (in the latest screenshot's pixels unless coords says screen) or a ref's center. */
  function pointOf(tid: string, a: Args, which: 1 | 2 = 1): { x: number; y: number; el?: AxElement } {
    const ref = which === 1 ? a.ref : a.ref2
    if (ref) {
      const el = byRef(snapshots.get(tid), ref)
      if (!el?.rect) throw new Error(`No element ${ref} with a position in the last ui snapshot. Read the app with ui first.`)
      return { ...center(el.rect), el }
    }
    const x = which === 1 ? a.x : a.x2
    const y = which === 1 ? a.y : a.y2
    if (x === undefined || y === undefined) throw new Error(which === 1 ? 'Give a ref from ui, or x and y.' : 'Give ref2, or x2 and y2, for where to drag to.')
    const f = frames.get(tid)
    const p = f && a.coords !== 'screen' ? toScreen(f, x, y) : { x, y }
    const ds = displays()
    if (ds.length && !displayAt(ds, p.x, p.y)) throw new Error(`(${Math.round(p.x)}, ${Math.round(p.y)}) is outside every screen. ${f && a.coords !== 'screen' ? `Coordinates are pixels of the last screenshot (${f.width}×${f.height}).` : ''}`)
    return { x: Math.round(p.x), y: Math.round(p.y) }
  }

  async function typeText(ctx: ToolContext, text: string): Promise<void> {
    for (const chunk of typingChunks(text)) {
      alive(ctx)
      await jxa(TYPE, { text: chunk })
      await sleep(20)
    }
  }

  /** One key or shortcut, shown on the cursor first. */
  async function pressKey(ctx: ToolContext, k: { code?: number; char?: string; using: string[] }, label: string): Promise<void> {
    await show(ctx, { kind: 'key', keys: label, label })
    await jxa(KEY, { code: k.code, char: k.char, using: k.using })
  }

  /** A mouse event, shown on the cursor first. */
  async function mouse(ctx: ToolContext, m: { kind: string; x: number; y: number; x2?: number; y2?: number; flags?: number; dy?: number; dx?: number }, label?: string): Promise<void> {
    const step: OverlayAction = m.kind === 'move' ? { kind: 'move', x: m.x, y: m.y, label }
      : m.kind === 'drag' ? { kind: 'drag', x: m.x, y: m.y, x2: m.x2!, y2: m.y2!, label }
        : m.kind === 'scroll' ? { kind: 'scroll', x: m.x, y: m.y, dy: m.dy ?? 0, label }
          : { kind: 'click', x: m.x, y: m.y, button: m.kind === 'right' ? 'right' : 'left', count: m.kind === 'triple' ? 3 : m.kind === 'double' ? 2 : 1, label }
    await show(ctx, step)
    await jxa(MOUSE, m)
  }

  const readValue = (target?: { pid?: number; path: number[] }): Promise<ValueRead | undefined> => jxa<ValueRead>(VALUE, { target }, 10_000).then((v) => (v && typeof v === 'object' ? v : undefined)).catch(() => undefined)

  /** After cmd+v: waits until the field shows the text (or a short while if it can't be read), so the clipboard isn't put back before the app took it. */
  async function waitLanded(ctx: ToolContext, before: string | undefined, text: string, target?: { pid?: number; path: number[] }): Promise<'yes' | 'no' | 'unknown'> {
    const start = Date.now()
    let last: 'yes' | 'no' | 'unknown' = 'unknown'
    while (Date.now() - start < 1500) {
      await sleep(100)
      alive(ctx)
      const now = await readValue(target)
      last = textLanded(before, now?.value, text)
      if (last === 'yes') { await sleep(60); return 'yes' }
      if (last === 'unknown' && Date.now() - start >= 400) return 'unknown'
    }
    return last
  }

  type Entered = { refused?: boolean; how: InputMethod; why: string; landed: 'yes' | 'no' | 'unknown'; clipboard: string }

  /**
   * Types or pastes text into the focused element (target: the element it should be, for the value
   * check). Refuses password fields. Pasting saves and restores the user's clipboard; afterwards the
   * field's value is read to check the text landed. A paste that visibly didn't land is retyped when the
   * text is plain ASCII on one line (some fields block paste).
   */
  async function enterText(ctx: ToolContext, text: string, o: { method?: Args['method']; target?: { pid?: number; path: number[] }; point?: { x: number; y: number }; label: string; secretLabel?: boolean }): Promise<Entered> {
    const choice = chooseInputMethod(text, o.method ?? 'auto')
    const before = await readValue(o.target)
    if (before?.secure) return { refused: true, how: choice.method, why: choice.why, landed: 'unknown', clipboard: '' }
    const at = mid(before) ?? o.point
    // The cursor's typing chip shows no text unless the field is confirmed not to be a password field.
    const secure = !before || !!before.none || !!o.secretLabel
    const chip = (): OverlayAction => ({ kind: 'type', x: at?.x, y: at?.y, text: secure ? '' : bubble(text), label: o.label, secure })
    await show(ctx, chip())
    if (choice.method === 'type') {
      await typeText(ctx, text)
      const after = await readValue(o.target)
      return { how: 'type', why: choice.why, landed: textLanded(before?.value, after?.value, text), clipboard: '' }
    }
    const r = await withTemporaryClipboard(clip(), text, async () => {
      alive(ctx)
      await jxa(KEY, { char: 'v', using: ['command down'] })
      return waitLanded(ctx, before?.value, text, o.target)
    })
    let landed = r.result
    let why = choice.why
    if (landed === 'no' && (o.method ?? 'auto') === 'auto' && /^[\x20-\x7e]{1,400}$/.test(text)) {
      await show(ctx, chip())
      await typeText(ctx, text)
      landed = textLanded(before?.value, (await readValue(o.target))?.value, text)
      return { how: 'type', why: 'the paste didn\'t land, so it was typed instead', landed, clipboard: describeRestore(r.restore, r.error) }
    }
    return { how: 'paste', why, landed, clipboard: describeRestore(r.restore, r.error) }
  }

  const landedNote = (e: Entered): string => e.landed === 'yes' ? 'The field shows the text.' : e.landed === 'no' ? 'The field\'s value doesn\'t show the text: it may have gone elsewhere or been changed by the app. Check with ui or a screenshot.' : 'This app doesn\'t expose the field\'s text, so check it with a screenshot (or ui).'

  async function windowsList(tid: string, app?: string): Promise<Array<{ ref: string; app: string; pid?: number; index: number; title: string; rect?: Rect; front?: boolean; minimized?: boolean }>> {
    const r = await jxa<Array<{ app: string; pid?: number; index: number; title: string; x?: number; y?: number; w?: number; h?: number; front?: boolean; minimized?: boolean }>>(WINDOWS, { app }, 30_000)
    const list = (r ?? []).map((w, i) => ({ ref: `w${i + 1}`, app: w.app, pid: w.pid, index: w.index, title: w.title, front: w.front, minimized: w.minimized, rect: w.x !== undefined && w.w !== undefined ? { x: w.x, y: w.y!, width: w.w, height: w.h! } : undefined }))
    windowLists.set(tid, list)
    return list
  }

  /** A window by ref (w3) from the last windows list, or by title (and app). */
  async function findWindow(tid: string, want: string, app?: string): Promise<{ ref: string; app: string; pid?: number; index: number; title: string; rect?: Rect }> {
    const byRefW = /^w\d+$/i.test(want.trim()) ? windowLists.get(tid)?.find((w) => w.ref === want.trim().toLowerCase()) : undefined
    if (byRefW) return byRefW
    const list = await windowsList(tid, app)
    const q = want.toLowerCase()
    const hit = list.find((w) => w.title.toLowerCase() === q) ?? list.find((w) => w.title.toLowerCase().includes(q)) ?? list.find((w) => w.app.toLowerCase() === q)
    if (!hit) throw new Error(`No window matching "${want}". List them with the windows action.`)
    return hit
  }

  async function screenshot(a: Args, ctx: ToolContext): Promise<ToolOutput> {
    const tid = ctx.threadId
    const ds = displays()
    let rect: Rect | undefined
    let what = 'the main display'
    let zoom = false
    if (a.ref) {
      const el = byRef(snapshots.get(tid), a.ref)
      if (!el?.rect) throw new Error(`No element ${a.ref} with a position in the last ui snapshot.`)
      rect = pad(el.rect, 40); what = `${short(el.role)} "${el.label}" and around it`; zoom = true
    } else if (a.window) {
      const w = await findWindow(tid, a.window, a.app)
      if (!w.rect) throw new Error(`The window "${w.title}" has no readable position; take a full screenshot instead.`)
      rect = w.rect; what = `the ${w.app} window "${w.title}"`; zoom = true
    } else if (a.region) {
      const [x, y, w, h] = a.region
      if ([x, y, w, h].some((n) => typeof n !== 'number') || w <= 0 || h <= 0) throw new Error('region is [x, y, width, height] with a positive width and height.')
      const f = frames.get(tid)
      const p1 = f && a.coords !== 'screen' ? toScreen(f, x, y) : { x, y }
      const p2 = f && a.coords !== 'screen' ? toScreen(f, x + w, y + h) : { x: x + w, y: y + h }
      rect = { x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y }; what = 'the region'; zoom = true
    } else if (ds.length) {
      const disp = displayByNumber(ds, a.display)
      if (!disp) throw new Error(`There is no display ${a.display}. Displays: ${describeDisplays(ds)}.`)
      rect = disp.bounds; what = a.display && a.display > 1 ? `display ${a.display}` : ds.length > 1 ? 'display 1 (main)' : 'the screen'
    }
    if (rect && ds.length) {
      const clipped = clipToDisplays(rect, ds)
      if (!clipped) throw new Error('That area is off screen.')
      rect = clipped
    }
    const scale = rect ? (displayAt(ds, center(rect).x, center(rect).y)?.scaleFactor ?? 2) : 1
    const size = rect ? fitImage(rect, scale, { ...imageLimits(ctx.model), zoom }) : undefined
    const dir = mkdtempSync(join(tmpdir(), 'sb-shot-'))
    try {
      d.enterMini(ctx.state.rootId ?? tid)
      const shot = await d.capture(join(dir, 'screen.png'), rect ? { rect, ...size } : undefined)
      const r = rect ?? { x: 0, y: 0, width: shot.width, height: shot.height }
      const f = makeFrame(r, shot.width, shot.height, what)
      frames.set(tid, f)
      const scaleNote = Math.abs(shot.width - r.width) > 1 ? ` (1 image pixel = ${(r.width / shot.width).toFixed(2)} screen points)` : ''
      const multi = ds.length > 1 && !a.ref && !a.window && !a.region ? ` Displays: ${describeDisplays(ds)}; pass display to see another.` : ''
      return {
        text: `Screenshot of ${what}: ${shot.width}×${shot.height} pixels${scaleNote}. For click, move, drag and scroll, give x,y in THIS image's pixels (x right, y down); SahilBot converts them to the screen. SahilBot's own small window (top right, with Stop) is not part of the task.${multi} Prefer refs from ui when the element is listed there.`,
        display: `Looked at ${what.length > 40 ? 'the screen' : what}`,
        images: [shot.dataUrl]
      }
    } catch (e) {
      throw new Error(/could not create image|not permitted|denied|cannot|screencapture/i.test((e as Error).message) ? 'SahilBot needs Screen Recording permission to see the screen: System Settings → Privacy & Security → Screen Recording. Meanwhile use the ui action instead.' : (e as Error).message)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * A closer look at a small target without moving the coordinate frame: the region (corners [x0, y0, x1, y1]
   * in the last screenshot's pixels, as Claude's toolset sends them) or an element (ref), captured at the
   * display's full pixel density. Clicks stay in the last full screenshot's pixels.
   */
  async function zoom(a: Args, ctx: ToolContext): Promise<ToolOutput> {
    const tid = ctx.threadId
    const ds = displays()
    const f = frames.get(tid)
    let rect: Rect
    let what: string
    if (a.ref) {
      const el = byRef(snapshots.get(tid), a.ref)
      if (!el?.rect) throw new Error(`No element ${a.ref} with a position in the last ui snapshot.`)
      rect = pad(el.rect, 24); what = `${short(el.role)} "${el.label}"`
    } else if (a.region) {
      const [x0, y0, x1, y1] = a.region
      if ([x0, y0, x1, y1].some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('zoom region is [x0, y0, x1, y1]: the top-left and bottom-right corners.')
      if (!f && a.coords !== 'screen') throw new Error('Take a screenshot first: zoom regions are pixels of the last screenshot.')
      const p1 = f && a.coords !== 'screen' ? toScreen(f, Math.min(x0, x1), Math.min(y0, y1)) : { x: Math.min(x0, x1), y: Math.min(y0, y1) }
      const p2 = f && a.coords !== 'screen' ? toScreen(f, Math.max(x0, x1), Math.max(y0, y1)) : { x: Math.max(x0, x1), y: Math.max(y0, y1) }
      rect = { x: p1.x, y: p1.y, width: Math.max(4, p2.x - p1.x), height: Math.max(4, p2.y - p1.y) }; what = 'the region'
    } else throw new Error('zoom needs region [x0, y0, x1, y1] (pixels of the last screenshot) or a ref from ui.')
    if (ds.length) {
      const clipped = clipToDisplays(rect, ds)
      if (!clipped) throw new Error('That area is off screen.')
      rect = clipped
    }
    const scale = displayAt(ds, center(rect).x, center(rect).y)?.scaleFactor ?? 2
    const size = fitImage(rect, scale, { ...imageLimits(ctx.model), zoom: true })
    const dir = mkdtempSync(join(tmpdir(), 'sb-zoom-'))
    try {
      d.enterMini(ctx.state.rootId ?? tid)
      const shot = await d.capture(join(dir, 'zoom.png'), { rect, ...size })
      const back = f ? ` Coordinates for click, move, drag and scroll stay in the LAST FULL screenshot's pixels (${f.width}×${f.height}), not this zoomed image.` : ''
      return {
        text: `Zoomed in on ${what}: ${shot.width}×${shot.height} pixels showing ${Math.round(rect.width)}×${Math.round(rect.height)} screen points (${(shot.width / rect.width).toFixed(1)}× the points).${back}`,
        display: `Zoomed in on ${what.length > 40 ? 'a region' : what}`,
        images: [shot.dataUrl]
      }
    } catch (e) {
      throw new Error(/could not create image|not permitted|denied|cannot|screencapture/i.test((e as Error).message) ? 'SahilBot needs Screen Recording permission to see the screen: System Settings → Privacy & Security → Screen Recording. Meanwhile use the ui action instead.' : (e as Error).message)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * Waits for the UI instead of a fixed sleep: until the app in front settles (two identical reads), or until an
   * element whose name or value contains `query` appears (or, with gone, disappears) in the app's elements.
   */
  async function waitFor(a: Args, ctx: ToolContext): Promise<ToolOutput> {
    const limit = Math.min(20, Math.max(0.5, a.seconds ?? 8)) * 1000
    const start = Date.now()
    if (!a.query) {
      const r = await waitForSettle(() => probe(), sameState, { timeoutMs: limit, intervalMs: 300, initialDelayMs: 150, signal: ctx.signal })
      const secs = (r.waitedMs / 1000).toFixed(1)
      return { text: r.stable ? `The screen settled after ${secs}s. Now: ${r.state.app}${r.state.window ? ` › "${r.state.window}"` : ''}.` : `Still changing after ${secs}s (loading or animating): look with ui or a screenshot before acting.`, display: r.stable ? `settled in ${secs}s` : 'still changing' }
    }
    await needAx(ctx)
    const want = a.query.toLowerCase()
    const seen = (snap: AxSnapshot): AxElement | undefined => snap.elements.find((e) => `${e.label} ${e.value ?? ''}`.toLowerCase().includes(want))
    let last: AxElement | undefined
    let app = a.app
    while (Date.now() - start < limit) {
      alive(ctx)
      const snap = await snapshot(ctx.threadId, { app, activate: false }).catch(() => undefined)
      app ??= snap?.app
      last = snap ? seen(snap) : undefined
      if (snap && (a.gone ? !last : !!last)) {
        const secs = ((Date.now() - start) / 1000).toFixed(1)
        return { text: a.gone ? `"${a.query}" is gone from ${snap.app} after ${secs}s.` : `"${a.query}" is showing in ${snap.app} after ${secs}s: ${last!.ref} (${short(last!.role)} "${last!.label}").`, display: a.gone ? `"${a.query.slice(0, 30)}" gone` : `found "${a.query.slice(0, 30)}"` }
      }
      await sleep(400)
    }
    return { text: a.gone ? `"${a.query}" is still showing after ${limit / 1000}s.` : `"${a.query}" didn't appear within ${limit / 1000}s${app ? ` in ${app}` : ''}. Take a screenshot: it may be drawn without Accessibility text, worded differently, or in another window.`, display: 'not seen yet' }
  }

  /** Per chat: the Accessibility card that is up (several calls at once share it). */
  const axWaits = new Map<string, Promise<string>>()
  /**
   * Accessibility, or the one-tap card: macOS's own prompt adds SahilBot to the Accessibility list, the chat shows
   * the card (whatever the model says), and the step waits for the switch and carries on by itself once it's on.
   * Off (skipped, timed out, nobody there): one stable line, so the model explains instead of retrying or guessing.
   */
  async function needAx(ctx: ToolContext): Promise<void> {
    if (d.trusted(false)) return
    if (d.trusted(true)) return
    const tid = ctx.threadId
    let answer = 'unavailable'
    if (ctx.waitForUser) {
      let wait = axWaits.get(tid)
      if (!wait) {
        wait = ctx.waitForUser(AX_CARD, async () => d.trusted(false), { permission: 'accessibility', options: ['Not now'], everyMs: d.axPoll?.everyMs ?? 1000, timeoutMs: d.axPoll?.timeoutMs ?? 5 * 60_000 })
          .finally(() => axWaits.delete(tid))
        axWaits.set(tid, wait)
      }
      answer = await wait
    }
    alive(ctx)
    if (d.trusted(false)) return
    const why = answer === 'unavailable' ? 'Nobody is here to turn it on: leave the clicking part for the user and say so in your report.'
      : answer === 'timeout' ? 'It wasn\'t turned on in time. Tell the user in one sentence that the Accessibility card in the chat turns it on; don\'t retry or guess.'
        : 'The user didn\'t turn it on now. Tell them in one sentence that the Accessibility button in the chat turns it on; don\'t retry, don\'t guess and don\'t try another way to click.'
    throw new Error(`${AX_OFF} ${why}`)
  }

  const describe = (a: Args): string => {
    const el = (ref?: string): string => { if (!ref) return ''; for (const s of snapshots.values()) { const e = byRef(s, ref); if (e) return `${short(e.role)} "${e.label.slice(0, 60)}" in ${s.app}` } return ref }
    switch (a.action) {
      case 'type': return `Take control of your Mac and type "${(a.text ?? '').slice(0, 80)}"`
      case 'type_ref': return `Type "${(a.text ?? '').slice(0, 80)}" into ${el(a.ref)}`
      case 'paste_text': return `Paste "${(a.text ?? '').slice(0, 80)}"${(a.text ?? '').length > 80 ? ` (${(a.text ?? '').length} characters)` : ''}${a.ref ? ` into ${el(a.ref)}` : ''} (your clipboard is put back afterwards)`
      case 'copy': return `Copy the selection${a.ref ? ` in ${el(a.ref)}` : ''} and read it`
      case 'select_all': return `Select all${a.ref ? ` in ${el(a.ref)}` : ''}`
      case 'set_value': return `Set ${el(a.ref)} to "${(a.value ?? '').slice(0, 80)}"`
      case 'click_ref': case 'press': return `${a.action === 'press' ? `${a.ax_action ?? 'Press'}` : 'Click'} ${el(a.ref)}`
      case 'open_app': return `Take control of your Mac: open ${a.app}`
      case 'activate_app': return `Bring ${a.app} to the front`
      case 'quit_app': return `Quit ${a.app} (it may ask to save unsaved work)`
      case 'focus_window': return `Bring the window "${a.window}" to the front`
      case 'menu': return `Choose ${a.path}${a.app ? ` in ${a.app}` : ''}`
      case 'key': return `Press ${a.keys}`
      case 'clipboard_write': return `Copy ${(a.text ?? '').length} characters to your clipboard`
      default: return `Take control of your mouse and keyboard (${a.action.replace('_', ' ')}${a.ref ? ` on ${el(a.ref)}` : a.x !== undefined ? ` at ${a.x}, ${a.y}` : ''}). SahilBot shrinks to a small window so you can watch; press Stop (or Ctrl+Option+Esc) anytime.`
    }
  }

  const hardStop = (a: Args): string | null => {
    if (a.action === 'quit_app') return `quitting ${a.app ?? 'an app'}`
    if (a.action === 'key' && a.keys) { try { const r = riskyCombo(parseCombo(a.keys)); if (r) return r } catch { /* reported by the action */ } }
    if (a.action === 'menu' && a.path) { const last = a.path.split('>').pop()?.trim() ?? ''; if (RISKY_MENU.test(last)) return `choosing "${a.path}"` }
    // Security and privacy panes in System Settings: every change asks.
    if (!READ.has(a.action) && !NAVIGATE.has(a.action)) {
      const s = a.ref ? snapshotsAny(a.ref) : undefined
      const e = s && a.ref ? byRef(s, a.ref) : undefined
      const stop = e && s ? settingsStop(s.app, e.window, e.label) ?? settingsStop(s.app, lastFront?.app === s.app ? lastFront.window : undefined) : settingsStop(a.app ?? lastFront?.app, a.app && a.app !== lastFront?.app ? undefined : lastFront?.window)
      if (stop) return stop
    }
    return null
  }

  const isGranted0 = (tid: string): boolean => isGranted(tid)

  const def: ToolDef<Args> = {
    name: 'computer',
    label: 'Computer',
    core: false,
    group: 'Computer use',
    untrusted: true,
    effect: (a) => (READ.has(a.action) ? 'read' : a.action === 'clipboard_write' ? 'write_local' : 'write_external'),
    // Asks once per task before taking control; then routine clicks and typing run. Quitting an app
    // always asks. The OK belongs to the chat that got it; nobody approved anything for a scheduled run or helper.
    consequential: (a, c) => a.action === 'quit_app' || (!READ.has(a.action) && a.action !== 'clipboard_write' && (!!c.unattended || !isGranted(c.threadId))),
    hardStop,
    describe,
    description: `Use the Mac like a person, for apps that have no other tool (prefer the app tool for Finder, Safari/Chrome, Office/iWork, Messages, Music, Slack, Xcode, System Settings…; the browser tool for websites).
Accessibility first:
- ui {app?, window?, query?}: the app's windows and elements (buttons, fields, checkboxes, menus, text) with refs like e12, values, focus and disabled state. app brings that app to the front first. query filters.
- click_ref {ref, modifiers?}: press/click an element. type_ref {ref, text, clear?, submit?, method?}: focus a field and enter text (clear replaces its text; submit presses Return). set_value {ref, value}: set a field/slider/checkbox value directly. press {ref, ax_action}: an Accessibility action (AXPress, AXShowMenu, AXIncrement, AXDecrement, AXConfirm, AXCancel, AXRaise).
Screen: screenshot {display?, window?, ref?, region?}: the main display, another display, one window (window: ref from windows or part of its title), around an element, or a region [x,y,w,h] of the last screenshot (this becomes the new coordinate frame). zoom {region: [x0,y0,x1,y1] corners in the last screenshot's pixels, or ref}: a sharp close-up of a small target or text that does NOT change the coordinate frame (clicks stay in the full screenshot's pixels).
Coordinates (fallback): click/double_click/triple_click/right_click/move {x,y, modifiers?}, drag {x,y,x2,y2 or ref,ref2}, scroll {x,y or ref, amount: lines, negative = down, dx?: sideways}. x,y are pixels of the LAST screenshot (coords:"screen" for global screen points).
Text: type {text, method?} into whatever is focused. Short plain text is typed key by key; long, multi-line or non-ASCII text (emoji, accents, CJK) is pasted automatically (method "type" or "paste" forces one). paste_text {text, ref?}: paste exactly (fast for long text); the user's clipboard is put back afterwards. Every entry reports whether the field now shows the text. select_all {ref?}: cmd+a (in that field). copy {ref?, restore?}: cmd+c and returns what was copied (secrets hidden; ref copies that whole field; restore puts the user's clipboard back).
Keyboard: key {keys: "cmd+s", "return", "cmd+shift+t", "ctrl+option+left", "cmd+plus", repeat?: times (e.g. tab ×4)}.
Apps: apps (running apps), windows {app?} (every window with refs w1…), open_app {app}, activate_app {app}, focus_window {window, app?}, quit_app {app}, menu {path: "File > Export > PDF…", app?} (a path ending at a menu lists its items).
Clipboard: clipboard_read, clipboard_write {text}. Waiting: wait_for {query?, app?, gone?, seconds?} waits until the screen settles, or until an element with that text appears (gone: disappears), up to 20 s; wait {seconds} only when nothing on screen tells you it's ready.
Every action reports what changed afterwards (app, window, dialog, focus, values) or that nothing did: if nothing changed, look before retrying. SahilBot never types passwords, never confirms payments or purchases, and never answers system password/Touch ID prompts: those steps go to the user automatically. Changes on System Settings security/privacy panes always ask. Stop and ask the user for CAPTCHAs and 2-factor codes.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'zoom', 'ui', 'apps', 'windows', 'wait', 'wait_for', 'clipboard_read', 'click', 'double_click', 'triple_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'click_ref', 'type_ref', 'set_value', 'press', 'click_element', 'open_app', 'activate_app', 'quit_app', 'focus_window', 'menu', 'clipboard_write', 'paste_text', 'copy', 'select_all'] },
        ref: { type: 'string', description: 'Element ref from ui, e.g. "e12"' },
        ref2: { type: 'string', description: 'For drag: the element to drop on' },
        x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        coords: { type: 'string', enum: ['screenshot', 'screen'], description: 'x,y are pixels of the last screenshot (default) or global screen points' },
        amount: { type: 'integer', minimum: -50, maximum: 50, description: 'For scroll: lines; negative scrolls down' },
        dx: { type: 'integer', minimum: -50, maximum: 50, description: 'For scroll: sideways lines; negative scrolls left' },
        text: { type: 'string', description: 'For type, type_ref, paste_text, clipboard_write' },
        clear: { type: 'boolean', description: 'For type_ref: replace the field\'s current text' },
        submit: { type: 'boolean', description: 'For type_ref: press Return afterwards' },
        method: { type: 'string', enum: ['auto', 'type', 'paste'], description: 'For type/type_ref: auto (default) types short plain text and pastes the rest' },
        restore: { type: 'boolean', description: 'For copy: put the user\'s clipboard back after reading the copy' },
        keys: { type: 'string', description: 'For key, e.g. "cmd+v", "return", "escape", "cmd+shift+t"' },
        repeat: { type: 'integer', minimum: 1, maximum: 50, description: 'For key: press it this many times' },
        gone: { type: 'boolean', description: 'For wait_for: wait until the query text disappears' },
        modifiers: { type: 'string', description: 'For clicks: keys held, e.g. "cmd" or "shift"' },
        app: { type: 'string', description: 'App name, e.g. "Finder", "Numbers"' },
        window: { type: 'string', description: 'A window ref from windows (w3) or part of its title' },
        display: { type: 'integer', minimum: 1, maximum: 8, description: 'For screenshot: display number (1 = main)' },
        region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'For screenshot: [x, y, width, height]; for zoom: [x0, y0, x1, y1] corners; both in the last screenshot\'s pixels' },
        value: { type: 'string', description: 'For set_value' },
        ax_action: { type: 'string', description: 'For press, e.g. AXPress, AXShowMenu, AXIncrement' },
        query: { type: 'string', description: 'For ui: only elements whose name or value contains this. For wait_for: the text to wait for' },
        name: { type: 'string', description: 'For click_element: an element name shown by ui' },
        role: { type: 'string', description: 'For click_element: optional role, e.g. Button' },
        path: { type: 'string', description: 'For menu: e.g. "File > Export > Export as PDF…"' },
        seconds: { type: 'number', minimum: 0.2, maximum: 20, description: 'For wait (max 10) and wait_for (max 20)' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { enum: ['type', 'paste_text'] } } }, then: { required: ['text'] } },
        { if: { properties: { action: { const: 'key' } } }, then: { required: ['keys'] } },
        { if: { properties: { action: { enum: ['open_app', 'activate_app', 'quit_app'] } } }, then: { required: ['app'] } },
        { if: { properties: { action: { enum: ['click_ref', 'press', 'set_value', 'type_ref'] } } }, then: { required: ['ref'] } },
        { if: { properties: { action: { const: 'type_ref' } } }, then: { required: ['text'] } },
        { if: { properties: { action: { const: 'set_value' } } }, then: { required: ['value'] } },
        { if: { properties: { action: { const: 'click_element' } } }, then: { required: ['name'] } },
        { if: { properties: { action: { const: 'focus_window' } } }, then: { required: ['window'] } },
        { if: { properties: { action: { const: 'menu' } } }, then: { required: ['path'] } },
        { if: { properties: { action: { const: 'clipboard_write' } } }, then: { required: ['text'] } },
        { if: { properties: { action: { const: 'zoom' } } }, then: { anyOf: [{ required: ['region'] }, { required: ['ref'] }] } }
      ]
    },
    async run(input, ctx) {
      const tid = ctx.threadId
      await notSelf(input, tid)
      // paste_text is type (or type_ref with a ref) that always pastes.
      const a: Args = input.action === 'paste_text' ? { ...input, action: input.ref ? 'type_ref' : 'type', method: 'paste' } : input
      const acting = !READ.has(a.action) && a.action !== 'clipboard_write'
      if (acting) {
        // Opening or switching to an app is `open -a` and a plain activate: no Accessibility needed.
        if (!OPENS.has(a.action)) await needAx(ctx)
        granted.set(tid, Date.now())
        d.enterMini(ctx.state.rootId ?? tid)
      }
      alive(ctx)
      await show(ctx, { kind: 'status', label: statusLabel(input) })
      try {
        return stallCheck(tid, input, ctx, await step(a, ctx))
      } catch (e) {
        if ((e as Error).name === 'AbortError') finish()
        else stallCheck(tid, input, ctx, undefined, (e as Error).message)
        throw e
      }
    }
  }

  async function step(a: Args, ctx: ToolContext): Promise<ToolOutput> {
    const tid = ctx.threadId
    switch (a.action) {
      case 'screenshot':
        return screenshot(a, ctx)

      case 'zoom':
        return zoom(a, ctx)

      case 'wait_for':
        return waitFor(a, ctx)

      case 'ui': {
        await needAx(ctx)
        let pid: number | undefined
        let windowIndex: number | undefined
        let app = a.app
        if (a.window && /^w\d+$/i.test(a.window.trim())) {
          const w = windowLists.get(tid)?.find((x) => x.ref === a.window!.trim().toLowerCase())
          if (!w) throw new Error(`No window ${a.window} in the last windows list. Run windows first.`)
          pid = w.pid; windowIndex = w.index; app = w.app
        }
        const snap = await snapshot(tid, { app, pid, activate: !!app, window: windowIndex })
        let text = formatSnapshot(snap, { query: a.query })
        if (a.window && windowIndex === undefined) {
          const want = a.window.toLowerCase()
          const w = snap.windows.find((x) => x.title.toLowerCase().includes(want))
          if (w) text = formatSnapshot({ ...snap, windows: [w], elements: snap.elements.filter((e) => e.win === w.index) }, { query: a.query })
        }
        if (!snap.elements.length) text += '\n(No readable elements: this app may draw its own UI. Take a screenshot and use coordinates.)'
        return { text: `${text}\nAct on elements by ref (click_ref, type_ref, set_value, press). Refs stay valid while the element is on screen.`, display: `Read ${snap.app}'s window` }
      }

      case 'apps': {
        const r = await jxa<Array<{ name: string; front: boolean }>>(APPS, {})
        return { text: r.map((x) => `- ${x.name}${x.front ? ' (in front)' : ''}`).join('\n'), display: `${r.length} apps open` }
      }

      case 'windows': {
        await needAx(ctx)
        const list = await windowsList(tid, a.app)
        const ds = displays()
        const where = (r?: Rect): string => { if (!r || ds.length < 2) return ''; const disp = displayAt(ds, center(r).x, center(r).y); return disp ? ` on display ${ordered(ds).indexOf(disp) + 1}` : ' (off screen)' }
        return { text: list.length ? list.map((w) => `[${w.ref}] ${w.app}: "${w.title || '(untitled)'}"${w.front ? ' (in front)' : ''}${w.minimized ? ' (minimized)' : ''}${where(w.rect)}`).join('\n') + '\nUse focus_window {window: "w3"}, ui {window: "w3"} or screenshot {window: "w3"}.' : 'No open windows.', display: `${list.length} windows` }
      }

      case 'wait': {
        const ms = Math.min(10, a.seconds ?? 1) * 1000
        for (let t = 0; t < ms; t += 200) { alive(ctx); await sleep(Math.min(200, ms - t)) }
        return { text: `Waited ${ms / 1000}s.${(a.seconds ?? 0) > 10 ? " (10 s at most: use wait_for to wait for something specific.)" : ""}`, display: "waited" }
      }

      case 'clipboard_read': {
        // Sensitive: the contents go to the model only (never into the chip or logs), secrets blanked.
        const r = await clip().read()
        if (r.concealed) return { text: 'The clipboard holds a password manager\'s hidden item; SahilBot doesn\'t read those.', display: 'read the clipboard' }
        const raw = r.text ?? ''
        const { text, redacted } = redactClipboard(raw)
        const cut = text.length > 8000 ? `${text.slice(0, 8000)}\n… (${text.length - 8000} more characters)` : text
        return { text: raw ? `Clipboard text${redacted ? ' (parts that look like passwords, keys or card numbers are hidden)' : ''}:\n${cut}` : `The clipboard has no text${r.types.length ? ` (it holds ${r.types.slice(0, 4).join(', ')})` : ''}.`, display: 'read the clipboard' }
      }

      case 'clipboard_write':
        await clip().writeText(a.text!)
        return { text: `Copied ${a.text!.length} characters to the clipboard.`, display: `copied ${a.text!.length} characters` }

      case 'copy': {
        const io = clip()
        const saved = a.restore ? await io.save() : undefined
        try {
          if (a.ref) await focusRef(ctx, a.ref, { selectAll: true })
          const n0 = await io.changeCount()
          await pressKey(ctx, { char: 'c', using: ['command down'] }, 'cmd+c')
          let n = n0
          for (let t = 0; t < 1500 && n === n0; t += 100) { await sleep(100); alive(ctx); n = await io.changeCount() }
          if (n === n0) return { text: `Nothing was copied (the clipboard didn't change). Select something first: select_all, a triple_click on a line, or drag over the text${a.ref ? '' : ', or pass ref to copy a whole field'}.`, display: 'nothing copied' }
          const r = await io.read()
          if (a.restore && saved) await io.restore(saved)
          const restored = a.restore ? ' The user\'s clipboard was put back.' : ' It is on the clipboard now (cmd+v pastes it).'
          if (r.concealed) return { text: `Copied a password manager's hidden item; SahilBot doesn't read those.${restored}`, display: 'copied (hidden)' }
          if (r.text === undefined) return { text: `Copied something that isn't text (${r.types.slice(0, 4).join(', ') || 'unknown type'}).${restored}`, display: 'copied' }
          const { text, redacted } = redactClipboard(r.text)
          const cut = text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (${text.length - 20_000} more characters)` : text
          return { text: `Copied ${r.text.length} characters${redacted ? ' (parts that look like passwords, keys or card numbers are hidden)' : ''}:\n${cut}\n${restored.trim()}`, display: `copied ${r.text.length} characters` }
        } finally {
          if (saved) io.discard?.(saved)
        }
      }

      case 'select_all': {
        const v = await verified(ctx, async () => {
          if (a.ref) await focusRef(ctx, a.ref, { selectAll: false })
          await pressKey(ctx, { char: 'a', using: ['command down'] }, 'cmd+a')
        }, { timeoutMs: 1000 })
        const val = await readValue()
        return { text: `Selected all${val?.selected !== undefined ? ` (${val.selected} characters selected)` : ''}. ${v.text}`, display: 'selected all' }
      }

      case 'click_ref': case 'click_element': {
        let ref = a.ref
        if (a.action === 'click_element') {
          // Older form: by name (and role) in the front app.
          const snap = await snapshot(tid, { app: a.app, activate: !!a.app })
          const want = a.name!.toLowerCase()
          const pool = snap.elements.filter((e) => !a.role || short(e.role).toLowerCase().includes(a.role.toLowerCase()))
          const hit = pool.find((e) => e.label.toLowerCase() === want) ?? pool.find((e) => e.label.toLowerCase().includes(want))
          if (!hit) throw new Error(`No element named "${a.name}" in ${snap.app}. Read the window with ui to see what's there, or take a screenshot.`)
          ref = hit.ref
        }
        if (!ref) throw new Error('Give a ref from ui.')
        const known = byRef(snapshots.get(tid), ref)
        const before = await probe().catch(() => undefined)
        const g = known && guardAction({ action: 'click', app: snapshots.get(tid)!.app, window: known.window || before?.window, el: known })
        if (g) return handOff(g, ctx)
        const flags = clickFlags(a.modifiers)
        let how = ''
        const label = known ? `Click "${known.label.slice(0, 40)}"` : 'Click'
        const v = await verified(ctx, async () => {
          if (known?.pressable && !flags) {
            if (known.rect) await show(ctx, { kind: 'click', ...center(known.rect), label })
            const { el, res } = await onElement(tid, ref!, { op: 'press' })
            if (res.done) { how = 'pressed'; return }
            const r = res.x !== undefined ? { x: res.x, y: res.y!, width: res.w!, height: res.h! } : el.rect
            if (!r) throw new Error(`Couldn't press ${ref} (${res.error ?? 'no AXPress'}) and it has no position to click.`)
            await mouse(ctx, { kind: 'click', ...center(r) }, label); how = 'clicked'
            return
          }
          const { el, res } = await onElement(tid, ref!, { op: 'read' })
          const r = res.x !== undefined ? { x: res.x, y: res.y!, width: res.w!, height: res.h! } : el.rect
          if (!r) throw new Error(`${ref} has no position to click.`)
          await mouse(ctx, { kind: 'click', ...center(r), flags }, label); how = 'clicked'
        }, { before, target: known ? { pid: snapshots.get(tid)?.pid, path: known.path } : undefined })
        const el = byRef(snapshots.get(tid), ref)
        return { text: `${how === 'pressed' ? 'Pressed' : 'Clicked'} ${ref}${el ? ` (${short(el.role)} "${el.label}")` : ''}. ${v.text}`, display: `${how} "${(el?.label ?? ref).slice(0, 40)}"${v.changed ? '' : ' (no change)'}` }
      }

      case 'press': {
        const known = byRef(snapshots.get(tid), a.ref!)
        const name = a.ax_action?.trim() || 'AXPress'
        const axName = /^AX/.test(name) ? name : `AX${name[0].toUpperCase()}${name.slice(1)}`
        const before = await probe().catch(() => undefined)
        const g = known && /^AX(Press|Confirm|Pick)$/.test(axName) ? guardAction({ action: 'press', app: snapshots.get(tid)!.app, window: known.window || before?.window, el: known }) : null
        if (g) return handOff(g, ctx)
        let failed = undefined as ElementResult | undefined
        const v = await verified(ctx, async () => {
          if (known?.rect) await show(ctx, { kind: 'focus', x: known.rect.x, y: known.rect.y, w: known.rect.width, h: known.rect.height, label: `${axName.replace(/^AX/, '')} "${known.label.slice(0, 40)}"` })
          const { res } = await onElement(tid, a.ref!, { op: 'action', action: axName })
          if (!res.done) failed = res
        }, { before, target: known ? { pid: snapshots.get(tid)?.pid, path: known.path } : undefined, timeoutMs: 2000 })
        if (failed) throw new Error(`${a.ref} doesn't support ${axName}${failed.actions?.length ? `; it supports ${failed.actions.join(', ')}` : ''}.`)
        return { text: `Performed ${axName} on ${a.ref}${known ? ` (${short(known.role)} "${known.label}")` : ''}. ${v.text}`, display: `${axName.replace(/^AX/, '').toLowerCase()} "${(known?.label ?? a.ref!).slice(0, 40)}"` }
      }

      case 'type_ref': case 'set_value': {
        const snap = snapshots.get(tid)
        const known = byRef(snap, a.ref!)
        if (!snap || !known) throw new Error(`No element ${a.ref} in the last ui snapshot. Read the app with ui first.`)
        const before = await probe().catch(() => undefined)
        const g = guardAction({ action: a.action, app: snap.app, window: known.window || before?.window, el: known, typing: true })
        if (g) return handOff(g, ctx)
        const target = { pid: snap.pid, path: known.path }
        if (a.action === 'set_value') {
          let res = undefined as ElementResult | undefined
          const v = await verified(ctx, async () => {
            if (known.rect) await show(ctx, { kind: 'focus', x: known.rect.x, y: known.rect.y, w: known.rect.width, h: known.rect.height, label: `Set "${known.label.slice(0, 40)}"` })
            res = (await onElement(tid, a.ref!, { op: 'set_value', value: a.value })).res
          }, { before, target })
          if (res?.refused === 'secure') return handOff(guardAction({ action: 'set_value', app: snap.app, el: { ...known, secure: true }, typing: true })!, ctx)
          if (!res?.done) throw new Error(`Couldn't set ${a.ref}'s value (${res?.error ?? 'not settable'}). Try type_ref, or click it and type.`)
          const now = v.after.target?.value
          const ok = now === undefined || now === a.value || (now === '1' && /^(true|on|1|yes)$/i.test(a.value!)) || (now === '0' && /^(false|off|0|no)$/i.test(a.value!))
          return { text: `Set ${a.ref} (${short(known.role)} "${known.label}") to "${a.value!.slice(0, 80)}". ${v.text}${ok ? '' : ` Its value reads "${now}" now, not what was set: the app may not accept direct values. Try type_ref instead.`}`, display: `set "${known.label.slice(0, 30)}"` }
        }
        // type_ref: the app must be in front (keystrokes go to the front app), then focus the field, then type or paste.
        if (before && before.app !== snap.app) await jxa(ACTIVATE, { app: snap.app })
        let refused = false as boolean
        let entered: Entered | undefined
        const v = await verified(ctx, async () => {
          const { el, res } = await onElement(tid, a.ref!, { op: 'focus', forTyping: true })
          if (res.refused === 'secure') { refused = true; return }
          if (!res.done) {
            const r = res.x !== undefined ? { x: res.x, y: res.y!, width: res.w!, height: res.h! } : el.rect
            if (!r) throw new Error(`Couldn't focus ${a.ref}.`)
            await mouse(ctx, { kind: 'click', ...center(r) }, `Click "${known.label.slice(0, 40)}"`)
            await sleep(150)
          }
          // Focus landed somewhere else (or on a password field): stop before typing.
          const now = await probe().catch(() => undefined)
          if (now?.focused?.secure) { refused = true; return }
          if (a.clear) {
            await pressKey(ctx, { char: 'a', using: ['command down'] }, 'cmd+a')
            await pressKey(ctx, { code: 51, using: [] }, 'delete')
          }
          entered = await enterText(ctx, a.text!, { method: a.method, target, point: known.rect ? center(known.rect) : undefined, label: `Typing into "${known.label.slice(0, 40)}"`, secretLabel: isSecure(known) })
          if (entered.refused) { refused = true; return }
          if (a.submit) await pressKey(ctx, { code: 36, using: [] }, 'return')
        }, { before, target })
        if (refused) return handOff({ kind: 'password', reason: `typing into a password field ("${known.label}") in ${snap.app}`, ask: `The next step is typing a password into "${known.label}" in ${snap.app}. I never type passwords: please type it yourself, then tell me when you're done.` }, ctx)
        const e = entered!
        const verb = e.how === 'paste' ? 'Pasted' : 'Typed'
        // The value was checked before Return (which may clear a search field or send a message).
        const landed = e.landed
        return { text: `${verb} ${a.text!.length} characters (${e.why}) into ${a.ref} (${short(known.role)} "${known.label}")${a.submit ? ' and pressed Return' : ''}. ${landedNote(e)}${e.clipboard ? ` ${e.clipboard}` : ''} ${v.text}`, display: `${verb.toLowerCase()} "${a.text!.slice(0, 40)}"${landed === 'no' ? ' (not seen in the field)' : ''}` }
      }

      case 'click': case 'double_click': case 'triple_click': case 'right_click': case 'move': {
        const p = pointOf(tid, a)
        const before = await probe().catch(() => undefined)
        let el: AxElement | undefined
        if (a.action !== 'move') {
          const snap = freshSnapshot(tid, before?.app)
          el = p.el ?? elementAt(snap, p.x, p.y)
          const g = guardAction({ action: 'click', app: before?.app ?? '', window: before?.window, el })
          if (g) return handOff(g, ctx)
        }
        const kind = { click: 'click', double_click: 'double', triple_click: 'triple', right_click: 'right', move: 'move' }[a.action]
        const flags = clickFlags(a.modifiers)
        const label = a.action.replace('_', ' ')
        const v = await verified(ctx, () => mouse(ctx, { kind, x: p.x, y: p.y, flags }, el ? `${label} "${el.label.slice(0, 40)}"` : label), { before, timeoutMs: a.action === 'move' ? 600 : 2500 })
        // Name what was under the point (from the last ui read), so a click that missed shows without a screenshot.
        const hit = p.el ?? el
        return { text: `${label} at screen point (${p.x}, ${p.y})${hit ? ` on ${hit.ref ? `${hit.ref} ` : ''}${short(hit.role)} "${hit.label.slice(0, 80)}"` : ' (nothing known there: take a ui read or screenshot if unsure)'}. ${v.text}`, display: `${label} at ${p.x}, ${p.y}${v.changed || a.action === 'move' ? '' : ' (no change)'}` }
      }

      case 'drag': {
        const p1 = pointOf(tid, a, 1)
        const p2 = pointOf(tid, a, 2)
        const v = await verified(ctx, () => mouse(ctx, { kind: 'drag', x: p1.x, y: p1.y, x2: p2.x, y2: p2.y }, 'Dragging'))
        return { text: `Dragged from (${p1.x}, ${p1.y}) to (${p2.x}, ${p2.y}). ${v.text}`, display: 'dragged' }
      }

      case 'scroll': {
        let p: { x: number; y: number }
        try { p = pointOf(tid, a) } catch {
          // No point given: the middle of the main display.
          const main = displayByNumber(displays(), 1)
          p = main ? center(main.bounds) : { x: 700, y: 450 }
        }
        const dy = a.amount ?? -5
        const v = await verified(ctx, async () => {
          try { await mouse(ctx, { kind: 'scroll', x: p.x, y: p.y, dy, dx: a.dx ?? 0 }, dy < 0 ? 'Scrolling down' : 'Scrolling up') } catch (e) {
            if ((e as Error).name === 'AbortError') throw e
            await pressKey(ctx, { code: dy < 0 ? 121 : 116, using: [] }, dy < 0 ? 'pagedown' : 'pageup')
          }
        }, { timeoutMs: 1200 })
        return { text: `Scrolled ${dy < 0 ? 'down' : 'up'} ${Math.abs(dy)} lines${a.dx ? ` and ${a.dx < 0 ? 'left' : 'right'} ${Math.abs(a.dx)}` : ''} at (${p.x}, ${p.y}). ${v.changed ? v.text : 'Scrolling only shows in a screenshot or a new ui read.'}`, display: `scrolled ${dy < 0 ? 'down' : 'up'}` }
      }

      case 'type': {
        const before = await probe().catch(() => undefined)
        const g = guardAction({ action: 'type', app: before?.app ?? '', window: before?.window, focused: before?.focused, typing: true })
        if (g) return handOff(g, ctx)
        let e: Entered | undefined
        const v = await verified(ctx, async () => { e = await enterText(ctx, a.text!, { method: a.method, point: mid(before?.focused), secretLabel: !before?.focused || isSecure(before.focused), label: `Typing into ${before?.focused?.label ? `"${before.focused.label.slice(0, 40)}"` : before?.app ?? 'the focused field'}` }) }, { before })
        if (e?.refused) return handOff({ kind: 'password', reason: `typing into a password field in ${before?.app ?? 'the app in front'}`, ask: `The next step is typing a password in ${before?.app ?? 'the app in front'}. I never type passwords: please type it yourself, then tell me when you're done.` }, ctx)
        const verb = e!.how === 'paste' ? 'Pasted' : 'Typed'
        return { text: `${verb} ${a.text!.length} characters (${e!.why}) into ${before?.focused ? `${short(before.focused.role)}${before.focused.label ? ` "${before.focused.label}"` : ''}` : 'the focused element'}. ${landedNote(e!)}${e!.clipboard ? ` ${e!.clipboard}` : ''} ${v.text}`, display: `${verb.toLowerCase()} "${a.text!.slice(0, 40)}"${e!.landed === 'no' ? ' (not seen in the field)' : ''}` }
      }

      case 'key': {
        let k: KeyCombo
        try { k = parseCombo(a.keys!) } catch (e) { throw new Error((e as Error).message) }
        const before = await probe().catch(() => undefined)
        // A pasted or typed character into a password field is typing a password.
        const typesText = !!k.char && (!k.using.some((m) => m !== 'shift down') || (k.char === 'v' && k.using.includes('command down')))
        const g = guardAction({ action: 'key', app: before?.app ?? '', window: before?.window, focused: before?.focused, typing: typesText })
        if (g) return handOff(g, ctx)
        const times = Math.max(1, Math.min(50, Math.round(a.repeat ?? 1)))
        const v = await verified(ctx, async () => {
          for (let n = 0; n < times; n++) {
            alive(ctx)
            await pressKey(ctx, k, times > 1 ? `${k.label} ×${times}` : k.label)
            if (n < times - 1) await sleep(60)
          }
        }, { before })
        return { text: `Pressed ${k.label}${times > 1 ? ` ${times} times` : ''}. ${v.text}`, display: `pressed ${k.label}${times > 1 ? ` ×${times}` : ''}${v.changed ? '' : ' (no change)'}` }
      }

      case 'open_app': case 'activate_app': {
        const launch = async (): Promise<{ front?: string; error?: string; timeout?: boolean }> => {
          if (a.action === 'open_app') await sh('open', ['-a', a.app!])
          const r = await jxa<{ front?: string; error?: string; timeout?: boolean }>(ACTIVATE, { app: a.app }, 15_000)
          if (r?.error) throw new Error(`Couldn't ${a.action === 'open_app' ? 'open' : 'bring up'} ${a.app}: ${r.error}`)
          return r ?? {}
        }
        // No Accessibility: the app still opens; there's just no window state to read afterwards.
        if (!d.trusted(false)) {
          const r = await launch()
          const late = !!r.front && r.front.toLowerCase() !== a.app!.toLowerCase()
          return { text: `${a.action === 'open_app' ? 'Opened' : 'Brought up'} ${a.app}.${late ? ` ${r.front} is in front instead: ${a.app} may still be starting.` : ''}`, display: `${a.action === 'open_app' ? 'opened' : 'switched to'} ${a.app}` }
        }
        const v = await verified(ctx, async () => { await launch() }, { timeoutMs: 1500 })
        const front = v.after.app
        const ok = !front || front.toLowerCase() === a.app!.toLowerCase()
        return { text: `${a.action === 'open_app' ? 'Opened' : 'Brought up'} ${a.app}. ${v.text}${ok ? '' : ` ${front} is in front instead: ${a.app} may still be starting or showing a dialog; check with ui or apps.`}`, display: `${a.action === 'open_app' ? 'opened' : 'switched to'} ${a.app}` }
      }

      case 'quit_app': {
        if (NO_QUIT.test(a.app!.trim())) throw new Error(`SahilBot doesn't quit ${a.app}.`)
        const r = await jxa<{ ok?: boolean; error?: string }>(QUIT, { app: a.app }, 30_000)
        if (r?.error) throw new Error(`Couldn't quit ${a.app}: ${r.error}`)
        return { text: `Asked ${a.app} to quit. If it had unsaved work it may be showing a save dialog: check with ui.`, display: `quit ${a.app}` }
      }

      case 'focus_window': {
        const w = await findWindow(tid, a.window!, a.app)
        let res = undefined as ElementResult | undefined
        const v = await verified(ctx, async () => {
          await jxa(ACTIVATE, { app: w.app })
          res = await jxa<ElementResult>(ELEMENT, { pid: w.pid, path: [w.index], op: 'raise' })
        }, { timeoutMs: 1500 })
        if (res?.missing) throw new Error(`The window "${w.title}" is gone. List windows again.`)
        return { text: `Brought ${w.app}'s window "${w.title}" to the front. ${v.text}`, display: `focused ${w.app}` }
      }

      case 'menu': {
        type MenuResult = { app?: string; clicked?: string; listed?: string; disabled?: string; missing?: number; walked?: string; options?: string[]; error?: string }
        let r = undefined as MenuResult | undefined
        const v = await verified(ctx, async () => {
          r = await jxa<MenuResult>(MENU, { path: a.path, app: a.app, activate: !!a.app }, 20_000)
        }, { timeoutMs: 2000 })
        if (!r || r.error) throw new Error(r?.error ?? 'Couldn\'t read the menu bar.')
        if (r.listed) return { text: `${r.listed} menu in ${r.app}:\n${(r.options ?? []).map((o) => `- ${o}`).join('\n')}\nChoose one with menu {path: "${r.listed} > …"}.`, display: `read menu ${r.listed.slice(0, 40)}` }
        if (r.disabled) throw new Error(`"${r.disabled}" is disabled right now in ${r.app} (select something first, or it doesn't apply here).`)
        if (r.missing !== undefined) {
          const parts = a.path!.split('>').map((s) => s.trim())
          throw new Error(`No menu item "${parts[r.missing] ?? a.path}"${r.walked ? ` under ${r.walked}` : ''} in ${r.app}.${r.options?.length ? ` Available: ${r.options.slice(0, 40).join(' · ')}` : ''}`)
        }
        return { text: `Chose ${r.clicked} in ${r.app}. ${v.text}`, display: `menu: ${(r.clicked ?? '').slice(0, 50)}` }
      }
    }
    throw new Error(`Unknown action ${(a as { action: string }).action}.`)
  }

  /** Focuses a field by ref (clicking it when AX focus doesn't take), optionally selecting all of it. */
  async function focusRef(ctx: ToolContext, ref: string, o: { selectAll: boolean }): Promise<void> {
    const known = byRef(snapshots.get(ctx.threadId), ref)
    if (!known) throw new Error(`No element ${ref} in the last ui snapshot. Read the app with ui first.`)
    const { el, res } = await onElement(ctx.threadId, ref, { op: 'focus' })
    if (!res.done) {
      const r = res.x !== undefined ? { x: res.x, y: res.y!, width: res.w!, height: res.h! } : el.rect
      if (!r) throw new Error(`Couldn't focus ${ref}.`)
      await mouse(ctx, { kind: 'click', ...center(r) }, `Click "${known.label.slice(0, 40)}"`)
      await sleep(150)
    }
    if (o.selectAll) await pressKey(ctx, { char: 'a', using: ['command down'] }, 'cmd+a')
  }

  const control: ComputerControl = { run: (args, ctx) => def.run(args as Args, ctx), isGranted: isGranted0, finish }
  current = control
  return Object.assign(def, { control })
}
