import { DEFAULT_INSETS, textHeightPt, type FitPara } from './fit'
import { all, child, first, parseXml, textOf, within, type XNode } from './xml'

// Structural read-back of generated (or any) Word and PowerPoint files: styles, headings, TOC, tables,
// images, footnotes, sections, headers/footers, slide shapes with an overflow estimate, charts, notes.
// Used by review_document and the round-trip tests.

async function zipOf(data: Buffer) {
  const JSZip = (await import('jszip')).default
  return JSZip.loadAsync(data)
}

async function part(zip: Awaited<ReturnType<typeof zipOf>>, name: string): Promise<string | undefined> {
  return zip.file(name)?.async('string')
}

// ------------------------------------------------------------------ Word

export interface DocxParagraph {
  i: number
  style: string
  /** Heading level 1-9 when the paragraph is a heading (by style or outline level). */
  heading?: number
  text: string
  inTable: boolean
  inToc: boolean
  /** Explicit run fonts and sizes (points) used in the paragraph. */
  fonts: string[]
  sizes: number[]
  /** Every run is bold. */
  allBold: boolean
  pageBreak: boolean
  numbered: boolean
}

export interface DocxInfo {
  paragraphs: DocxParagraph[]
  headings: Array<{ i: number; level: number; text: string }>
  title?: string
  toc: { present: boolean; entries: number; pageNumbers: boolean }
  tables: Array<{ rows: string[][]; headerRow: boolean; banded: boolean; widths: number[] }>
  images: number
  footnotes: string[]
  sections: Array<{ orientation: 'portrait' | 'landscape'; width: number; height: number }>
  headers: string[]
  footers: string[]
  pageNumberField: boolean
  /** Style ids defined in styles.xml, with their names. */
  styles: Record<string, string>
  words: number
}

const runText = (r: XNode): string => r.children.map((c) => (c.name === 'w:t' ? c.text : c.name === 'w:tab' ? '\t' : c.name === 'w:br' && c.attrs['w:type'] !== 'page' ? '\n' : '')).join('')

function paraText(p: XNode): string {
  return all(p, 'w:r').filter((r) => !within(r, 'w:del')).map(runText).join('')
}

