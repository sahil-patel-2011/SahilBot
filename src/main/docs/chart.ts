import { seriesColors, type DocTheme } from './theme'

// Charts for PDFs as inline SVG (vector, crisp at any zoom, selectable text): column, bar, line, area, pie and
// doughnut, with "nice" axis ticks, light gridlines, a legend when there's more than one series, and values
// formatted with Excel-style codes ("$#,##0", "0.0%", "#,##0"). Word and PowerPoint get native charts from the
// same spec (docx.ts, pptx.ts), so a chart looks the same in every format.

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export interface ChartSpec {
  type: 'bar' | 'column' | 'line' | 'area' | 'pie' | 'doughnut'
  categories: Array<string | number>
  series: Array<{ name: string; values: Array<number | null> }>
  title?: string
  /** Excel number format for values and axis, e.g. '$#,##0', '0%', '#,##0.0'. */
  number_format?: string
  show_values?: boolean
  stacked?: boolean
  /** Caption under the chart ("Figure n: …" is added). */
  caption?: string
}

/** Checks a chart spec; returns problems (empty when it's drawable). */
export function chartProblems(c: Partial<ChartSpec> | undefined): string[] {
  const p: string[] = []
  if (!c || typeof c !== 'object') return ['Chart needs {type, categories, series}.']
  if (!['bar', 'column', 'line', 'area', 'pie', 'doughnut'].includes(String(c.type))) p.push(`Chart type "${c.type}" isn't one of column, bar, line, area, pie, doughnut.`)
  if (!Array.isArray(c.categories) || !c.categories.length) p.push('Chart needs categories.')
  if (!Array.isArray(c.series) || !c.series.length) p.push('Chart needs at least one series {name, values}.')
  else for (const s of c.series) {
    if (!Array.isArray(s?.values)) p.push(`Series "${s?.name ?? '?'}" has no values.`)
    else if (s.values.some((v) => v !== null && !Number.isFinite(Number(v)))) p.push(`Series "${s.name}" has values that aren't numbers.`)
    else if (Array.isArray(c.categories) && s.values.length !== c.categories.length) p.push(`Series "${s.name}" has ${s.values.length} values for ${c.categories.length} categories.`)
  }
  return p
}

