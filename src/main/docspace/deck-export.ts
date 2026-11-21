import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { DocStyle } from '@shared/types'
import { blocksToSlides, plainInline, type Slide } from '@shared/slides'
import { deckDocument, deckLook, slideDocument, slidePieces, SLIDE_H, SLIDE_W } from '@shared/slide-render'
import { dashboardDocument } from '@shared/dashboard'
import type { ReadImageFn } from './export'

// Deck exports that keep the exact look of the editor: PDF and PNG are printed or captured from the same
// HTML the editor draws (src/shared/slide-render.ts) in a hidden, offline, script-free Chromium window;
// "PowerPoint (pictures)" puts those PNGs on PowerPoint slides with the speaker notes, so fonts and layout
// survive on any machine. OpenDocument (.odp, Keynote / LibreOffice / Google Slides) is written natively
// with editable text.

export interface DeckInput { title: string; blocks: import('@shared/types').DocBlock[]; style?: DocStyle }

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

/** Pictures as data: URIs, so the offline window needs no file access. */
function dataUris(readImage: ReadImageFn): (src: string) => string | undefined {
  const cache = new Map<string, string | undefined>()
  return (src) => {
    if (/^data:image\//.test(src)) return src
    if (!cache.has(src)) {
      try { cache.set(src, `data:${MIME[extname(src).toLowerCase()] ?? 'image/png'};base64,${readImage(src).toString('base64')}`) } catch { cache.set(src, undefined) }
    }
    return cache.get(src)
  }
}

async function electron(): Promise<typeof import('electron')> {
  const e = await import('electron')
  if (!e.BrowserWindow || !e.app?.isReady()) throw new Error('This export needs the SahilBot app (it draws the slides with its own renderer).')
  return e
}

async function withPage<T>(html: string, size: { width: number; height: number }, run: (wc: Electron.WebContents) => Promise<T>): Promise<T> {
  const { BrowserWindow } = await electron()
  const dir = mkdtempSync(join(tmpdir(), 'sb-deck-'))
  const file = join(dir, 'deck.html')
  writeFileSync(file, html)
  const win = new BrowserWindow({ show: false, width: size.width, height: size.height, useContentSize: true, webPreferences: { javascript: false, sandbox: true, offscreen: true, partition: 'sb-deck-render' } })
  try {
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith('file://') || d.url.startsWith('data:')) }))
    await win.loadFile(file)
    return await run(win.webContents)
  } finally {
    win.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The deck as a PDF: one 16:9 page per slide, fonts embedded. */
export async function deckPdf(path: string, d: DeckInput, readImage: ReadImageFn): Promise<void> {
  const slides = blocksToSlides(d.blocks)
  const html = deckDocument(slides, { title: d.title, style: d.style, img: dataUris(readImage) })
  const pdf = await withPage(html, { width: SLIDE_W, height: SLIDE_H }, (wc) => wc.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, generateDocumentOutline: false }))
  writeFileSync(path, pdf)
}

/** A dashboard as a landscape PDF, drawn like the editor's view. */
export async function dashboardPdf(path: string, d: DeckInput, readImage: ReadImageFn): Promise<void> {
  const html = dashboardDocument(d.title, d.blocks, { style: d.style, img: dataUris(readImage) })
  const pdf = await withPage(html, { width: 1100, height: 850 }, (wc) => wc.printToPDF({ printBackground: true, preferCSSPageSize: true }))
  writeFileSync(path, pdf)
}

/** A dashboard as a standalone web page (pictures inlined). */
export function dashboardPage(d: DeckInput, readImage: ReadImageFn): string {
  return dashboardDocument(d.title, d.blocks, { style: d.style, img: dataUris(readImage) })
}

/** Waits for the offscreen page to paint (fonts and pictures in), at most a second. */
function painted(wc: Electron.WebContents): Promise<void> {
  return new Promise((done) => {
    let n = 0
    const t = setTimeout(done, 1000)
    const on = (): void => { if (++n >= 2) { clearTimeout(t); wc.off('paint', on); setTimeout(done, 50) } }
    wc.on('paint', on)
    wc.invalidate()
  })
}

/** Each slide as a 1920 × 1080 PNG. */
export async function deckPngs(d: DeckInput, readImage: ReadImageFn): Promise<Buffer[]> {
  const slides = blocksToSlides(d.blocks)
  const img = dataUris(readImage)
  const out: Buffer[] = []
  for (let i = 0; i < slides.length; i++) {
    const html = slideDocument(slides[i], i, { total: slides.length, title: d.title, style: d.style, img })
    // Drawn at 1920 × 1080 (the 1280 × 720 slide zoomed 1.5×), so text is sharp, not upscaled.
    out.push(await withPage(html, { width: 1920, height: 1080 }, async (wc) => {
      wc.setZoomFactor(1920 / SLIDE_W)
      await painted(wc)
      const shot = await wc.capturePage({ x: 0, y: 0, width: 1920, height: 1080 })
      const size = shot.getSize()
      return (size.width === 1920 ? shot : shot.resize({ width: 1920, height: 1080, quality: 'best' })).toPNG()
    }))
  }
  return out
}

