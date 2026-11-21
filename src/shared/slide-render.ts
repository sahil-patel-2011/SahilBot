import type { DocStyle } from './types'
import { slideLayout, statsOf, textPoints, type Slide } from './slides'
import { chartSvg, chartTable, donutSvg } from './dashboard'

// One look for a deck everywhere: the editor's canvas, the thumbnails, Present, and the PDF, PNG and
// picture-PowerPoint exports all draw slides from this file at 1280 × 720 (16:9), so what you see while
// editing is exactly what you send.
//
//   title    the first slide: a dark slide with the kicker, a big title, a subtitle, a short description
//            and a row of big-number stats along the bottom
//   section  a slide with only a title: dark, big title
//   bullets  a light slide: kicker, title, points (sub-points indented), stats, footer with the page number
//   image    a picture (image_text: points on the left, the picture on the right)

export const SLIDE_W = 1280
export const SLIDE_H = 720

export interface DeckLook {
  dark: string; darkInk: string; darkMuted: string; light: string; ink: string; muted: string; kicker: string; accent: string; line: string
  font: string; headingWeight: number
}

const LOOKS: Record<'modern' | 'classic' | 'minimal', Omit<DeckLook, 'font'>> = {
  modern: { dark: '#0F1A2B', darkInk: '#FFFFFF', darkMuted: '#B6C0D0', light: '#FFFFFF', ink: '#111827', muted: '#4B5563', kicker: '#F08A4B', accent: '#E2711D', line: '#E5E7EB', headingWeight: 800 },
  classic: { dark: '#2E1A1A', darkInk: '#FBF6EE', darkMuted: '#D8C9B4', light: '#FBF8F3', ink: '#1C1B19', muted: '#5E5A55', kicker: '#C8A15A', accent: '#7A2E2E', line: '#E3DCD0', headingWeight: 700 },
  minimal: { dark: '#111111', darkInk: '#FFFFFF', darkMuted: '#A3A3A3', light: '#FFFFFF', ink: '#111111', muted: '#525252', kicker: '#737373', accent: '#111111', line: '#E5E5E5', headingWeight: 700 }
}
const FONTS = { modern: '"Helvetica Neue", Helvetica, Arial, sans-serif', classic: 'Georgia, "Times New Roman", serif', minimal: 'Helvetica, Arial, sans-serif' }

export function deckLook(style?: DocStyle): DeckLook {
  const t = style?.theme === 'classic' || style?.theme === 'minimal' ? style.theme : 'modern'
  return { ...LOOKS[t], font: style?.font ? `"${style.font}", ${FONTS[t]}` : FONTS[t] }
}

