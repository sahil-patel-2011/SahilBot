// Text fitting for slides: how tall a block of text is at a font size in a box of a given width.
// The deck generator uses it to pick font sizes and split slides; review_document uses the same
// estimate to flag text that overflows its box, so a deck that passes here looks right in PowerPoint.

export interface FitPara {
  text: string
  /** Points. */
  size: number
  /** Indent level (0 = top level bullet). */
  level?: number
  bullet?: boolean
  /** Points after the paragraph. */
  spaceAfter?: number
  bold?: boolean
}

/** Average glyph width as a fraction of the font size (sans-serif, mixed case), a little generous. */
const CHAR_EM = 0.53

/** Text box insets in points: PowerPoint's defaults are 0.1" left/right and 0.05" top/bottom. */
export interface Insets { h: number; v: number }
export const DEFAULT_INSETS: Insets = { h: 7.2, v: 3.6 }
/** The insets the deck generator gives its text boxes (margin: 6 pt). */
export const DECK_INSETS: Insets = { h: 6, v: 6 }

/** Lines a paragraph wraps to in `widthPt` (greedy word wrap, like PowerPoint). */
export function wrapLines(text: string, sizePt: number, widthPt: number, bold = false): number {
  const charW = sizePt * (bold ? CHAR_EM + 0.04 : CHAR_EM)
  const perLine = Math.max(4, Math.floor(widthPt / charW))
  let lines = 0
  for (const hard of text.split('\n')) {
    let len = 0
    let n = 1
    for (const w of hard.split(/\s+/).filter(Boolean)) {
      let wl = w.length
      // Words longer than a line break across lines.
      while (wl > perLine) { if (len) { n++; len = 0 } n++; wl -= perLine }
      if (len === 0) len = wl
      else if (len + 1 + wl <= perLine) len += 1 + wl
      else { n++; len = wl }
    }
    lines += n
  }
  return Math.max(1, lines)
}

/** Height in points of paragraphs in a text box `widthIn` inches wide (insets included). */
export function textHeightPt(paras: FitPara[], widthIn: number, insets: Insets = DECK_INSETS, lineSpacing = 1.2): number {
  let h = insets.v * 2
  for (const p of paras) {
    const indent = (p.bullet ? 0.3 : 0) * 72 + (p.level ?? 0) * 0.4 * 72
    const width = widthIn * 72 - insets.h * 2 - indent
    h += wrapLines(p.text, p.size, width, p.bold) * p.size * lineSpacing + (p.spaceAfter ?? 0)
  }
  return h
}

/** True when the paragraphs fit a box of widthIn × heightIn inches. */
export function fits(paras: FitPara[], widthIn: number, heightIn: number, insets: Insets = DECK_INSETS): boolean {
  return textHeightPt(paras, widthIn, insets) <= heightIn * 72
}

/** The largest size in `sizes` (descending) at which the text fits, or undefined. */
export function bestSize(make: (size: number) => FitPara[], widthIn: number, heightIn: number, sizes: number[]): number | undefined {
  return sizes.find((s) => fits(make(s), widthIn, heightIn))
}

/** Shortens text to at most `max` characters at a sentence or word boundary. */
export function shorten(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  const sentence = /^(.+?[.!?])(\s|$)/.exec(t)
  if (sentence && sentence[1].length <= max && sentence[1].length >= max * 0.35) return sentence[1]
  const cut = t.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[,;:\s–—-]+$/, '')}…`
}