/** A folder of PNGs, one per slide ("01 Title.png"). */
export async function deckPngFolder(dir: string, d: DeckInput, readImage: ReadImageFn): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const slides = blocksToSlides(d.blocks)
  const pngs = await deckPngs(d, readImage)
  pngs.forEach((png, i) => writeFileSync(join(dir, `${String(i + 1).padStart(2, '0')} ${(plainInline(slides[i]?.title ?? '') || 'Slide').replace(/[/\\:*?"<>|]/g, '').slice(0, 60)}.png`), png))
}

/** PowerPoint with each slide as a picture (exact fonts and layout) and its speaker notes. */
export async function deckPptxPictures(path: string, d: DeckInput, readImage: ReadImageFn): Promise<void> {
  const slides = blocksToSlides(d.blocks)
  const pngs = await deckPngs(d, readImage)
  const PptxGenJS = (await import('pptxgenjs')).default
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE'
  pres.title = d.title
  pngs.forEach((png, i) => {
    const s = pres.addSlide()
    s.addImage({ data: `data:image/png;base64,${png.toString('base64')}`, x: 0, y: 0, w: 13.333, h: 7.5 })
    const notes = slides[i]?.notes?.trim()
    if (notes) s.addNotes(notes)
  })
  writeFileSync(path, (await pres.write({ outputType: 'nodebuffer' })) as Buffer)
}

// ------------------------------------------------------------------ OpenDocument (.odp)

const x = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cm = (px: number): string => `${(px * 33.867 / SLIDE_W).toFixed(3)}cm`

