import { bestSize, shorten, textHeightPt, wrapLines, type FitPara } from './fit'
import { fitBox, loadImage } from './image'
import { onColor, readable, seriesColors, themeOf, type ThemeName } from './theme'

// PowerPoint decks (16:9) with a consistent theme (light or dark, accent color, one font pair) and real
// layouts: title, section, bullets, two-column, image + text, image, native charts (bar, column, line,
// area, pie, doughnut), table, stats, quote, closing. Speaker notes and slide numbers. Text never
// overflows: font sizes are fitted per box, long bullets are shortened (full text kept in the notes)
// and slides that still don't fit continue on a new slide.
//
// Public API (also used by the live document editor for export):
//   renderPptx(slides: SlideSpec[], options?: DeckOptions): Promise<Buffer>
//   buildPptx(slides, options) → { buffer, warnings, slides }

export interface ChartSpec {
  type: 'bar' | 'column' | 'line' | 'area' | 'pie' | 'doughnut'
  categories: string[]
  series: Array<{ name: string; values: number[] }>
  title?: string
  /** Excel number format for values and axis, e.g. '$#,##0', '0%', '#,##0.0'. */
  number_format?: string
  show_values?: boolean
  stacked?: boolean
}

export type SlideLayout = 'title' | 'bullets' | 'two_column' | 'section' | 'quote' | 'image' | 'image_text' | 'chart' | 'table' | 'stats' | 'closing'

export interface SlideSpec {
  title: string
  subtitle?: string
  /** Bullet points; indent a sub-point with two leading spaces. */
  bullets?: string[]
  notes?: string
  table?: Array<Array<string | number>>
  layout?: SlideLayout
  /** Right column (two_column). */
  right?: string[]
  left_title?: string
  right_title?: string
  /** Image file path or data: URI (image, image_text). */
  image?: string
  image_side?: 'left' | 'right'
  caption?: string
  chart?: ChartSpec
  /** Big numbers (stats): up to 4. */
  stats?: Array<{ value: string; label: string }>
}

export interface DeckOptions {
  title?: string
  author?: string
  company?: string
  accent?: string
  /** Background: light (default) or dark. */
  theme?: 'light' | 'dark'
  /** The look shared with the documents: modern (default), classic, minimal (fonts, accent, table style). */
  style?: ThemeName
  font?: string
  headingFont?: string
  /** Slide numbers on every slide but the title slide (default true). */
  slideNumbers?: boolean
  /** Small text at the bottom left of content slides. */
  footer?: string
  baseDir?: string
  readImage?: (src: string) => Buffer
}