export async function inspectDocx(data: Buffer): Promise<DocxInfo> {
  const zip = await zipOf(data)
  const xml = await part(zip, 'word/document.xml')
  if (!xml) throw new Error('Not a Word document (no word/document.xml).')
  const stylesXml = (await part(zip, 'word/styles.xml')) ?? ''
  const styles: Record<string, string> = {}
  const outline: Record<string, number> = {}
  for (const s of all(parseXml(stylesXml), 'w:style')) {
    const id = s.attrs['w:styleId']
    if (!id) continue
    styles[id] = child(s, 'w:name')?.attrs['w:val'] ?? id
    const ol = first(s, 'w:outlineLvl')?.attrs['w:val']
    if (ol !== undefined) outline[id] = Number(ol) + 1
  }
  const headingLevel = (style: string, p: XNode): number | undefined => {
    const name = (styles[style] ?? style).toLowerCase()
    const m = /^heading\s*(\d)$/.exec(name) ?? /^heading(\d)$/i.exec(style)
    if (m) return Number(m[1])
    const ol = first(child(p, 'w:pPr') ?? p, 'w:outlineLvl')?.attrs['w:val']
    if (ol !== undefined && Number(ol) < 9) return Number(ol) + 1
    return outline[style] && outline[style] < 10 ? outline[style] : undefined
  }

  const root = parseXml(xml)
  const body = first(root, 'w:body') ?? root
  const paragraphs: DocxParagraph[] = []
  let tocEntries = 0, tocPages = false
  const tocSdts = all(body, 'w:sdt').filter((s) => /table of contents/i.test(first(s, 'w:docPartGallery')?.attrs['w:val'] ?? ''))
  const tocField = /\bTOC\s*\\/.test(all(body, 'w:instrText').map((t) => t.text).join(' ')) || all(body, 'w:fldSimple').some((f) => /^\s*TOC\b/.test(f.attrs['w:instr'] ?? ''))
  for (const p of all(body, 'w:p')) {
    const pPr = child(p, 'w:pPr')
    const style = pPr ? child(pPr, 'w:pStyle')?.attrs['w:val'] ?? 'Normal' : 'Normal'
    const text = paraText(p)
    const inToc = /^TOC\d$/i.test(style) || /^toc \d$/i.test(styles[style] ?? '') || tocSdts.some((s) => isInside(p, s))
    if (inToc) {
      if (text.trim() && !/^(contents|table of contents)$/i.test(text.trim())) {
        tocEntries++
        if (/\t\s*\d+\s*$/.test(text) || /\d+\s*$/.test(text)) tocPages = true
      }
      continue
    }
    const runs = all(p, 'w:r')
    const textRuns = runs.filter((r) => runText(r).trim())
    const fonts = [...new Set(textRuns.map((r) => first(r, 'w:rFonts')?.attrs['w:ascii']).filter(Boolean) as string[])]
    const sizes = [...new Set(textRuns.map((r) => Number(first(r, 'w:sz')?.attrs['w:val'] ?? NaN) / 2).filter((n) => Number.isFinite(n)))]
    const allBold = textRuns.length > 0 && textRuns.every((r) => { const b = first(r, 'w:b'); return !!b && b.attrs['w:val'] !== '0' && b.attrs['w:val'] !== 'false' })
    paragraphs.push({
      i: paragraphs.length,
      style,
      heading: headingLevel(style, p),
      text,
      inTable: within(p, 'w:tbl'),
      inToc: false,
      fonts,
      sizes,
      allBold,
      pageBreak: all(p, 'w:br').some((b) => b.attrs['w:type'] === 'page') || !!(pPr && child(pPr, 'w:pageBreakBefore')),
      numbered: !!(pPr && child(pPr, 'w:numPr'))
    })
  }
  const headings = paragraphs.filter((p) => p.heading && !p.inTable && p.text.trim()).map((p) => ({ i: p.i, level: p.heading!, text: p.text.trim() }))
  const title = paragraphs.find((p) => /^title$/i.test(styles[p.style] ?? p.style))?.text.trim()

  const tables = all(body, 'w:tbl').filter((t) => !within(t, 'w:tbl')).map((t) => {
    const rows = all(t, 'w:tr').filter((r) => !isNested(r, t)).map((r) => all(r, 'w:tc').filter((c) => !isNested(c, t)).map((c) => all(c, 'w:p').map(paraText).join('\n').trim()))
    const trs = all(t, 'w:tr').filter((r) => !isNested(r, t))
    const headerRow = !!trs[0] && !!first(trs[0], 'w:tblHeader')
    const fills = trs.map((r) => first(r, 'w:shd')?.attrs['w:fill'] ?? '')
    const banded = fills.length > 3 && fills.slice(1).some((f, i) => f && f !== 'auto' && f !== fills[i])
    const widths = all(first(t, 'w:tblGrid') ?? t, 'w:gridCol').map((g) => Number(g.attrs['w:w'] ?? 0))
    return { rows, headerRow, banded, widths }
  })
  const images = Object.keys(zip.files).filter((f) => /^word\/media\//.test(f)).length

  const fnXml = await part(zip, 'word/footnotes.xml')
  const footnotes = fnXml ? all(parseXml(fnXml), 'w:footnote').filter((f) => !f.attrs['w:type'] || f.attrs['w:type'] === 'normal').map((f) => all(f, 'w:p').map(paraText).join(' ').trim()) : []

  const sections = all(body, 'w:sectPr').map((s) => {
    const sz = first(s, 'w:pgSz')
    const w = Number(sz?.attrs['w:w'] ?? 12240), h = Number(sz?.attrs['w:h'] ?? 15840)
    const orientation: 'portrait' | 'landscape' = sz?.attrs['w:orient'] === 'landscape' || w > h ? 'landscape' : 'portrait'
    return { orientation, width: w, height: h }
  })
  const hf = async (re: RegExp) => {
    const names = Object.keys(zip.files).filter((f) => re.test(f))
    return Promise.all(names.map(async (n) => (await part(zip, n)) ?? ''))
  }
  const headersXml = await hf(/^word\/header\d*\.xml$/)
  const footersXml = await hf(/^word\/footer\d*\.xml$/)
  const flatText = (x: string) => all(parseXml(x), 'w:p').map(paraText).join('\n').trim()
  const fieldIn = (x: string) => /<w:instrText[^>]*>\s*PAGE\b/.test(x) || /w:instr="\s*PAGE\b/.test(x)
  return {
    paragraphs,
    headings,
    title,
    toc: { present: tocSdts.length > 0 || tocField, entries: tocEntries, pageNumbers: tocPages },
    tables,
    images,
    footnotes,
    sections,
    headers: headersXml.map(flatText).filter(Boolean),
    footers: footersXml.map(flatText).filter(Boolean),
    pageNumberField: [...headersXml, ...footersXml].some(fieldIn),
    styles,
    words: paragraphs.reduce((n, p) => n + (p.text.match(/[A-Za-z0-9']+/g) ?? []).length, 0)
  }
}

function isInside(n: XNode, ancestor: XNode): boolean {
  for (let p = n.parent; p; p = p.parent) if (p === ancestor) return true
  return false
}

/** True when n sits in a table nested inside `t`. */
function isNested(n: XNode, t: XNode): boolean {
  for (let p = n.parent; p && p !== t; p = p.parent) if (p.name === 'w:tbl') return true
  return false
}

// ------------------------------------------------------------------ PowerPoint

export interface SlideShape {
  name: string
  /** Inches. */
  x: number
  y: number
  w: number
  h: number
  isTitle: boolean
  paragraphs: Array<{ text: string; size: number; bullet: boolean; level: number; bold: boolean }>
  fonts: string[]
  autofit?: 'shrink' | 'resize' | 'none'
  /** Estimated text height divided by the box height (> 1 overflows). */
  fill: number
}

export interface SlideInfo {
  n: number
  title?: string
  texts: string[]
  notes: string
  shapes: SlideShape[]
  charts: Array<{ type: string; series: number; points: number; title?: string }>
  tables: Array<{ rows: string[][] }>
  images: number
  slideNumber: boolean
  background?: string
}

export interface DeckInfo {
  width: number
  height: number
  slides: SlideInfo[]
  fonts: string[]
}

const EMU = 914400

export async function inspectPptx(data: Buffer): Promise<DeckInfo> {
  const zip = await zipOf(data)
  const pres = await part(zip, 'ppt/presentation.xml')
  if (!pres) throw new Error('Not a PowerPoint file (no ppt/presentation.xml).')
  const sz = first(parseXml(pres), 'p:sldSz')
  const width = Number(sz?.attrs.cx ?? 12192000) / EMU, height = Number(sz?.attrs.cy ?? 6858000) / EMU
  const files = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]))
  const fontsAll = new Set<string>()
  const slides: SlideInfo[] = []
  for (const f of files) {
    const n = Number(f.match(/(\d+)\.xml$/)![1])
    const xml = (await part(zip, f))!
    const root = parseXml(xml)
    const relsXml = (await part(zip, f.replace('slides/', 'slides/_rels/').replace('.xml', '.xml.rels'))) ?? ''
    const rels: Record<string, string> = {}
    for (const r of all(parseXml(relsXml), 'Relationship')) rels[r.attrs.Id] = r.attrs.Target
    const shapes: SlideShape[] = []
    for (const sp of all(root, 'p:sp')) {
      const tx = child(sp, 'p:txBody')
      if (!tx) continue
      const off = first(sp, 'a:off'), ext = first(sp, 'a:ext')
      const name = first(sp, 'p:cNvPr')?.attrs.name ?? ''
      const ph = first(sp, 'p:ph')?.attrs.type
      const body = child(tx, 'a:bodyPr')
      const autofit = body && child(body, 'a:normAutofit') ? 'shrink' : body && child(body, 'a:spAutoFit') ? 'resize' : 'none'
      const defSize = Number(first(tx, 'a:defRPr')?.attrs.sz ?? 1800) / 100
      const fontScale = Number(body && child(body, 'a:normAutofit')?.attrs.fontScale ? Number(child(body, 'a:normAutofit')!.attrs.fontScale) / 100000 : 1)
      const paragraphs = all(tx, 'a:p').map((p) => {
        const rs = all(p, 'a:r')
        const pPr = child(p, 'a:pPr')
        const sizes = rs.map((r) => Number(child(r, 'a:rPr')?.attrs.sz ?? NaN) / 100).filter((x) => Number.isFinite(x))
        for (const r of rs) { const fnt = first(r, 'a:latin')?.attrs.typeface; if (fnt) fontsAll.add(fnt) }
        return {
          text: textOf(p, 'a:t'),
          size: (sizes.length ? Math.max(...sizes) : defSize) * fontScale,
          bullet: !!(pPr && (child(pPr, 'a:buChar') || child(pPr, 'a:buAutoNum'))),
          level: Number(pPr?.attrs.lvl ?? 0),
          bold: rs.length > 0 && rs.every((r) => child(r, 'a:rPr')?.attrs.b === '1')
        }
      }).filter((p) => p.text.trim())
      if (!paragraphs.length) continue
      const fonts = [...new Set(all(tx, 'a:latin').map((l) => l.attrs.typeface).filter(Boolean))]
      const w = Number(ext?.attrs.cx ?? 0) / EMU, h = Number(ext?.attrs.cy ?? 0) / EMU
      const spacing = all(tx, 'a:spcAft').map((s) => Number(first(s, 'a:spcPts')?.attrs.val ?? 0) / 100)
      const fp: FitPara[] = paragraphs.map((p, i) => ({ text: p.text, size: p.size, bullet: p.bullet, level: p.level, bold: p.bold, spaceAfter: spacing[i] ?? 0 }))
      const ins = (k: string, d: number) => (body?.attrs[k] !== undefined ? Number(body.attrs[k]) / 12700 : d)
      const insets = { h: (ins('lIns', DEFAULT_INSETS.h) + ins('rIns', DEFAULT_INSETS.h)) / 2, v: (ins('tIns', DEFAULT_INSETS.v) + ins('bIns', DEFAULT_INSETS.v)) / 2 }
      const fill = w > 0 && h > 0 ? textHeightPt(fp, w, insets) / (h * 72) : 0
      shapes.push({ name, x: Number(off?.attrs.x ?? 0) / EMU, y: Number(off?.attrs.y ?? 0) / EMU, w, h, isTitle: ph === 'title' || ph === 'ctrTitle' || /^title\b/i.test(name), paragraphs, fonts, autofit, fill })
    }
    // Without a title placeholder: the largest text near the top is the title.
    if (!shapes.some((s) => s.isTitle) && shapes.length) {
      const top = shapes.filter((s) => s.y < height * 0.45).sort((a, b) => Math.max(...b.paragraphs.map((p) => p.size)) - Math.max(...a.paragraphs.map((p) => p.size)))[0]
      if (top && Math.max(...top.paragraphs.map((p) => p.size)) >= 24) top.isTitle = true
    }
    const charts: SlideInfo['charts'] = []
    for (const gf of all(root, 'p:graphicFrame')) {
      const c = first(gf, 'c:chart')
      if (!c) continue
      const target = rels[c.attrs['r:id']]
      if (!target) continue
      const path = target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, '')}`
      const cx = await part(zip, path)
      if (!cx) continue
      const croot = parseXml(cx)
      const plot = first(croot, 'c:plotArea')
      const kind = plot?.children.find((x) => /Chart$/.test(x.name))
      const barDir = kind ? first(kind, 'c:barDir')?.attrs.val : undefined
      const type = !kind ? 'unknown' : kind.name === 'c:barChart' ? (barDir === 'bar' ? 'bar' : 'column') : kind.name.replace(/^c:|Chart$/g, '').replace(/3D$/, '')
      const sers = kind ? all(kind, 'c:ser') : []
      const pts = Math.max(0, ...sers.map((s) => Number(first(first(s, 'c:val') ?? s, 'c:ptCount')?.attrs.val ?? 0)))
      const titleText = first(croot, 'c:title') ? textOf(first(croot, 'c:title')!, 'a:t') : undefined
      charts.push({ type, series: sers.length, points: pts, ...(titleText ? { title: titleText } : {}) })
    }
    const tables = all(root, 'a:tbl').map((t) => ({ rows: all(t, 'a:tr').map((r) => all(r, 'a:tc').map((c) => all(c, 'a:p').map((p) => textOf(p, 'a:t')).join('\n'))) }))
    const notesFile = Object.keys(rels).map((k) => rels[k]).find((t) => /notesSlide/.test(t))
    const notesXml = notesFile ? await part(zip, `ppt/${notesFile.replace(/^\.\.\//, '')}`) : undefined
    const notes = notesXml
      ? all(parseXml(notesXml), 'p:sp').filter((s) => first(s, 'p:ph')?.attrs.type === 'body').map((s) => all(s, 'a:p').map((p) => textOf(p, 'a:t')).filter(Boolean).join('\n')).join('\n').trim()
      : ''
    const bgOf = (r: ReturnType<typeof parseXml>) => first(first(r, 'p:bg') ?? { name: '', attrs: {}, children: [], text: '' }, 'a:srgbClr')?.attrs.val
    let bg = bgOf(root)
    // A slide without its own background shows its layout's (slide masters).
    const layoutTarget = Object.values(rels).find((t) => /slideLayout/.test(t))
    if (!bg && layoutTarget) { const lx = await part(zip, `ppt/${layoutTarget.replace(/^\.\.\//, '')}`); if (lx) bg = bgOf(parseXml(lx)) }
    const texts = shapes.flatMap((s) => s.paragraphs.map((p) => p.text)).concat(tables.flatMap((t) => t.rows.flat()))
    slides.push({
      n,
      title: shapes.find((s) => s.isTitle)?.paragraphs.map((p) => p.text).join(' '),
      texts,
      notes,
      shapes,
      charts,
      tables,
      images: all(root, 'p:pic').length,
      slideNumber: all(root, 'a:fld').some((x) => x.attrs.type === 'slidenum'),
      ...(bg ? { background: bg } : {})
    })
  }
  return { width, height, slides, fonts: [...fontsAll] }
}
