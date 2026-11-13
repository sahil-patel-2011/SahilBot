// Screen geometry for computer use. macOS input (CGEvent) and Accessibility positions are in global
// screen POINTS: origin at the top-left of the main display, y down, other displays at offsets (which
// can be negative). Screenshots are PIXELS: Retina displays have 2 pixels per point, and SahilBot then
// resizes the image to what the model should see. Every screenshot records a Frame so the x,y a model
// reads off that image map back to the exact screen point.

export interface Rect { x: number; y: number; width: number; height: number }

export interface DisplayInfo {
  id: number
  /** Global points. */
  bounds: Rect
  /** Pixels per point (2 on Retina). */
  scaleFactor: number
  primary: boolean
}

/** How one screenshot image maps onto the screen. */
export interface Frame {
  /** The screen area the image shows, in global points. */
  rect: Rect
  /** Image size in pixels. */
  width: number
  height: number
  /** What it showed (for messages): "display 1", "window Notes", "region". */
  what: string
  at: number
}

/**
 * Image size to send for a screen area. Full displays: one image pixel per point, shrunk to fit
 * maxEdge (and maxPixels). Windows and regions (zoom): up to the Retina pixel density, so small text
 * stays sharp, within the same limits. Never upscaled past the real pixels.
 */
export function fitImage(rect: Rect, scaleFactor: number, o: { maxEdge: number; maxPixels?: number; zoom?: boolean }): { width: number; height: number } {
  const density = o.zoom ? Math.max(1, scaleFactor) : 1
  const w = rect.width * density
  const h = rect.height * density
  let k = Math.min(1, o.maxEdge / Math.max(w, h))
  if (o.maxPixels) k = Math.min(k, Math.sqrt(o.maxPixels / (w * h)))
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

/**
 * Screenshot limits for the model that will look at the image. Documented high-resolution Claude
 * models (Opus 4.7, 4.8, 5, 5.5; Sonnet 5; Fable/Mythos) take up to 2576 px on the long edge, and the
 * reference recommends ~1080p screenshots for computer use as the balance of accuracy and cost. Every
 * other model (older Claude, Sonnet 5.5 and Haiku 5.5 until documented, local models): 1568 px on the
 * long edge, so the API never shrinks the image behind our back and click coordinates stay exact.
 */
export function imageLimits(model?: string): { maxEdge: number; maxPixels: number } {
  const hiRes = !!model && /^claude-(opus-(4-[78]|5)|sonnet-5(?!-5)|fable|mythos)/i.test(model)
  return hiRes ? { maxEdge: 1920, maxPixels: 1920 * 1080 } : { maxEdge: 1568, maxPixels: 1568 * 1568 }
}

export function makeFrame(rect: Rect, width: number, height: number, what: string, at = Date.now()): Frame {
  return { rect, width, height, what, at }
}

/** A pixel in a screenshot → the global screen point under it. */
export function toScreen(f: Frame, x: number, y: number): { x: number; y: number } {
  return { x: f.rect.x + (x * f.rect.width) / f.width, y: f.rect.y + (y * f.rect.height) / f.height }
}

/** A global screen point → its pixel in a screenshot (undefined when outside the image). */
export function toImage(f: Frame, x: number, y: number): { x: number; y: number } | undefined {
  const px = ((x - f.rect.x) * f.width) / f.rect.width
  const py = ((y - f.rect.y) * f.height) / f.rect.height
  return px >= 0 && py >= 0 && px <= f.width && py <= f.height ? { x: Math.round(px), y: Math.round(py) } : undefined
}

export const contains = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height

/** The display a point is on, if any. */
export function displayAt(displays: DisplayInfo[], x: number, y: number): DisplayInfo | undefined {
  return displays.find((d) => contains(d.bounds, x, y))
}

/** A display by its 1-based number (1 = main), as screenshot lists them. */
export function displayByNumber(displays: DisplayInfo[], n?: number): DisplayInfo | undefined {
  return ordered(displays)[(n ?? 1) - 1]
}

/** Main display first, then left to right, top to bottom. */
export function ordered(displays: DisplayInfo[]): DisplayInfo[] {
  return [...displays].sort((a, b) => Number(b.primary) - Number(a.primary) || a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
}

/** A rectangle clipped to the displays it overlaps (screencapture can't capture off-screen space). */
export function clipToDisplays(r: Rect, displays: DisplayInfo[]): Rect | undefined {
  let best: Rect | undefined
  let area = 0
  for (const d of displays) {
    const x = Math.max(r.x, d.bounds.x)
    const y = Math.max(r.y, d.bounds.y)
    const x2 = Math.min(r.x + r.width, d.bounds.x + d.bounds.width)
    const y2 = Math.min(r.y + r.height, d.bounds.y + d.bounds.height)
    const a = Math.max(0, x2 - x) * Math.max(0, y2 - y)
    if (a > area) { area = a; best = { x, y, width: x2 - x, height: y2 - y } }
  }
  return best
}

export function center(r: Rect): { x: number; y: number } {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
}

/** Short display list for the model: "1 (main) 1512×982 pt @2x; 2 2560×1440 pt @2x at (1512, 0)". */
export function describeDisplays(displays: DisplayInfo[]): string {
  return ordered(displays).map((d, i) => `${i + 1}${d.primary ? ' (main)' : ''} ${d.bounds.width}×${d.bounds.height} pt @${d.scaleFactor}x${d.primary ? '' : ` at (${d.bounds.x}, ${d.bounds.y})`}`).join('; ')
}