const W = 13.333, H = 7.5
const X = 0.7, CW = W - 1.4
const BODY_BOTTOM = 6.75
const hex = (c: string | undefined, d: string): string => (/^#?[0-9a-f]{6}$/i.test(c ?? '') ? c!.replace('#', '').toUpperCase() : d)

interface Theme { bg: string; ink: string; muted: string; soft: string; line: string; titleBg: string; titleInk: string; titleMuted: string }
const THEMES: Record<'light' | 'dark', Theme> = {
  light: { bg: 'FFFFFF', ink: '1A1A1A', muted: '5F6368', soft: 'F3F4F6', line: 'E5E7EB', titleBg: '111827', titleInk: 'FFFFFF', titleMuted: 'D1D5DB' },
  dark: { bg: '0F1117', ink: 'F3F4F6', muted: 'A1A1AA', soft: '1B1F2A', line: '2B3040', titleBg: '07080C', titleInk: 'FFFFFF', titleMuted: 'A1A1AA' }
}

const PALETTE = ['0EA5E9', '10B981', 'F59E0B', 'EF4444', '8B5CF6', '14B8A6', 'EC4899', '64748B']

interface Bullet { text: string; level: number }
const bulletsOf = (items: string[] | undefined): Bullet[] =>
  (items ?? []).map((raw) => {
    const m = /^(\s*)(?:[-*•]\s+)?(.*)$/.exec(raw)!
    return { text: m[2].trim(), level: Math.min(2, Math.floor(m[1].replace(/\t/g, '  ').length / 2)) }
  }).filter((b) => b.text)

const paras = (bs: Bullet[], size: number): FitPara[] => bs.map((b) => ({ text: b.text, size: b.level ? Math.max(12, size - 2) : size, level: b.level, bullet: true, spaceAfter: Math.round(size * 0.45) }))

const SIZES = [24, 22, 20, 18]
const MAX_BULLET = 170

/** Long bullets get shortened on the slide; the full text goes to the speaker notes. */
function trimBullets(bs: Bullet[], max = MAX_BULLET): { bullets: Bullet[]; moved: string[] } {
  const moved: string[] = []
  const bullets = bs.map((b) => {
    if (b.text.length <= max) return b
    moved.push(b.text)
    return { ...b, text: shorten(b.text, Math.round(max * 0.8)) }
  })
  return { bullets, moved }
}

/** Most bullet lines and words one slide carries (review_document warns above 8 lines / 110 words). */
const MAX_LINES = 7, MAX_WORDS = 100
const wordCount = (bs: Bullet[]): number => bs.reduce((n, b) => n + (b.text.match(/\S+/g) ?? []).length, 0)

/** Splits bullets into chunks that each fit (w × h) at `size` and stay readable; sub-points stay with their parent. */
function chunkBullets(bs: Bullet[], w: number, h: number, size: number): Bullet[][] {
  const groups: Bullet[][] = []
  for (const b of bs) if (b.level === 0 || !groups.length) groups.push([b]); else groups[groups.length - 1].push(b)
  const out: Bullet[][] = [[]]
  for (const g of groups) {
    const trial = [...out[out.length - 1], ...g]
    const tooBig = textHeightPt(paras(trial, size), w) > h * 72 || trial.length > MAX_LINES || wordCount(trial) > MAX_WORDS
    if (out[out.length - 1].length && tooBig) out.push([...g])
    else out[out.length - 1] = trial
  }
  // Balance: the same number of top-level points per slide where the space allows.
  const chunks = out.filter((c) => c.length)
  if (chunks.length > 1) {
    const per = Math.ceil(groups.length / chunks.length)
    const even = Array.from({ length: chunks.length }, (_, k) => groups.slice(k * per, (k + 1) * per).flat()).filter((c) => c.length)
    if (even.every((c) => textHeightPt(paras(c, size), w) <= h * 72 && c.length <= MAX_LINES + 1 && wordCount(c) <= MAX_WORDS + 10)) return even
  }
  return chunks
}

interface Planned extends SlideSpec { cont?: boolean; size?: number; rightSize?: number }

/** Expands specs into the slides that will be drawn: fitted sizes, shortened bullets, continuation slides. */
export function planSlides(slides: SlideSpec[], warnings: string[] = []): Planned[] {
  const out: Planned[] = []
  slides.forEach((s, idx) => {
    const layout = layoutOf(s, idx)
    const top = bodyTop(s)
    const bodyH = BODY_BOTTOM - top
    const noteWith = (extra: string[]): string | undefined => (extra.length ? [s.notes, `Full text:\n${extra.map((t) => `- ${t}`).join('\n')}`].filter(Boolean).join('\n\n') : s.notes)
    if (layout === 'bullets' || (layout === 'chart' && s.bullets?.length) || layout === 'image_text') {
      const w = layout === 'bullets' ? CW : layout === 'chart' ? 4.2 : 5.9
      const { bullets, moved } = trimBullets(bulletsOf(s.bullets))
      const dense = bullets.length > MAX_LINES + 1 || wordCount(bullets) > MAX_WORDS + 10
      const size = bestSize((z) => paras(bullets, z), w, bodyH, SIZES)
      if ((size && !dense) || layout !== 'bullets') {
        const z = size ?? bestSize((q) => paras(bullets, q), w, bodyH, [16, 14, 12]) ?? 12
        if (!size) warnings.push(`Slide ${idx + 1} ("${s.title}"): text is long for this layout; set at ${z} pt.`)
        out.push({ ...s, layout, bullets: bullets.map(toStr), notes: noteWith(moved), size: z })
        return
      }
      const chunks = chunkBullets(bullets, w, bodyH, 20)
      warnings.push(`Slide ${idx + 1} ("${s.title}") had too much text for one slide: continued on ${chunks.length} slides.`)
      chunks.forEach((c, i) => out.push({ ...s, layout, title: i ? `${s.title} (cont.)` : s.title, bullets: c.map(toStr), notes: i ? undefined : noteWith(moved), size: bestSize((z) => paras(c, z), w, bodyH, [...SIZES, 16, 14]) ?? 14, cont: i > 0 }))
      return
    }
    if (layout === 'two_column') {
      const colH = bodyH - (s.left_title || s.right_title ? 0.6 : 0)
      const L = trimBullets(bulletsOf(s.bullets), 140), R = trimBullets(bulletsOf(s.right), 140)
      const fit = (bs: Bullet[]) => bestSize((z) => paras(bs, z), 5.8, colH, [...SIZES, 16, 14]) ?? 14
      const size = Math.min(fit(L.bullets), fit(R.bullets))
      if (size <= 14) warnings.push(`Slide ${idx + 1} ("${s.title}"): columns are dense; set at ${size} pt.`)
      out.push({ ...s, layout, bullets: L.bullets.map(toStr), right: R.bullets.map(toStr), notes: noteWith([...L.moved, ...R.moved]), size })
      return
    }
    if (layout === 'table' && s.table?.length) {
      const [head, ...rows] = s.table
      const pages = tableRowPages(head, rows, bodyH)
      if (pages.length > 1) warnings.push(`Slide ${idx + 1} ("${s.title}"): ${rows.length} rows continued on ${pages.length} slides.`)
      pages.forEach((p, i) => out.push({ ...s, layout, title: i ? `${s.title} (cont.)` : s.title, table: [head, ...p.rows], size: p.size, notes: i ? undefined : s.notes, cont: i > 0 }))
      return
    }
    out.push({ ...s, layout })
  })
  return out
}

const toStr = (b: Bullet): string => `${'  '.repeat(b.level)}${b.text}`

function layoutOf(s: SlideSpec, i: number): SlideLayout {
  if (s.layout) return s.layout
  if (s.chart) return 'chart'
  if (s.table?.length) return 'table'
  if (s.stats?.length) return 'stats'
  if (s.image) return s.bullets?.length ? 'image_text' : 'image'
  if (s.right?.length) return 'two_column'
  return i === 0 && !s.bullets?.length ? 'title' : 'bullets'
}

const titleSize = (t: string): { size: number; lines: number } => {
  for (const z of [32, 30, 28, 26]) if (wrapLines(t, z, CW * 72 - 12, true) === 1) return { size: z, lines: 1 }
  for (const z of [26, 24, 22]) if (wrapLines(t, z, CW * 72 - 12, true) <= 2) return { size: z, lines: 2 }
  return { size: 20, lines: 3 }
}
const bodyTop = (s: SlideSpec): number => {
  const t = titleSize(s.title)
  const extra = t.lines > 1 ? 0.45 * (t.lines - 1) : 0
  return (s.subtitle ? 1.9 : 1.5) + extra
}

function colWidths(rows: Array<Array<string | number>>, total: number): number[] {
  const n = Math.max(...rows.map((r) => r.length))
  const weights = Array.from({ length: n }, (_, c) => Math.min(36, Math.max(6, Math.max(...String(rows[0]?.[c] ?? '').split(/\s+/).map((w) => w.length)) * 1.15 + 2, ...rows.slice(1).map((r) => String(r[c] ?? '').length + 1))))
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => (w / sum) * total)
}

