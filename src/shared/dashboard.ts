import type { DocBlock, DocStyle } from './types'
import { statOf } from './slides'
import { inlineHtml } from './slide-render'

// Native dashboards: a live document whose content.kind is 'dashboard', drawn as a dashboard. The blocks
// are the source (so the bot's doc tools, history and merging work unchanged):
//   ## heading            a section
//   - **$4.2M** Revenue   a stat tile (a bold number, then its label); "- **12%** Churn · down 2 pts" adds a note
//   a table               a chart from its number columns (labels = the first column) and the table under it
//   other lists, text     notes in the section; an image shows as is
// Drawn by the editor's view and by the PDF and HTML exports from this one function.

export interface Tile { value: string; label: string; note?: string }
export interface DashTable { header: string[]; rows: string[][] }
export interface Section { title: string; tiles: Tile[]; tables: DashTable[]; notes: string[]; bullets: string[]; images: string[] }

export function blocksToDashboard(blocks: DocBlock[]): Section[] {
  const out: Section[] = []
  let cur: Section | undefined
  const start = (title: string): Section => { const s: Section = { title, tiles: [], tables: [], notes: [], bullets: [], images: [] }; out.push(s); return s }
  for (const b of blocks) {
    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') { cur = start(b.text ?? ''); continue }
    cur ??= start('')
    const t = (b.text ?? '').trim()
    if ((b.type === 'bullet' || b.type === 'numbered' || b.type === 'check') && t) {
      const [main, ...rest] = t.split(/\s+·\s+/)
      const note = rest.join(' · ')
      const st = statOf(main)
      if (st) cur.tiles.push({ ...st, ...(note ? { note } : {}) })
      else cur.bullets.push(t)
    } else if (b.type === 'table' && b.rows?.length) {
      const [header, ...rows] = b.header === false ? [b.rows[0].map((_, i) => `Column ${i + 1}`), ...b.rows] : b.rows
      cur.tables.push({ header, rows })
    } else if ((b.type === 'p' || b.type === 'callout' || b.type === 'quote') && t) cur.notes.push(t)
    else if (b.type === 'image' && b.src) cur.images.push(b.src)
  }
  return out.filter((s) => s.title || s.tiles.length || s.tables.length || s.notes.length || s.bullets.length || s.images.length)
}

/** "$4,200", "12.5%", "1.2k", "(300)" → a number, or null. */
export function numberOf(v: string): number | null {
  const s = v.trim().replace(/[$€£¥,\s]/g, '').replace(/^[−–]/, '-').replace(/^\+/, '')
  const m = /^(\()?(-?\d+(?:\.\d+)?)(\))?(%|k|m|b)?$/i.exec(s)
  if (!m) return null
  let n = Number(m[2])
  if (m[1] && m[3]) n = -n
  const unit = (m[4] ?? '').toLowerCase()
  return unit === 'k' ? n * 1e3 : unit === 'm' ? n * 1e6 : unit === 'b' ? n * 1e9 : n
}