/** An editable OpenDocument presentation: titles, points, stats, pictures and notes as real text. */
export async function deckOdp(path: string, d: DeckInput, readImage: ReadImageFn): Promise<void> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation', { compression: 'STORE' })
  const look = deckLook(d.style)
  const font = d.style?.font ?? (d.style?.theme === 'classic' ? 'Georgia' : d.style?.theme === 'minimal' ? 'Helvetica' : 'Helvetica Neue')
  const slides = blocksToSlides(d.blocks)
  const pictures: string[] = []
  const frame = (name: string, px: { x: number; y: number; w: number; h: number }, paras: string): string =>
    `<draw:frame draw:name="${name}" svg:x="${cm(px.x)}" svg:y="${cm(px.y)}" svg:width="${cm(px.w)}" svg:height="${cm(px.h)}" presentation:style-name="pr"><draw:text-box>${paras}</draw:text-box></draw:frame>`
  const para = (style: string, text: string): string => `<text:p text:style-name="${style}">${x(plainInline(text))}</text:p>`
  const pages = slides.map((s: Slide, i: number) => {
    const p = slidePieces(s, i)
    const dk = p.dark ? 'D' : 'L'
    let y = p.layout === 'title' ? 120 : p.layout === 'section' ? 250 : 72
    const parts: string[] = []
    if (s.kicker?.trim()) { parts.push(frame('Kicker', { x: 96, y, w: 1088, h: 30 }, para('Pk', s.kicker))); y += 40 }
    const th = p.layout === 'title' ? 130 : p.layout === 'section' ? 100 : 72
    parts.push(frame('Title', { x: 96, y, w: 1088, h: th }, para(`Pt${p.layout === 'title' ? 'T' : p.layout === 'section' ? 'S' : ''}${dk}`, s.title)))
    y += th + 16
    const textW = s.image && p.layout === 'image_text' ? 560 : 1088
    if (p.subtitle) { parts.push(frame('Subtitle', { x: 96, y, w: 1088, h: 50 }, para(`Psub${dk}`, p.subtitle))); y += 64 }
    if (p.description.length) { parts.push(frame('Description', { x: 96, y, w: 800, h: 30 * p.description.length + 10 }, p.description.map((t) => para(`Pdesc${dk}`, t)).join(''))); y += 30 * p.description.length + 24 }
    if (p.bullets.length) {
      const h = Math.min(720 - y - 150, p.bullets.length * 46 + 10)
      parts.push(frame('Points', { x: 96, y, w: textW, h }, `<text:list text:style-name="Lb">${p.bullets.map((b) => `<text:list-item>${b.indent ? `<text:list><text:list-item>${para('Pp2', b.text)}</text:list-item></text:list>` : para('Pp', b.text)}</text:list-item>`).join('')}</text:list>`))
    }
    if (p.stats.length) {
      const w = 1088 / p.stats.length
      p.stats.forEach((st, k) => parts.push(frame(`Stat ${k + 1}`, { x: 96 + k * w, y: 600, w: w - 16, h: 80 }, para(`Pstat${dk}`, st.value) + para(`Plabel${dk}`, st.label.toUpperCase()))))
    }
    if (s.image) {
      try {
        const data = readImage(s.image)
        const name = `Pictures/p${i + 1}${extname(s.image).toLowerCase() || '.png'}`
        zip.file(name, data)
        pictures.push(name)
        const box = p.layout === 'image_text' ? { x: 700, y: 140, w: 500, h: 440 } : { x: 96, y, w: 1088, h: 720 - y - 80 }
        parts.push(`<draw:frame draw:name="Picture" svg:x="${cm(box.x)}" svg:y="${cm(box.y)}" svg:width="${cm(box.w)}" svg:height="${cm(box.h)}"><draw:image xlink:href="${name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`)
      } catch { /* a missing picture is left out */ }
    }
    const notes = s.notes.trim() ? `<presentation:notes><draw:frame presentation:class="notes" svg:x="2cm" svg:y="14cm" svg:width="17cm" svg:height="12cm"><draw:text-box>${s.notes.split('\n').map((t) => `<text:p>${x(t)}</text:p>`).join('')}</draw:text-box></draw:frame></presentation:notes>` : ''
    return `<draw:page draw:name="Slide ${i + 1}" draw:style-name="${p.dark ? 'dpD' : 'dpL'}" draw:master-page-name="Default">${parts.join('')}${notes}</draw:page>`
  })
  const tp = (name: string, size: number, color: string, o: { bold?: boolean; caps?: boolean; spacing?: string } = {}): string =>
    `<style:style style:name="${name}" style:family="paragraph"><style:text-properties fo:font-family="'${x(font)}'" fo:font-size="${size}pt" fo:color="${color}"${o.bold ? ' fo:font-weight="bold"' : ''}${o.caps ? ' fo:text-transform="uppercase"' : ''}${o.spacing ? ` fo:letter-spacing="${o.spacing}"` : ''}/></style:style>`
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.3">
<office:automatic-styles>
<style:style style:name="dpD" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="${look.dark}" presentation:background-visible="true"/></style:style>
<style:style style:name="dpL" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="${look.light}" presentation:background-visible="true"/></style:style>
<style:style style:name="pr" style:family="presentation"><style:graphic-properties draw:stroke="none" draw:fill="none" draw:auto-grow-height="false" fo:padding="0cm"/></style:style>
${tp('Pk', 11, look.kicker, { bold: true, caps: true, spacing: '0.12cm' })}
${tp('PtTD', 60, look.darkInk, { bold: true })}${tp('PtSD', 44, look.darkInk, { bold: true })}${tp('PtL', 30, look.ink, { bold: true })}${tp('PtD', 30, look.darkInk, { bold: true })}${tp('PtTL', 60, look.ink, { bold: true })}${tp('PtSL', 44, look.ink, { bold: true })}
${tp('PsubD', 20, look.darkInk)}${tp('PsubL', 20, look.ink)}${tp('PdescD', 12, look.darkMuted)}${tp('PdescL', 12, look.muted)}
${tp('Pp', 18, look.ink)}${tp('Pp2', 15, look.muted)}
${tp('PstatD', 22, look.darkInk, { bold: true })}${tp('PstatL', 22, look.ink, { bold: true })}${tp('PlabelD', 8, look.darkMuted, { spacing: '0.06cm' })}${tp('PlabelL', 8, look.muted, { spacing: '0.06cm' })}
<text:list-style style:name="Lb"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:space-before="0cm" text:min-label-width="0.6cm"/><style:text-properties fo:color="${look.accent}"/></text:list-level-style-bullet><text:list-level-style-bullet text:level="2" text:bullet-char="◦"><style:list-level-properties text:space-before="0.8cm" text:min-label-width="0.6cm"/><style:text-properties fo:color="${look.accent}"/></text:list-level-style-bullet></text:list-style>
</office:automatic-styles>
<office:body><office:presentation>${pages.join('\n')}</office:presentation></office:body></office:document-content>`
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" office:version="1.3">
<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="33.867cm" fo:page-height="19.05cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles>
<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`
  const meta = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta><dc:title>${x(d.title)}</dc:title></office:meta></office:document-meta>`
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
${pictures.map((p) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="${MIME[extname(p)] ?? 'image/png'}"/>`).join('\n')}
</manifest:manifest>`
  zip.file('content.xml', content)
  zip.file('styles.xml', styles)
  zip.file('meta.xml', meta)
  zip.file('META-INF/manifest.xml', manifest)
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/vnd.oasis.opendocument.presentation' }))
}