function tableRowPages(head: Array<string | number>, rows: Array<Array<string | number>>, bodyH: number): Array<{ rows: Array<Array<string | number>>; size: number }> {
  const widths = colWidths([head, ...rows], CW)
  const rowH = (r: Array<string | number>, size: number) => Math.max(...widths.map((w, c) => wrapLines(String(r[c] ?? ''), size, w * 72 - 16))) * size * 1.2 / 72 + (size * 0.9) / 72 + 0.04
  for (const size of [20, 18, 16, 14, 13, 12]) {
    const total = [head, ...rows].reduce((h, r) => h + rowH(r, size), 0)
    if (total <= bodyH) return [{ rows, size }]
  }
  const size = 12
  const pages: Array<{ rows: Array<Array<string | number>>; size: number }> = []
  let curRows: Array<Array<string | number>> = [], h = rowH(head, size)
  for (const r of rows) {
    const rh = rowH(r, size)
    if (curRows.length && h + rh > bodyH) { pages.push({ rows: curRows, size }); curRows = []; h = rowH(head, size) }
    curRows.push(r); h += rh
  }
  if (curRows.length) pages.push({ rows: curRows, size })
  // Even pages: the same number of rows on each slide (as far as the heights allow).
  const per = Math.ceil(rows.length / pages.length)
  const even = Array.from({ length: pages.length }, (_, k) => rows.slice(k * per, (k + 1) * per)).filter((r) => r.length)
  const fitsAll = even.every((rs) => [head, ...rs].reduce((h2, r) => h2 + rowH(r, size), 0) <= bodyH)
  return fitsAll ? even.map((r) => ({ rows: r, size })) : pages
}