const PALETTE: Record<'modern' | 'classic' | 'minimal', string[]> = {
  modern: ['#2F6FD6', '#E2711D', '#1F8A4C', '#7C3AED', '#D93025'],
  classic: ['#7A2E2E', '#C8A15A', '#3B5B4A', '#4A4A7A', '#8A5A2B'],
  minimal: ['#111111', '#737373', '#A3A3A3', '#404040', '#D4D4D4']
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const short = (n: number): string => Math.abs(n) >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(2)}`

/** A chart (SVG) of a table's number columns: a line for 7+ rows over time, otherwise bars. */
export function chartSvg(t: DashTable, colors: string[]): string | null {
  const cols = t.header.map((_, c) => c).filter((c) => c > 0 && t.rows.length > 0 && t.rows.every((r) => r[c] === undefined || r[c].trim() === '' || numberOf(r[c]) !== null) && t.rows.some((r) => numberOf(r[c] ?? '') !== null)).slice(0, 4)
  if (!cols.length || t.rows.length < 2) return null
  const W = 720, H = 280, L = 56, R = 16, T = 18, B = 42
  // A blank cell is a gap (no bar, a break in the line), not a zero.
  const vals = cols.map((c) => t.rows.map((r) => numberOf(r[c] ?? '')))
  const known = vals.flat().filter((v): v is number => v !== null)
  const max = Math.max(0, ...known), min = Math.min(0, ...known)
  const span = max - min || 1
  const y = (v: number): number => T + (H - T - B) * (1 - (v - min) / span)
  const n = t.rows.length
  const line = n >= 7 && /^(date|day|week|month|year|quarter|q\d|period|time)/i.test(t.header[0] ?? '') || n >= 12
  const step = (W - L - R) / n
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = min + span * f; return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6b7280">${esc(short(v))}</text>` }).join('')
  const every = Math.ceil(n / 12)
  const labels = t.rows.map((r, i) => (i % every === 0 ? `<text x="${L + step * (i + 0.5)}" y="${H - B + 18}" text-anchor="middle" font-size="11" fill="#6b7280">${esc((r[0] ?? '').slice(0, 12))}</text>` : '')).join('')
  let marks: string
  if (line) {
    marks = vals.map((vs, k) => {
      const runs: string[][] = [[]]
      vs.forEach((v, i) => { if (v === null) { if (runs[runs.length - 1].length) runs.push([]) } else runs[runs.length - 1].push(`${(L + step * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`) })
      return runs.filter((r) => r.length).map((r) => r.length === 1 ? `<circle cx="${r[0].split(',')[0]}" cy="${r[0].split(',')[1]}" r="3" fill="${colors[k % colors.length]}"/>` : `<polyline fill="none" stroke="${colors[k % colors.length]}" stroke-width="2.5" stroke-linejoin="round" points="${r.join(' ')}"/>`).join('')
    }).join('')
  } else {
    const bw = Math.max(3, (step * 0.72) / cols.length)
    marks = vals.map((vs, k) => vs.map((v, i) => { if (v === null) return ''; const x = L + step * i + step * 0.14 + bw * k; const top = y(Math.max(v, 0)), bot = y(Math.min(v, 0)); return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" rx="2" fill="${colors[k % colors.length]}"/>` }).join('')).join('')
  }
  const legend = cols.length > 1 ? `<div class="db-legend">${cols.map((c, k) => `<span><i style="background:${colors[k % colors.length]}"></i>${esc(t.header[c])}</span>`).join('')}</div>` : `<div class="db-legend"><span>${esc(t.header[cols[0]])}</span></div>`
  return `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.header.slice(1).join(', '))} by ${esc(t.header[0] ?? '')}">${grid}${marks}${labels}</svg>`
}

export function dashboardCss(style?: DocStyle): string {
  const font = style?.font ? `"${style.font}", ` : ''
  const base = style?.theme === 'classic' ? 'Georgia, serif' : '"Helvetica Neue", Helvetica, Arial, sans-serif'
  return `
.sbdash { font-family:${font}${base}; color:#111827; }
.sbdash h1 { font-size:28px; margin:0 0 4px; letter-spacing:-.01em; }
.sbdash .db-sub { color:#6b7280; font-size:13px; margin-bottom:18px; }
.sbdash section { margin:0 0 22px; }
.sbdash h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#6b7280; margin:0 0 10px; font-weight:600; }
.sbdash .db-tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:12px; margin-bottom:12px; }
.sbdash .db-tile { border:1px solid #e5e7eb; border-radius:14px; padding:14px 16px; background:#fff; break-inside:avoid; }
.sbdash .db-tile b { display:block; font-size:28px; letter-spacing:-.01em; }
.sbdash .db-tile span { display:block; font-size:12.5px; color:#6b7280; margin-top:2px; }
.sbdash .db-tile em { display:block; font-style:normal; font-size:12px; margin-top:6px; color:#374151; }
.sbdash .db-card { border:1px solid #e5e7eb; border-radius:14px; padding:14px 16px; background:#fff; margin-bottom:12px; break-inside:avoid; }
.sbdash .db-card svg { width:100%; height:auto; display:block; }
.sbdash .db-legend { display:flex; gap:14px; font-size:12px; color:#374151; margin-bottom:6px; flex-wrap:wrap; }
.sbdash .db-legend i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:-1px; }
.sbdash table { width:100%; border-collapse:collapse; font-size:13px; margin-top:10px; }
.sbdash th { text-align:left; font-weight:600; color:#6b7280; border-bottom:1px solid #e5e7eb; padding:6px 8px; }
.sbdash td { border-bottom:1px solid #f1f5f9; padding:6px 8px; }
.sbdash td.n, .sbdash th.n { text-align:right; font-variant-numeric:tabular-nums; }
.sbdash ul { margin:6px 0 10px; padding-left:20px; font-size:14px; line-height:1.55; }
.sbdash p { font-size:14px; line-height:1.55; color:#374151; margin:6px 0; }
.sbdash img { max-width:100%; border-radius:10px; }
`
}

/** The dashboard as HTML (the editor's view; wrapped by dashboardDocument for exports). */
export function dashboardHtml(title: string, blocks: DocBlock[], o: { style?: DocStyle; img?: (src: string) => string | null | undefined; subtitle?: string } = {}): string {
  const colors = PALETTE[o.style?.theme === 'classic' || o.style?.theme === 'minimal' ? o.style.theme : 'modern']
  const sections = blocksToDashboard(blocks).map((s) => {
    const tiles = s.tiles.length ? `<div class="db-tiles">${s.tiles.map((t) => `<div class="db-tile"><b>${inlineHtml(t.value)}</b><span>${inlineHtml(t.label)}</span>${t.note ? `<em>${inlineHtml(t.note)}</em>` : ''}</div>`).join('')}</div>` : ''
    const tables = s.tables.map((t) => {
      const chart = chartSvg(t, colors)
      const num = t.header.map((_, c) => c > 0 && t.rows.every((r) => !r[c]?.trim() || numberOf(r[c]) !== null))
      const table = `<table><thead><tr>${t.header.map((h, c) => `<th${num[c] ? ' class="n"' : ''}>${inlineHtml(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr>${t.header.map((_, c) => `<td${num[c] ? ' class="n"' : ''}>${inlineHtml(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      return `<div class="db-card">${chart ?? ''}${table}</div>`
    }).join('')
    const bullets = s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${inlineHtml(b)}</li>`).join('')}</ul>` : ''
    const notes = s.notes.map((n) => `<p>${inlineHtml(n)}</p>`).join('')
    const imgs = s.images.map((src) => { const u = o.img?.(src); return u ? `<div class="db-card"><img src="${esc(u)}" alt=""></div>` : '' }).join('')
    return `<section>${s.title ? `<h2>${inlineHtml(s.title)}</h2>` : ''}${tiles}${tables}${bullets}${notes}${imgs}</section>`
  }).join('')
  return `<div class="sbdash"><h1>${inlineHtml(title)}</h1>${o.subtitle ? `<div class="db-sub">${esc(o.subtitle)}</div>` : ''}${sections || '<p>Add a section (## Heading), stats like “- **$4.2M** Revenue”, or a table to chart.</p>'}</div>`
}

/** A printable page (PDF and HTML exports). */
export function dashboardDocument(title: string, blocks: DocBlock[], o: { style?: DocStyle; img?: (src: string) => string | null | undefined } = {}): string {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page { size: letter landscape; margin: 0.5in; } html, body { margin:0; background:#fff; } body { padding: 0; } ${dashboardCss(o.style)}</style></head><body>${dashboardHtml(title, blocks, { ...o, subtitle: `Updated ${date}` })}</body></html>`
}