/** The CSS for slides under `.sbdeck` (a 1280 × 720 `.sl` per slide). */
export function deckCss(look: DeckLook): string {
  return `
.sbdeck { --d:${look.dark}; --di:${look.darkInk}; --dm:${look.darkMuted}; --l:${look.light}; --i:${look.ink}; --m:${look.muted}; --k:${look.kicker}; --a:${look.accent}; --ln:${look.line}; font-family:${look.font}; }
.sbdeck .sl { position:relative; width:${SLIDE_W}px; height:${SLIDE_H}px; box-sizing:border-box; overflow:hidden; background:var(--l); color:var(--i); padding:72px 96px 80px; display:flex; flex-direction:column; -webkit-font-smoothing:antialiased; }
.sbdeck .sl * { box-sizing:border-box; }
.sbdeck .sl.dark { background:var(--d); color:var(--di); }
.sbdeck .sl-k { font-size:15px; letter-spacing:.16em; text-transform:uppercase; color:var(--k); font-weight:600; margin:0 0 18px; min-height:18px; }
.sbdeck .sl-h { margin:0; font-weight:${look.headingWeight}; letter-spacing:-.02em; line-height:1.08; font-size:54px; }
.sbdeck .sl-sub { font-size:34px; line-height:1.25; margin-top:14px; font-weight:500; }
.sbdeck .sl-desc { font-size:20px; line-height:1.5; color:var(--dm); margin-top:24px; max-width:760px; }
.sbdeck .sl-pts { list-style:none; margin:30px 0 0; padding:0; font-size:28px; line-height:1.42; display:flex; flex-direction:column; gap:14px; }
.sbdeck .sl-pts li { position:relative; padding-left:30px; }
.sbdeck .sl-pts li::before { content:''; position:absolute; left:2px; top:.6em; width:10px; height:10px; border-radius:50%; background:var(--a); }
.sbdeck .sl-pts li.i1 { margin-left:36px; font-size:24px; color:var(--m); }
.sbdeck .sl-pts li.i1::before { width:8px; height:8px; background:transparent; border:2px solid var(--a); }
.sbdeck .sl-pts li.i2, .sbdeck .sl-pts li.i3 { margin-left:72px; font-size:22px; color:var(--m); }
.sbdeck .sl-stats { margin-top:auto; display:flex; gap:56px; border-top:1px solid var(--ln); padding-top:22px; }
.sbdeck .sl.dark .sl-stats { border-color:rgba(255,255,255,.18); }
.sbdeck .sl-stat b { display:block; font-size:38px; font-weight:${look.headingWeight}; letter-spacing:-.01em; }
.sbdeck .sl-stat span { display:block; font-size:13px; letter-spacing:.12em; text-transform:uppercase; color:var(--m); margin-top:4px; }
.sbdeck .sl.dark .sl-stat span { color:var(--dm); }
.sbdeck .sl-title { justify-content:flex-start; padding-top:120px; }
.sbdeck .sl-title .sl-h { font-size:112px; letter-spacing:-.035em; }
.sbdeck .sl-section { justify-content:center; }
.sbdeck .sl-section .sl-h { font-size:80px; }
.sbdeck .sl-section .sl-sub { color:var(--dm); }
.sbdeck .sl-bullets::before, .sbdeck .sl-image_text::before, .sbdeck .sl-image::before { content:''; position:absolute; left:0; top:0; bottom:0; width:10px; background:var(--a); }
.sbdeck .sl-cols { display:flex; gap:48px; flex:1; min-height:0; }
.sbdeck .sl-cols > .sl-text { flex:1; min-width:0; display:flex; flex-direction:column; }
.sbdeck .sl-img { flex:0 0 46%; margin:0; display:flex; align-items:center; justify-content:center; min-height:0; }
.sbdeck .sl-image .sl-img { flex:1; margin-top:24px; }
.sbdeck .sl-img img { max-width:100%; max-height:100%; object-fit:contain; border-radius:10px; }
.sbdeck .sl-foot { position:absolute; left:96px; right:64px; bottom:30px; display:flex; justify-content:space-between; font-size:13px; color:var(--m); letter-spacing:.04em; }
.sbdeck .sl.dark .sl-foot { color:var(--dm); }
.sbdeck .sl b, .sbdeck .sl strong { font-weight:700; }
.sbdeck .sl-chart { margin-top:22px; flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; font-size:15px; }
.sbdeck .sl-chart svg { width:100%; max-height:400px; }
.sbdeck .sl-chart .db-legend { display:flex; gap:18px; font-size:15px; color:var(--m); margin-bottom:8px; flex-wrap:wrap; }
.sbdeck .sl-chart .db-legend i { display:inline-block; width:12px; height:12px; border-radius:3px; margin-right:6px; vertical-align:-1px; }
.sbdeck .sl-chart .db-donut { display:flex; align-items:center; gap:40px; } .sbdeck .sl-chart .db-donut svg { width:340px; height:340px; flex:none; } .sbdeck .sl-chart .db-legend-col { flex-direction:column; font-size:22px; color:var(--i); }
.sbdeck .sl-table { margin-top:26px; border-collapse:collapse; font-size:22px; width:100%; }
.sbdeck .sl-table th { text-align:left; font-weight:700; border-bottom:2px solid var(--a); padding:10px 14px; }
.sbdeck .sl-table td { border-bottom:1px solid var(--ln); padding:10px 14px; }
`
}

/** A slide's chart (a ```chart block with CSV or a Markdown table) as SVG, in the deck's colors. */
export function slideChartHtml(s: Slide, look: DeckLook): string {
  const b = (s.extra ?? []).find((x) => x.type === 'code' && /^chart$/i.test(x.lang ?? ''))
  const t = b ? chartTable(b.text ?? '') : null
  if (!t) return ''
  const colors = [look.accent, look.kicker, '#2F6FD6', '#1F8A4C', '#7C3AED']
  return `<div class="sl-chart">${donutSvg(t, colors) ?? chartSvg(t, colors) ?? ''}</div>`
}