const isNum = (v: unknown): boolean => typeof v === 'number' || (typeof v === 'string' && /^\s*[-+(]?[$€£¥]?\s*-?\d[\d,]*(\.\d+)?\s*%?[)]?\s*[kmbx]?\s*$/i.test(v))

export async function renderPptx(slides: SlideSpec[], options: DeckOptions = {}): Promise<Buffer> {
  return (await buildPptx(slides, options)).buffer
}

export async function buildPptx(input: SlideSpec[], o: DeckOptions = {}): Promise<{ buffer: Buffer; warnings: string[]; slides: number }> {
  const PptxGenJS = (await import('pptxgenjs')).default
  const p = new PptxGenJS()
  p.layout = 'LAYOUT_WIDE'
  const warnings: string[] = []
  const planned = planSlides(input, warnings)
  p.title = o.title ?? input[0]?.title ?? 'Presentation'
  p.author = o.author ?? 'SahilBot'
  if (o.company) p.company = o.company
  const style = themeOf(o.style, o.accent)
  const A = hex(style.accent, '1F5FAD')
  const T = THEMES[o.theme === 'dark' ? 'dark' : 'light']
  // Accent as text: darkened (or lightened on dark slides) until it reads; fills keep the accent itself.
  const AT = hex(readable(style.accent, `#${T.bg}`, 4.5), A)
  const ASOFT = hex(readable(style.accent, `#${T.soft}`, 3.2), A)
  const onA = hex(onColor(style.accent), 'FFFFFF')
  const FONT = o.font?.trim() || style.office.body
  const HFONT = o.headingFont?.trim() || (o.font?.trim() ? FONT : style.office.heading)
  p.theme = { headFontFace: HFONT, bodyFontFace: FONT }
  const palette = seriesColors(style, 12).map((c) => c.replace('#', ''))
  void PALETTE
  const numbers = o.slideNumbers !== false
  // Slide masters, so slides added later in PowerPoint get the same design.
  const num = (color: string) => ({ x: W - 1.0, y: H - 0.5, w: 0.6, h: 0.3, fontSize: 10, color, align: 'right' as const, fontFace: FONT })
  p.defineSlideMaster({ title: 'SB_CONTENT', background: { color: T.bg }, objects: [{ rect: { x: 0, y: 0, w: 0.12, h: H, fill: { color: A } } }], ...(numbers ? { slideNumber: num(T.muted) } : {}) } as never)
  p.defineSlideMaster({ title: 'SB_TITLE', background: { color: T.titleBg }, objects: [] } as never)
  p.defineSlideMaster({ title: 'SB_SECTION', background: { color: A }, objects: [], ...(numbers ? { slideNumber: num(onA) } : {}) } as never)

  planned.forEach((s, i) => {
    const layout = s.layout!
    const sl = p.addSlide({ masterName: layout === 'title' || layout === 'closing' ? 'SB_TITLE' : layout === 'section' ? 'SB_SECTION' : 'SB_CONTENT' })
    const chrome = (): void => {
      if (o.footer) sl.addText(o.footer, { x: X, y: H - 0.5, w: 8, h: 0.3, fontSize: 10, color: T.muted, fontFace: FONT })
    }
    const heading = (): number => {
      const t = titleSize(s.title)
      const th = 0.85 + (t.lines - 1) * 0.45
      sl.addText(s.title, { x: X, y: 0.4, w: CW, h: th, fontSize: t.size, bold: true, color: T.ink, fontFace: HFONT, valign: 'bottom', objectName: 'Title', margin: 6 })
      if (s.subtitle) sl.addText(s.subtitle, { x: X, y: 0.4 + th + 0.02, w: CW, h: 0.45, fontSize: 16, color: T.muted, fontFace: FONT, objectName: 'Subtitle', margin: 6 })
      return bodyTop(s)
    }
    const bullets = (items: string[], x: number, y: number, w: number, h: number, size: number): void => {
      const bs = bulletsOf(items)
      if (!bs.length) return
      sl.addText(bs.map((b) => ({ text: b.text, options: { bullet: { indent: 18 }, indentLevel: b.level, fontSize: b.level ? Math.max(12, size - 2) : size, color: b.level ? T.muted : T.ink, paraSpaceAfter: Math.round(size * 0.45), breakLine: true } })),
        { x, y, w, h, fontSize: size, color: T.ink, fontFace: FONT, valign: 'top', objectName: 'Body', margin: 6, fit: 'shrink' })
    }
    switch (layout) {
      case 'title':
      case 'section':
      case 'closing': {
        const big = layout === 'closing' ? 44 : 40
        const fitted = bestSize((z) => [{ text: s.title, size: z, bold: true }], 11.5, 1.9, [big, 36, 32, 28]) ?? 26
        const ink = layout === 'section' ? onA : T.titleInk
        sl.addShape(p.ShapeType.rect, { x: X + 0.18, y: 3.55, w: 1.2, h: 0.08, fill: { color: layout === 'section' ? onA : A }, line: { color: layout === 'section' ? onA : A } })
        sl.addText(s.title, { x: X + 0.1, y: 1.55, w: 11.5, h: 1.9, fontSize: fitted, bold: true, color: ink, fontFace: HFONT, valign: 'bottom', objectName: 'Title', margin: 6 })
        if (s.subtitle) sl.addText(s.subtitle, { x: X + 0.1, y: 3.8, w: 11.5, h: 1.0, fontSize: 20, color: layout === 'section' ? onA : T.titleMuted, fontFace: FONT, valign: 'top', objectName: 'Subtitle', margin: 6 })
        if (s.bullets?.length && layout !== 'title') {
          const bs = bulletsOf(s.bullets)
          const z = bestSize((q) => paras(bs, q), 11.5, 1.9, [18, 16, 14]) ?? 14
          sl.addText(bs.map((b) => ({ text: b.text, options: { bullet: { indent: 16 }, breakLine: true } })), { x: X + 0.1, y: 4.85, w: 11.5, h: 1.9, fontSize: z, color: T.titleMuted, fontFace: FONT, valign: 'top', objectName: 'Body', margin: 6 })
        }
        if (layout === 'closing' && numbers) sl.slideNumber = num(T.titleMuted)
        break
      }
      case 'quote': {
        const q = s.title.replace(/^["“]|["”]$/g, '')
        const z = bestSize((x) => [{ text: `“${q}”`, size: x }], 10.9, 3.2, [34, 30, 26, 22, 20]) ?? 18
        sl.addShape(p.ShapeType.rect, { x: 1.2, y: 1.6, w: 0.08, h: 3.0, fill: { color: A }, line: { color: A } })
        sl.addText(`“${q}”`, { x: 1.5, y: 1.4, w: 10.6, h: 3.4, fontSize: z, italic: true, color: T.ink, fontFace: 'Georgia', valign: 'middle', objectName: 'Quote', margin: 6 })
        if (s.subtitle) sl.addText(`— ${s.subtitle}`, { x: 1.5, y: 4.9, w: 10.6, h: 0.6, fontSize: 18, color: T.muted, fontFace: FONT, objectName: 'Attribution' })
        chrome()
        break
      }
      case 'two_column': {
        const top = heading()
        let y = top
        const size = s.size ?? 20
        if (s.left_title || s.right_title) {
          if (s.left_title) sl.addText(s.left_title, { x: X, y: top, w: 5.8, h: 0.5, fontSize: 18, bold: true, color: AT, fontFace: HFONT, objectName: 'Column title', margin: 6 })
          if (s.right_title) sl.addText(s.right_title, { x: X + 6.13, y: top, w: 5.8, h: 0.5, fontSize: 18, bold: true, color: AT, fontFace: HFONT, objectName: 'Column title', margin: 6 })
          y += 0.6
        }
        bullets(s.bullets ?? [], X, y, 5.8, BODY_BOTTOM - y, size)
        sl.addShape(p.ShapeType.line, { x: X + 5.96, y, w: 0, h: BODY_BOTTOM - y - 0.2, line: { color: T.line, width: 1 } })
        bullets(s.right ?? [], X + 6.13, y, 5.8, BODY_BOTTOM - y, size)
        chrome()
        break
      }
      case 'image':
      case 'image_text': {
        const top = heading()
        const h = BODY_BOTTOM - top - (s.caption ? 0.45 : 0)
        const right = s.image_side === 'right'
        const boxW = layout === 'image' ? CW : 5.7
        const boxX = layout === 'image' ? X : right ? X + CW - boxW : X
        if (s.image) {
          try {
            const img = loadImage(s.image, o.baseDir, o.readImage)
            const f = fitBox(img.width, img.height, boxW * 100, h * 100)
            const w = f.width / 100, hh = f.height / 100
            sl.addImage({ data: `image/${img.type === 'jpg' ? 'jpeg' : img.type};base64,${img.data.toString('base64')}`, x: boxX + (boxW - w) / 2, y: top + (h - hh) / 2, w, h: hh, altText: s.caption ?? s.title })
          } catch (e) {
            warnings.push(`Slide ${i + 1}: ${(e as Error).message}`)
          }
        }
        if (s.caption) sl.addText(s.caption, { x: boxX, y: top + h + 0.05, w: boxW, h: 0.4, fontSize: 12, italic: true, color: T.muted, align: 'center', fontFace: FONT, objectName: 'Caption' })
        if (layout === 'image_text') bullets(s.bullets ?? [], right ? X : X + 6.1, top, 5.9, BODY_BOTTOM - top, s.size ?? 20)
        chrome()
        break
      }
      case 'chart': {
        const top = heading()
        const c = s.chart
        const withText = !!s.bullets?.length
        const box = { x: X, y: top, w: withText ? 7.5 : CW, h: BODY_BOTTOM - top }
        if (c?.categories?.length && c.series?.length) {
          const type = c.type === 'column' ? 'bar' : c.type
          const pie = type === 'pie' || type === 'doughnut'
          const series = (pie ? c.series.slice(0, 1) : c.series).map((x) => ({ name: x.name, labels: c.categories.map(String), values: c.categories.map((_, k) => Number(x.values[k] ?? 0)) }))
          const fmt = c.number_format
          sl.addChart(type as never, series, {
            ...box,
            chartColors: pie ? palette.slice(0, Math.max(1, c.categories.length)).concat(PALETTE).slice(0, c.categories.length) : palette.slice(0, series.length),
            barDir: c.type === 'bar' ? 'bar' : 'col',
            barGrouping: c.stacked ? 'stacked' : 'clustered',
            barGapWidthPct: 60,
            showLegend: pie || series.length > 1,
            legendPos: pie ? 'r' : 'b',
            legendFontSize: 12,
            legendColor: T.ink,
            legendFontFace: FONT,
            showValue: c.show_values ?? (pie || c.categories.length * series.length <= 12),
            showPercent: pie && c.show_values === undefined,
            dataLabelFontSize: 11,
            dataLabelColor: pie ? 'FFFFFF' : T.ink,
            ...(fmt ? { dataLabelFormatCode: fmt, valAxisLabelFormatCode: fmt } : {}),
            catAxisLabelColor: T.muted,
            valAxisLabelColor: T.muted,
            catAxisLabelFontSize: 12,
            valAxisLabelFontSize: 11,
            catAxisLabelFontFace: FONT,
            valAxisLabelFontFace: FONT,
            catAxisLineShow: true,
            valAxisLineShow: false,
            catAxisLineColor: T.line,
            valGridLine: { color: T.line, size: 0.75 },
            catGridLine: { style: 'none' },
            lineSize: 3,
            lineDataSymbol: 'circle',
            lineDataSymbolSize: 7,
            holeSize: 58,
            ...(c.title ? { showTitle: true, title: c.title, titleFontSize: 14, titleColor: T.ink, titleFontFace: HFONT } : {}),
            altText: c.title ?? s.title
          } as never)
          const lens = c.series.map((x) => x.values.length)
          if (lens.some((n) => n !== c.categories.length)) warnings.push(`Slide ${i + 1}: chart series lengths (${lens.join(', ')}) don't match ${c.categories.length} categories; missing values were drawn as 0.`)
        } else {
          warnings.push(`Slide ${i + 1} ("${s.title}"): chart layout without chart data (categories and series).`)
        }
        if (withText) bullets(s.bullets!, X + 7.8, top, CW - 7.8, BODY_BOTTOM - top, s.size ?? 18)
        chrome()
        break
      }
      case 'table': {
        const top = heading()
        const [head, ...rows] = s.table ?? [[]]
        const n = Math.max(head.length, ...rows.map((r) => r.length))
        const widths = colWidths([head, ...rows], CW)
        const numeric = Array.from({ length: n }, (_, c) => rows.length > 0 && rows.every((r) => r[c] === undefined || r[c] === '' || isNum(r[c])))
        const size = s.size ?? 14
        const fmt = (v: string | number | undefined) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v ?? ''))
        sl.addTable([
          Array.from({ length: n }, (_, c) => ({ text: fmt(head[c]), options: { bold: true, color: o.theme === 'dark' ? T.ink : hex(style.ink, '1A1A1A'), fill: { color: o.theme === 'dark' ? T.soft : hex(style.accentTint, 'EEF3FB') }, align: numeric[c] ? 'right' : 'left', border: [{ type: 'none' }, { type: 'none' }, { type: 'solid', color: A, pt: 1.5 }, { type: 'none' }] } })),
          ...rows.map((r, k) => Array.from({ length: n }, (_, c) => ({ text: fmt(r[c]), options: { color: T.ink, bold: /^(sub)?total\b/i.test(String(r[0] ?? '')), fill: { color: k % 2 ? T.soft : T.bg }, align: numeric[c] ? 'right' : 'left', border: [{ type: 'none' }, { type: 'none' }, { type: 'solid', color: T.line, pt: 0.75 }, { type: 'none' }] } })))
        ] as never, { x: X, y: top, w: CW, colW: widths, fontSize: size, fontFace: FONT, valign: 'middle', margin: [Math.round(size * 0.45), 8, Math.round(size * 0.45), 8], objectName: 'Table' } as never)
        chrome()
        break
      }
      case 'stats': {
        const top = heading()
        const st = (s.stats ?? []).slice(0, 4)
        if ((s.stats?.length ?? 0) > 4) warnings.push(`Slide ${i + 1}: only the first 4 stats are shown.`)
        const gap = 0.35
        const w = st.length ? (CW - gap * (st.length - 1)) / st.length : CW
        const cardH = s.bullets?.length ? 2.2 : 2.5
        st.forEach((x, k) => {
          const cx = X + k * (w + gap)
          sl.addShape(p.ShapeType.roundRect, { x: cx, y: top + 0.2, w, h: cardH, fill: { color: T.soft }, line: { color: T.line, width: 0.75 }, rectRadius: 0.12 })
          const vz = bestSize((z) => [{ text: x.value, size: z, bold: true }], w - 0.3, 1.2, [54, 48, 42, 36, 30, 24]) ?? 22
          sl.addText(x.value, { x: cx + 0.15, y: top + 0.45, w: w - 0.3, h: 1.3, fontSize: vz, bold: true, color: ASOFT, fontFace: HFONT, align: 'center', valign: 'middle', objectName: 'Stat' })
          const lz = bestSize((z) => [{ text: x.label, size: z }], w - 0.5, cardH - 1.75, [16, 14, 12]) ?? 11
          sl.addText(x.label, { x: cx + 0.15, y: top + 1.8, w: w - 0.3, h: cardH - 1.65, fontSize: lz, color: T.muted, fontFace: FONT, align: 'center', valign: 'top', objectName: 'Stat label' })
        })
        if (s.bullets?.length) bullets(s.bullets, X, top + cardH + 0.45, CW, BODY_BOTTOM - top - cardH - 0.45, 18)
        chrome()
        break
      }
      default: {
        const top = heading()
        bullets(s.bullets ?? [], X, top, CW, BODY_BOTTOM - top, s.size ?? 22)
        chrome()
      }
    }
    if (s.notes) sl.addNotes(s.notes)
  })
  const raw = (await p.write({ outputType: 'nodebuffer' })) as Buffer
  // Bullets in the accent color (pptxgenjs has no bullet color; without one some viewers draw them black on dark slides).
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(raw)
  for (const f of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const xml = await zip.file(f)!.async('string')
    if (xml.includes('<a:buChar')) zip.file(f, xml.replace(/<a:buSzPct val="100000"\/><a:buChar/g, `<a:buClr><a:srgbClr val="${A}"/></a:buClr><a:buSzPct val="100000"/><a:buChar`))
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  return { buffer, warnings, slides: planned.length }
}