/** Formats a number with a small subset of Excel number formats: prefix/suffix text, thousands, decimals, %. */
export function formatNumber(v: number, fmt?: string): string {
  if (!fmt) {
    const abs = Math.abs(v)
    return v.toLocaleString('en-US', { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 })
  }
  const f = fmt.split(';')[v < 0 && fmt.includes(';') ? 1 : 0]
  const pct = /%/.test(f)
  const m = /([#0,]*0?)(?:\.(0+|#+))?/.exec(f.replace(/"[^"]*"/g, '').replace(/[$€£¥]/g, ''))
  const decimals = m?.[2]?.length ?? 0
  const thousands = /,/.test(f.replace(/"[^"]*"/g, ''))
  const n = pct ? v * 100 : v
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: thousands })
  const prefix = (/^((?:"[^"]*"|[$€£¥]|\s)*)/.exec(f)?.[1] ?? '').replace(/"/g, '')
  const suffix = (/((?:"[^"]*"|[%\sA-Za-z])*)$/.exec(f.replace(/[#0,.]+/g, '#'))?.[1] ?? '').replace(/"/g, '').replace(/^#/, '')
  const neg = v < 0 && !fmt.includes(';') ? '−' : ''
  return `${neg}${prefix}${body}${pct && !suffix.includes('%') ? '%' : suffix}`
}

/** A shared unit for an axis and its labels, so "$5K" and "$15K" sit together (not "$5,000" and "$15K"). */
function unitFor(maxAbs: number): { div: number; suffix: string } {
  return maxAbs >= 1e9 ? { div: 1e9, suffix: 'B' } : maxAbs >= 1e6 ? { div: 1e6, suffix: 'M' } : maxAbs >= 1e4 ? { div: 1e3, suffix: 'K' } : { div: 1, suffix: '' }
}

/** Compact labels in a unit: 12,000 → 12K, 2,400,000 → 2.4M (keeping the format's prefix and %). */
function compact(v: number, fmt: string | undefined, unit: { div: number; suffix: string }, decimals: number): string {
  if (fmt && /%/.test(fmt)) return formatNumber(v, decimals ? fmt : fmt.replace(/\.0+/, ''))
  if (!unit.suffix) return formatNumber(v, fmt ? fmt.replace(/\.[0#]+/, decimals ? '.0' : '') : undefined)
  const prefix = (/^((?:"[^"]*"|[$€£¥])*)/.exec(fmt ?? '')?.[1] ?? '').replace(/"/g, '')
  if (v === 0) return `${prefix}0`
  const n = Math.abs(v) / unit.div
  return `${v < 0 ? '−' : ''}${prefix}${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals })}${unit.suffix}`
}

/** Round axis bounds and step for a value range. */
export function niceScale(min: number, max: number, ticks = 5): { lo: number; hi: number; step: number } {
  if (min === max) { max = min === 0 ? 1 : min * 1.2; if (min > 0) min = 0 }
  const lo0 = Math.min(0, min), hi0 = Math.max(0, max)
  const raw = (hi0 - lo0) / ticks
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag
  return { lo: Math.floor(lo0 / step) * step, hi: Math.ceil(hi0 / step) * step, step }
}

const textW = (s: string, size: number) => s.length * size * 0.55

/** An SVG chart, `width` × `height` in CSS points (it scales to the text column). */
export function chartSvg(c: ChartSpec, t: DocTheme, o: { width?: number; height?: number; font?: string } = {}): string {
  const W = o.width ?? 468, H = o.height ?? (c.type === 'pie' || c.type === 'doughnut' ? 230 : 250)
  const font = o.font ?? t.pdf.body.replace(/"/g, "'")
  const fs = 8.5
  const colors = seriesColors(t, Math.max(c.series.length, c.categories.length))
  const cats = c.categories.map(String)
  const series = c.series.map((s) => ({ name: s.name, values: cats.map((_, k) => (s.values[k] === null || s.values[k] === undefined ? null : Number(s.values[k]))) }))
  const els: string[] = []
  const txt = (x: number, y: number, s: string, a: { anchor?: string; size?: number; fill?: string; weight?: number } = {}) =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${a.size ?? fs}" fill="${a.fill ?? t.muted}" text-anchor="${a.anchor ?? 'start'}"${a.weight ? ` font-weight="${a.weight}"` : ''}>${escapeHtml(s)}</text>`
  let top = 6
  if (c.title) { els.push(txt(0, 12, c.title, { size: 10, fill: t.ink, weight: 600 })); top = 24 }
  const legend = c.type === 'pie' || c.type === 'doughnut' ? false : series.length > 1
  if (legend) {
    let x = 0
    series.forEach((s, i) => {
      els.push(`<rect x="${x}" y="${top}" width="9" height="9" rx="1.5" fill="${colors[i]}"/>`)
      els.push(txt(x + 13, top + 8, s.name, { fill: t.ink }))
      x += 13 + textW(s.name, fs) + 16
    })
    top += 20
  }

  if (c.type === 'pie' || c.type === 'doughnut') {
    const vals = series[0]?.values.map((v) => Math.max(0, v ?? 0)) ?? []
    const total = vals.reduce((a, b) => a + b, 0) || 1
    const r = Math.min((H - top - 8) / 2, W / 4)
    const cx = r + 8, cy = top + (H - top) / 2
    const inner = c.type === 'doughnut' ? r * 0.58 : 0
    let a0 = -Math.PI / 2
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2
      const large = a1 - a0 > Math.PI ? 1 : 0
      const p = (a: number, rr: number) => `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`
      const d = v >= total ? (inner ? `M${p(0, r)} A${r} ${r} 0 1 1 ${p(Math.PI, r)} A${r} ${r} 0 1 1 ${p(0, r)} M${p(0, inner)} A${inner} ${inner} 0 1 0 ${p(Math.PI, inner)} A${inner} ${inner} 0 1 0 ${p(0, inner)}Z` : `M${p(0, r)} A${r} ${r} 0 1 1 ${p(Math.PI, r)} A${r} ${r} 0 1 1 ${p(0, r)}Z`)
        : inner ? `M${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, inner)} A${inner} ${inner} 0 ${large} 0 ${p(a0, inner)}Z` : `M${cx} ${cy} L${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)}Z`
      els.push(`<path d="${d}" fill="${colors[i]}" stroke="#FFFFFF" stroke-width="1.2" fill-rule="evenodd"/>`)
      a0 = a1
    })
    // Legend with values and shares at the right.
    const lx = cx + r + 28
    const rowH = Math.min(18, (H - top) / Math.max(1, cats.length))
    cats.forEach((cat, i) => {
      const y = cy - (cats.length * rowH) / 2 + i * rowH + rowH / 2
      els.push(`<rect x="${lx}" y="${(y - 5).toFixed(1)}" width="9" height="9" rx="1.5" fill="${colors[i]}"/>`)
      const share = `${Math.round((vals[i] / total) * 100)}%`
      els.push(txt(lx + 14, y + 3, cat, { fill: t.ink }))
      els.push(txt(W, y + 3, c.number_format ? `${formatNumber(vals[i], c.number_format)} · ${share}` : share, { anchor: 'end', fill: t.muted }))
    })
    return wrap(els, W, H, font, c)
  }

  const horizontal = c.type === 'bar'
  const stacked = !!c.stacked && (c.type === 'column' || c.type === 'bar' || c.type === 'area')
  const all = stacked
    ? cats.flatMap((_, k) => [series.reduce((a, s) => a + Math.max(0, s.values[k] ?? 0), 0), series.reduce((a, s) => a + Math.min(0, s.values[k] ?? 0), 0)])
    : series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const { lo, hi, step } = niceScale(Math.min(...all, 0), Math.max(...all, 0), horizontal ? 4 : 5)
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(+v.toFixed(10))
  const unit = unitFor(Math.max(Math.abs(lo), Math.abs(hi)))
  const tickDecimals = unit.div > 1 && ticks.some((v) => (v / unit.div) % 1 !== 0) ? 1 : 0
  const tickLabels = ticks.map((v) => compact(v, c.number_format, unit, tickDecimals))
  const valueLabel = (v: number) => compact(v, c.number_format, unit, unit.div > 1 ? 1 : 2)
  const showValues = c.show_values ?? (!stacked && cats.length * series.length <= 12 && c.type !== 'line' && c.type !== 'area')

  if (horizontal) {
    const labelW = Math.min(W * 0.32, Math.max(...cats.map((s) => textW(s, fs))) + 8)
    const x0 = labelW, x1 = W - (showValues ? 36 : 8), y0 = top, y1 = H - 18
    const sx = (v: number) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0)
    ticks.forEach((v, i) => {
      els.push(`<line x1="${sx(v).toFixed(1)}" y1="${y0}" x2="${sx(v).toFixed(1)}" y2="${y1}" stroke="${v === 0 ? t.faint : t.line}" stroke-width="${v === 0 ? 0.8 : 0.5}"/>`)
      els.push(txt(sx(v), y1 + 12, tickLabels[i], { anchor: 'middle' }))
    })
    const band = (y1 - y0) / cats.length
    const barH = Math.min(22, (band * 0.66) / (stacked ? 1 : series.length))
    cats.forEach((cat, k) => {
      const yc = y0 + band * k + band / 2
      els.push(txt(x0 - 6, yc + 3, cat, { anchor: 'end', fill: t.ink }))
      let pos = 0, neg = 0
      series.forEach((s, i) => {
        const v = s.values[k]
        if (v === null) return
        const from = stacked ? (v >= 0 ? pos : neg) : 0
        const to = from + v
        if (stacked) { if (v >= 0) pos = to; else neg = to }
        const y = stacked ? yc - barH / 2 : yc - (barH * series.length) / 2 + i * barH
        const xa = sx(Math.min(from, to)), xb = sx(Math.max(from, to))
        els.push(`<rect x="${xa.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.5, xb - xa).toFixed(1)}" height="${(barH - (stacked ? 0 : 1.5)).toFixed(1)}" fill="${colors[i]}"/>`)
        if (showValues) els.push(txt(xb + 4, y + barH / 2 + 3, valueLabel(v), { fill: t.ink }))
      })
    })
    return wrap(els, W, H, font, c)
  }

  const labelW = Math.max(...tickLabels.map((s) => textW(s, fs))) + 8
  const x0 = labelW, x1 = W - 4, y0 = top + (showValues ? 10 : 2), y1 = H - 20
  const sy = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0)
  ticks.forEach((v, i) => {
    els.push(`<line x1="${x0}" y1="${sy(v).toFixed(1)}" x2="${x1}" y2="${sy(v).toFixed(1)}" stroke="${v === 0 ? t.faint : t.line}" stroke-width="${v === 0 ? 0.8 : 0.5}"/>`)
    els.push(txt(x0 - 6, sy(v) + 3, tickLabels[i], { anchor: 'end' }))
  })
  const band = (x1 - x0) / cats.length
  const every = Math.ceil(Math.max(...cats.map((s) => textW(s, fs) + 6)) / band)
  cats.forEach((cat, k) => { if (k % every === 0) els.push(txt(x0 + band * k + band / 2, y1 + 13, cat, { anchor: 'middle', fill: t.ink })) })
  if (c.type === 'column') {
    const barW = Math.min(46, (band * 0.68) / (stacked ? 1 : series.length))
    cats.forEach((_, k) => {
      const xc = x0 + band * k + band / 2
      let pos = 0, neg = 0
      series.forEach((s, i) => {
        const v = s.values[k]
        if (v === null) return
        const from = stacked ? (v >= 0 ? pos : neg) : 0
        const to = from + v
        if (stacked) { if (v >= 0) pos = to; else neg = to }
        const x = stacked ? xc - barW / 2 : xc - (barW * series.length) / 2 + i * barW
        const ya = sy(Math.max(from, to)), yb = sy(Math.min(from, to))
        els.push(`<rect x="${(x + 0.75).toFixed(1)}" y="${ya.toFixed(1)}" width="${(barW - 1.5).toFixed(1)}" height="${Math.max(0.5, yb - ya).toFixed(1)}" fill="${colors[i]}"/>`)
        if (showValues) els.push(txt(x + barW / 2, ya - 3.5, valueLabel(v), { anchor: 'middle', fill: t.ink, size: 7.5 }))
      })
    })
  } else {
    const xs = (k: number) => x0 + band * k + band / 2
    const base = series.map(() => cats.map(() => 0))
    series.forEach((s, i) => {
      const pts = s.values.map((v, k) => {
        if (v === null) return null
        const b = stacked && i ? base[i - 1][k] : 0
        base[i][k] = b + v
        return { x: xs(k), y: sy(b + v), b: sy(b) }
      })
      const live = pts.filter((p): p is { x: number; y: number; b: number } => !!p)
      if (!live.length) return
      const line = live.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
      if (c.type === 'area') {
        const back = [...live].reverse().map((p) => `L${p.x.toFixed(1)} ${p.b.toFixed(1)}`).join(' ')
        els.push(`<path d="${line} ${back} Z" fill="${colors[i]}" fill-opacity="${stacked ? 0.85 : 0.22}"/>`)
      }
      els.push(`<path d="${line}" fill="none" stroke="${colors[i]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)
      if (c.type === 'line' && live.length <= 24) for (const p of live) els.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="#FFFFFF" stroke="${colors[i]}" stroke-width="1.6"/>`)
      // The last value labelled at the line's end reads better than a legend for one series.
      if (c.type === 'line' && series.length === 1 && c.show_values !== false) { const p = live[live.length - 1]; els.push(txt(p.x, p.y - 7, valueLabel(s.values[s.values.length - 1] ?? 0), { anchor: 'middle', fill: t.ink, size: 7.5 })) }
    })
  }
  return wrap(els, W, H, font, c)
}

function wrap(els: string[], W: number, H: number, font: string, c: ChartSpec): string {
  const desc = `${c.type} chart${c.title ? `: ${c.title}` : ''}. ${c.series.map((s) => `${s.name}: ${c.categories.map((k, i) => `${k} ${s.values[i] ?? 'n/a'}`).join(', ')}`).join('; ')}`
  return `<svg class="chart" role="img" aria-label="${escapeHtml(desc.slice(0, 600))}" viewBox="0 0 ${W} ${H}" width="${W}pt" height="${H}pt" font-family="${escapeHtml(font)}" xmlns="http://www.w3.org/2000/svg">${els.join('')}</svg>`
}
