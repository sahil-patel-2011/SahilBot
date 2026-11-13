import { Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { deflateSync } from 'node:zlib'

// The menu bar icon: what's working, who needs you, and quick ways in. The icon is a template image
// (black + alpha; macOS tints it for light and dark menu bars), drawn here at 16 and 32 px from a
// little hard-hat-bot glyph like the app's mascot, so no image file has to ship.

// ---------------------------------------------------------------- glyph + PNG (pure)

const inRoundRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/** Whether a point (in a 16×16 box, y down) is inked: a hard-hat dome and brim over a rounded face with two eyes. */
export function glyphInk(x: number, y: number): boolean {
  // Hard hat: dome (upper half disc) with a small crest, and a brim. Edges sit on the 16 px grid so 1x stays crisp.
  const dome = y <= 6 && (x - 8) ** 2 + (y - 6) ** 2 <= 5.4 ** 2
  const crest = inRoundRect(x, y, 7, 0.4, 9, 3, 0.8)
  const brim = inRoundRect(x, y, 1, 6, 15, 8, 0.9)
  // Face below the brim (one clear row between), with eyes cut out.
  const face = inRoundRect(x, y, 3, 9, 13, 15, 2.2)
  const eye = (x - 6) ** 2 + (y - 12) ** 2 <= 1.1 ** 2 || (x - 10) ** 2 + (y - 12) ** 2 <= 1.1 ** 2
  return dome || crest || brim || (face && !eye)
}

/** RGBA pixels (black, alpha = coverage) of the glyph at `size` px, 4×4 supersampled. */
export function glyphPixels(size: number, ink: (x: number, y: number) => boolean = glyphInk): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const n = 4
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let hit = 0
      for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
        if (ink(((i + (sx + 0.5) / n) * 16) / size, ((j + (sy + 0.5) / n) * 16) / size)) hit++
      }
      px[(j * size + i) * 4 + 3] = Math.round((hit / (n * n)) * 255)
    }
  }
  return px
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A minimal PNG (8-bit RGBA, no interlace) from raw pixels. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------- status + menu (pure)

export interface TrayItem { threadId: string; label: string }
export interface TrayState {
  working: TrayItem[]
  needsYou: TrayItem[]
  routinesPaused: boolean
  /** Quick Ask shortcut ('' = off), shown next to the item. */
  quickKey: string
}
export interface TrayActions {
  open(threadId: string): void
  quickAsk(): void
  newChat(): void
  setRoutinesPaused(paused: boolean): void
  showMain(): void
  settings(): void
  quit(): void
}

/** Text beside the icon: how many chats are working, then ● and how many need you. Empty when idle. */
export function trayTitle(working: number, needs: number): string {
  const parts = [working > 0 ? String(working) : '', needs > 0 ? `●${needs}` : ''].filter(Boolean)
  return parts.length ? ` ${parts.join(' ')}` : ''
}

export function trayTooltip(working: number, needs: number, paused = false): string {
  const parts = [
    working ? `${working} working` : 'Idle',
    needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : '',
    paused ? 'routines paused' : ''
  ].filter(Boolean)
  return `SahilBot — ${parts.join(', ')}`
}

const short = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The icon's menu. Lists at most 8 working chats. */
export function trayMenuTemplate(s: TrayState, a: TrayActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  if (s.needsYou.length) {
    const n = s.needsYou.length
    items.push({ label: n === 1 ? `${short(s.needsYou[0].label, 40)} needs you` : `${n} bots need you`, click: () => a.open(s.needsYou[0].threadId) })
    items.push({ type: 'separator' })
  }
  if (s.working.length) {
    items.push({ label: `Working (${s.working.length})`, enabled: false })
    for (const w of s.working.slice(0, 8)) items.push({ label: short(w.label), click: () => a.open(w.threadId) })
    if (s.working.length > 8) items.push({ label: `${s.working.length - 8} more…`, click: () => a.showMain() })
    items.push({ type: 'separator' })
  }
  items.push(
    { label: 'Quick Ask', ...(s.quickKey ? { accelerator: s.quickKey, registerAccelerator: false } : {}), click: () => a.quickAsk() },
    { label: 'New Chat', click: () => a.newChat() },
    { type: 'separator' },
    s.routinesPaused
      ? { label: 'Resume Routines', click: () => a.setRoutinesPaused(false) }
      : { label: 'Pause All Routines', click: () => a.setRoutinesPaused(true) },
    { type: 'separator' },
    { label: 'Open SahilBot', click: () => a.showMain() },
    { label: 'Settings…', click: () => a.settings() },
    { type: 'separator' },
    { label: 'Quit SahilBot', click: () => a.quit() }
  )
  return items
}

// ---------------------------------------------------------------- the icon itself (Electron)

let cachedIcon: NativeImage | null = null
function icon(): NativeImage {
  if (cachedIcon) return cachedIcon
  const img = nativeImage.createFromBuffer(encodePng(16, 16, glyphPixels(16)), { scaleFactor: 1 })
  img.addRepresentation({ scaleFactor: 2, width: 16, height: 16, buffer: encodePng(32, 32, glyphPixels(32)) })
  img.setTemplateImage(true)
  cachedIcon = img
  return img
}

/** Owns the Tray. Never create one in hidden (test) runs. */
export class MenuBarIcon {
  private tray: Tray | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private state: () => TrayState, private actions: TrayActions) {}

  get shown(): boolean { return !!this.tray && !this.tray.isDestroyed() }

  setEnabled(on: boolean): void {
    if (on && !this.shown) {
      this.tray = new Tray(icon())
      this.tray.setIgnoreDoubleClickEvents(true)
      this.render()
    } else if (!on && this.tray) {
      if (!this.tray.isDestroyed()) this.tray.destroy()
      this.tray = null
    }
  }

  /** Re-renders soon (events come in bursts). */
  refresh(): void {
    if (!this.shown || this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.render() }, 250)
  }

  private render(): void {
    if (!this.tray || this.tray.isDestroyed()) return
    let s: TrayState
    try { s = this.state() } catch { return }
    this.tray.setTitle(trayTitle(s.working.length, s.needsYou.length), { fontType: 'monospacedDigit' })
    this.tray.setToolTip(trayTooltip(s.working.length, s.needsYou.length, s.routinesPaused))
    this.tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(s, this.actions)))
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.setEnabled(false)
  }
}