/** A slide's tables (kept in slide.extra) as HTML. */
export function slideTablesHtml(s: Slide): string {
  return (s.extra ?? []).filter((b) => b.type === 'table' && b.rows?.length).slice(0, 1).map((b) => {
    const rows = b.rows!.slice(0, 9)
    const [head, ...body] = b.header === false ? [undefined, ...rows] : rows
    return `<table class="sl-table">${head ? `<thead><tr>${head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${body.map((r) => `<tr>${(r ?? []).map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  }).join('')
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline Markdown (bold, italics, code, links) as safe HTML. */
export function inlineHtml(s: string): string {
  return esc(s)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

export interface SlidePieces {
  layout: ReturnType<typeof slideLayout>
  dark: boolean
  subtitle?: string
  description: string[]
  bullets: Slide['points']
  stats: Array<{ value: string; label: string }>
}

/** How a slide is laid out: which points are the subtitle, the description, the bullets and the stats. */
export function slidePieces(s: Slide, index: number): SlidePieces {
  const layout = slideLayout(s, index)
  const text = textPoints(s)
  const stats = statsOf(s).slice(0, 5)
  const dark = layout === 'title' || layout === 'section'
  if (layout === 'title' || layout === 'section') return { layout, dark, subtitle: text[0]?.text, description: text.slice(1).map((p) => p.text), bullets: [], stats }
  return { layout, dark, description: [], bullets: text, stats }
}

/** One slide as static HTML (thumbnails, Present, exports). `img` turns a picture's path into a URL. */
export function slideHtml(s: Slide, index: number, o: { total: number; deckTitle: string; img?: (src: string) => string | undefined | null; look?: DeckLook }): string {
  const p = slidePieces(s, index)
  const k = s.kicker?.trim() ? `<div class="sl-k">${inlineHtml(s.kicker)}</div>` : ''
  const h = `<h1 class="sl-h">${inlineHtml(s.title) || '&nbsp;'}</h1>`
  const stats = p.stats.length ? `<div class="sl-stats">${p.stats.map((x) => `<div class="sl-stat"><b>${inlineHtml(x.value)}</b><span>${inlineHtml(x.label)}</span></div>`).join('')}</div>` : ''
  const src = s.image ? o.img?.(s.image) : undefined
  const pic = s.image ? `<figure class="sl-img">${src ? `<img src="${esc(src)}" alt="">` : ''}</figure>` : ''
  const foot = p.dark ? '' : `<div class="sl-foot"><span>${inlineHtml(o.deckTitle)}</span><span>${index + 1}</span></div>`
  let body: string
  if (p.dark) {
    body = `${k}${h}${p.subtitle ? `<div class="sl-sub">${inlineHtml(p.subtitle)}</div>` : ''}${p.description.length ? `<div class="sl-desc">${p.description.map(inlineHtml).join('<br>')}</div>` : ''}${stats}`
  } else {
    const list = p.bullets.length ? `<ul class="sl-pts">${p.bullets.map((b) => `<li class="i${Math.min(3, b.indent ?? 0)}">${inlineHtml(b.text)}</li>`).join('')}</ul>` : ''
    const tables = slideChartHtml(s, o.look ?? deckLook()) + slideTablesHtml(s)
    body = p.layout === 'image_text' ? `<div class="sl-cols"><div class="sl-text">${k}${h}${list}${tables}${stats}</div>${pic}</div>` : `${k}${h}${list}${tables}${p.layout === 'image' ? pic : ''}${stats}`
  }
  return `<section class="sl sl-${p.layout}${p.dark ? ' dark' : ''}">${body}${foot}</section>`
}

/** The whole deck as a printable page: one 1280 × 720 page per slide (PDF export). */
export function deckDocument(slides: Slide[], o: { title: string; style?: DocStyle; img?: (src: string) => string | undefined | null }): string {
  const look = deckLook(o.style)
  const pages = slides.map((s, i) => slideHtml(s, i, { total: slides.length, deckTitle: o.title, img: o.img, look })).join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)}</title><style>
@page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }
html, body { margin:0; padding:0; background:#fff; }
.sbdeck .sl { page-break-after: always; break-after: page; }
.sbdeck .sl:last-child { page-break-after: auto; break-after: auto; }
${deckCss(look)}</style></head><body><div class="sbdeck">${pages}</div></body></html>`
}

/** A single slide as its own page (PNG export). */
export function slideDocument(s: Slide, index: number, o: { total: number; title: string; style?: DocStyle; img?: (src: string) => string | undefined | null }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html, body { margin:0; padding:0; overflow:hidden; } ${deckCss(deckLook(o.style))}</style></head><body><div class="sbdeck">${slideHtml(s, index, { total: o.total, deckTitle: o.title, img: o.img, look: deckLook(o.style) })}</div></body></html>`
}
