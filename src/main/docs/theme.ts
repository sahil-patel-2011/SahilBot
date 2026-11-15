// Document themes shared by every format, so a report, its slide deck and its workbook look like one family:
// the same palette, type scale, table style and callout colors. Fonts differ by format on purpose: PDFs embed
// macOS fonts (subsets, as Pages and Preview do), while Word and PowerPoint files name fonts installed on
// every Mac and every Windows PC (not Office-only fonts like Calibri, which Quick Look and Pages replace
// with Times), so the file looks the same on the recipient's machine and in the render check.
//
//   modern   (default) Avenir Next / Arial. Clean sans, accent headings, tinted table headers.
//   classic  Charter + Iowan Old Style / Georgia. Book-like serif, booktabs tables, small-caps labels.
//   minimal  Helvetica Neue / Helvetica (Arial on Windows). Black and grey, one accent, hairline tables.
//
// Colors are checked for contrast: an accent too light to read as text (yellow, light orange) keeps its hue
// but is darkened for text and table headers; it is still used as-is for rules and chart fills.

export type ThemeName = 'modern' | 'classic' | 'minimal'
export const THEME_NAMES: ThemeName[] = ['modern', 'classic', 'minimal']

export interface DocTheme {
  name: ThemeName
  /** The accent as given (rules, chart series, cover band). */
  accent: string
  /** The accent darkened until it reads as text on white (≥ 4.5:1): headings, links, labels. */
  accentText: string
  /** A very light tint of the accent (table header fill, cover panel). */
  accentTint: string
  ink: string
  muted: string
  faint: string
  line: string
  band: string
  /** PDF (Chromium, macOS fonts). CSS font stacks. */
  pdf: { body: string; heading: string; mono: string; size: number; leading: number; headingWeight: number }
  /** Word / PowerPoint font names. */
  office: { body: string; heading: string; mono: string }
  /** Heading sizes in points: title, h1, h2, h3, h4. */
  scale: { title: number; h1: number; h2: number; h3: number; h4: number }
  table: 'tinted' | 'booktabs' | 'hairline'
  /** Section headings as small uppercase labels with letter spacing (minimal) or regular. */
  labels: 'caps' | 'regular'
  tones: Record<'note' | 'tip' | 'important' | 'warning' | 'caution', { label: string; color: string; fill: string }>
}

export const DEFAULT_ACCENT: Record<ThemeName, string> = { modern: '#1F5FAD', classic: '#7A2E2E', minimal: '#111111' }

const CJK = '"Hiragino Sans", "PingFang SC", "Apple SD Gothic Neo", "Hiragino Mincho ProN"'
const EMOJI = '"Apple Color Emoji"'

const TONES: DocTheme['tones'] = {
  note: { label: 'Note', color: '#2457A6', fill: '#EEF3FB' },
  tip: { label: 'Tip', color: '#1E7A46', fill: '#EDF7F1' },
  important: { label: 'Important', color: '#5B3CA8', fill: '#F3F0FA' },
  warning: { label: 'Warning', color: '#9A5B00', fill: '#FDF6E9' },
  caution: { label: 'Caution', color: '#B42318', fill: '#FDF0EF' }
}

// ------------------------------------------------------------------ color

export const hex6 = (c: string | undefined): string | undefined => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((c ?? '').trim())
  if (!m) return undefined
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1]
  return `#${h.toUpperCase()}`
}

const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const toHex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`

export function luminance(h: string): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  const [r, g, b] = rgb(h)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG contrast ratio between two #RRGGBB colors (1-21). */
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Mixes `h` toward `to` by t (0-1). */
export function mix(h: string, to: string, t: number): string {
  const [r1, g1, b1] = rgb(h), [r2, g2, b2] = rgb(to)
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
}

/** The color darkened (or lightened, on a dark background) in small steps until it has `min` contrast with `bg`. */
export function readable(h: string, bg = '#FFFFFF', min = 4.5): string {
  let c = h
  const toward = luminance(bg) > 0.4 ? '#000000' : '#FFFFFF'
  for (let i = 0; i < 40 && contrast(c, bg) < min; i++) c = mix(c, toward, 0.06)
  return c
}

/** White or near-black, whichever reads better on `bg`. */
export const onColor = (bg: string): string => (contrast('#FFFFFF', bg) >= contrast('#1A1A1A', bg) ? '#FFFFFF' : '#1A1A1A')

// ------------------------------------------------------------------ themes

export function themeOf(name: string | undefined, accent?: string): DocTheme {
  const n: ThemeName = (THEME_NAMES as string[]).includes(name ?? '') ? (name as ThemeName) : 'modern'
  const a = hex6(accent) ?? DEFAULT_ACCENT[n]
  const accentText = readable(a, '#FFFFFF', 4.5)
  const base = { name: n, accent: a, accentText, accentTint: mix(a, '#FFFFFF', 0.9), tones: TONES }
  switch (n) {
    case 'classic':
      return {
        ...base,
        ink: '#1C1B19', muted: '#5E5A55', faint: '#8A857E', line: '#D9D4CC', band: '#F7F5F1',
        pdf: { body: `Charter, "Iowan Old Style", Georgia, ${CJK}, serif, ${EMOJI}`, heading: `"Iowan Old Style", Charter, Georgia, ${CJK}, serif`, mono: 'Menlo, monospace', size: 11, leading: 1.5, headingWeight: 700 },
        office: { body: 'Georgia', heading: 'Georgia', mono: 'Courier New' },
        scale: { title: 30, h1: 19, h2: 15, h3: 12.5, h4: 11 },
        table: 'booktabs', labels: 'regular'
      }
    case 'minimal':
      return {
        ...base,
        ink: '#151515', muted: '#5C5C5C', faint: '#8C8C8C', line: '#E2E2E2', band: '#F7F7F7',
        pdf: { body: `"Helvetica Neue", Helvetica, Arial, ${CJK}, sans-serif, ${EMOJI}`, heading: `"Helvetica Neue", Helvetica, Arial, ${CJK}, sans-serif`, mono: 'Menlo, monospace', size: 10, leading: 1.55, headingWeight: 500 },
        office: { body: 'Helvetica', heading: 'Helvetica', mono: 'Courier New' },
        scale: { title: 28, h1: 17, h2: 13.5, h3: 11, h4: 10 },
        table: 'hairline', labels: 'caps'
      }
    default:
      return {
        ...base,
        ink: '#17191C', muted: '#555B64', faint: '#868C95', line: '#D8DCE2', band: '#F5F7F9',
        pdf: { body: `"Avenir Next", "Helvetica Neue", Arial, ${CJK}, sans-serif, ${EMOJI}`, heading: `"Avenir Next", "Helvetica Neue", Arial, ${CJK}, sans-serif`, mono: 'Menlo, monospace', size: 10.5, leading: 1.5, headingWeight: 600 },
        office: { body: 'Arial', heading: 'Arial', mono: 'Courier New' },
        scale: { title: 30, h1: 20, h2: 15, h3: 12.5, h4: 11 },
        table: 'tinted', labels: 'regular'
      }
  }
}

/** Series colors for charts: the accent first, then a palette that stays distinct in print and for color-blind readers. */
export function seriesColors(t: DocTheme, n: number): string[] {
  const base = t.name === 'minimal'
    ? [t.accent, '#7A7A7A', '#B5B5B5', '#3D3D3D', '#9E9E9E', '#D0D0D0']
    : [t.accent, '#E69F00', '#009E73', '#56B4E9', '#CC79A7', '#D55E00', '#0072B2', '#999999']
  const out = [base[0], ...base.slice(1).filter((c) => c.toUpperCase() !== t.accent.toUpperCase())]
  // An accent near grey-blue with a light second series: fall back to a darker companion.
  return Array.from({ length: n }, (_, i) => (i < out.length ? out[i] : mix(out[i % out.length], '#000000', 0.25 * Math.floor(i / out.length))))
}
