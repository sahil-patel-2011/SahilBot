import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DocBlock, DocExportFormat, DocSnapshot } from '@shared/types'
import { escapeHtml, inlineToHtml } from './inline'
import { blocksToMarkdown, listNumbers } from './markdown'
import { sheetRows, toCsv } from './sheet'
import { blocksToSlides, plainInline } from '@shared/slides'
import { slidePieces } from '@shared/slide-render'
import { chartKind, chartTable, donutSvg, numberOf } from '@shared/dashboard'
import { dashboardPage, dashboardPdf, deckOdp, deckPdf, deckPngFolder, deckPptxPictures } from './deck-export'

// doc_export and the editor's Export menu: Word and PDF through the app's document generators
// (src/main/docs/create.ts), Markdown and HTML written here, and xlsx/csv for sheets.

/** Reads an image a document names; throws when it may not be read (outside your folders, missing, too big). */
export type ReadImageFn = (src: string) => Buffer

/** The generator API this uses (src/main/docs/create.ts `createDocument`), injectable for tests. */
export type CreateDocumentFn = (fullPath: string, spec: { path: string; title?: string; markdown?: string; font?: string; font_size?: number; theme?: 'modern' | 'classic' | 'minimal'; slides?: Array<Record<string, unknown>>; sheets?: Array<{ name: string; rows: Array<Array<string | number | boolean | null>>; header?: boolean }> }, o?: { readImage?: ReadImageFn }) => Promise<unknown>

const defaultCreate: CreateDocumentFn = async (fullPath, spec, o) => {
  const { createDocument } = await import('../docs/create')
  return createDocument(fullPath, spec as Parameters<typeof createDocument>[1], { readImage: o?.readImage })
}

const realish = (p: string): string => {
  let probe = p
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try { return join(realpathSync(probe), relative(probe, p)) } catch { return p }
}
const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Images only from `folders` (relative paths resolve in the first one); every other path is refused, so a
 * document can't carry a file from elsewhere on this Mac into an export. Data URIs never reach here.
 */
export function folderImageReader(folders: string[]): ReadImageFn {
  const roots = folders.filter(Boolean).map((f) => realish(resolve(f)))
  return (src) => {
    const p = isAbsolute(src) ? resolve(src) : roots[0] ? resolve(roots[0], src) : ''
    const real = p ? realish(p) : ''
    if (!real || !roots.some((r) => within(r, real))) throw new Error(`Image "${src.slice(0, 80)}" is outside the workspace and the folders attached to this chat.`)
    if (!existsSync(real) || !statSync(real).isFile()) throw new Error(`Image not found: ${src}`)
    if (statSync(real).size > 25_000_000) throw new Error(`Image ${src} is larger than 25 MB.`)
    return readFileSync(real)
  }
}

export const DOC_FORMATS: DocExportFormat[] = ['docx', 'pdf', 'md', 'html']
export const SHEET_FORMATS: DocExportFormat[] = ['xlsx', 'csv', 'md', 'html', 'pdf', 'docx']
/** A deck: PowerPoint (editable or as pictures with exact fonts), OpenDocument, PDF, PNG images, Markdown. */
export const DECK_FORMATS: DocExportFormat[] = ['pptx', 'pptx_pictures', 'odp', 'pdf', 'png', 'md', 'html', 'docx']

export function slug(t: string): string {
  const s = t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
  return s || 'document'
}

/** A free path in `dir`: "<name>.<ext>", then "<name>-2.<ext>"… */
export function freePath(dir: string, name: string, ext: string): string {
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i < 1000; i++) {
    const p = join(dir, `${name}${i === 1 ? '' : `-${i}`}${ext ? `.${ext}` : ''}`)
    if (!existsSync(p)) return p
  }
  return join(dir, `${name}-${Date.now()}.${ext}`)
}

/** The document as Markdown other tools render well (sheets: a table of computed values). */
export function exportMarkdown(d: DocSnapshot): string {
  if (d.type === 'sheet') {
    const rows = sheetRows(d.content.sheet ?? { rows: 0, cols: 0, cells: {} }, d.computed ?? {})
    if (!rows.length) return `# ${d.title}\n`
    const cols = Math.max(...rows.map((r) => r.length))
    const line = (r: string[]): string => `| ${Array.from({ length: cols }, (_, k) => (r[k] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
    const head = d.content.sheet?.header ? rows[0] : Array.from({ length: cols }, (_, k) => String.fromCharCode(65 + (k % 26)))
    const body = d.content.sheet?.header ? rows.slice(1) : rows
    return `# ${d.title}\n\n${[line(head), `| ${Array(cols).fill('---').join(' | ')} |`, ...body.map(line)].join('\n')}\n`
  }
  const startsWithTitle = d.content.blocks[0]?.type === 'h1' && d.content.blocks[0].text?.trim() === d.title.trim()
  const md = blocksToMarkdown(d.content.blocks, { portable: true })
  return startsWithTitle ? `${md}\n` : `# ${d.title}\n\n${md}\n`
}

function blockHtml(b: DocBlock, num: number): string {
  const t = inlineToHtml(b.text ?? '')
  switch (b.type) {
    case 'h1': return `<h1>${t}</h1>`
    case 'h2': return `<h2>${t}</h2>`
    case 'h3': return `<h3>${t}</h3>`
    case 'p': return `<p>${t || '<br>'}</p>`
    case 'bullet': return `<li class="bullet">${t}</li>`
    case 'numbered': return `<li class="num" value="${num}">${t}</li>`
    case 'check': return `<li class="check"><input type="checkbox" disabled${b.checked ? ' checked' : ''}> ${t}</li>`
    case 'quote': return `<blockquote>${t}</blockquote>`
    case 'callout': return `<aside class="callout ${b.tone ?? 'info'}">${t}</aside>`
    case 'code': return `<pre><code${b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ''}>${escapeHtml(b.text ?? '')}</code></pre>`
    case 'divider': return '<hr>'
    case 'image': return `<figure><img src="${escapeHtml(b.src ?? '')}" alt="${escapeHtml(b.alt ?? '')}">${b.alt ? `<figcaption>${escapeHtml(b.alt)}</figcaption>` : ''}</figure>`
    case 'table': {
      const rows = b.rows ?? []
      const head = b.header !== false && rows.length ? `<thead><tr>${rows[0].map((c) => `<th>${inlineToHtml(c)}</th>`).join('')}</tr></thead>` : ''
      const body = (b.header !== false ? rows.slice(1) : rows).map((r) => `<tr>${r.map((c) => `<td>${inlineToHtml(c)}</td>`).join('')}</tr>`).join('')
      return `<table>${head}<tbody>${body}</tbody></table>`
    }
  }
}

/** A standalone HTML file (escaped text; no scripts). */
export function exportHtml(d: DocSnapshot): string {
  let body = ''
  if (d.type === 'sheet') {
    const rows = sheetRows(d.content.sheet ?? { rows: 0, cols: 0, cells: {} }, d.computed ?? {})
    const hdr = !!d.content.sheet?.header && rows.length > 0
    body = `<h1>${escapeHtml(d.title)}</h1><table>${hdr ? `<thead><tr>${rows[0].map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${(hdr ? rows.slice(1) : rows).map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  } else {
    const nums = listNumbers(d.content.blocks)
    const parts: string[] = []
    let list: string | null = null
    for (const b of d.content.blocks) {
      const kind = b.type === 'numbered' ? 'ol' : b.type === 'bullet' || b.type === 'check' ? 'ul' : null
      if (kind !== list) { if (list) parts.push(`</${list}>`); if (kind) parts.push(`<${kind}>`); list = kind }
      const html = blockHtml(b, nums.get(b.id) ?? 1)
      parts.push(kind && b.indent ? html.replace(/^<li/, `<li style="margin-left:${b.indent * 1.5}em"`) : html)
    }
    if (list) parts.push(`</${list}>`)
    const first = d.content.blocks[0]
    body = `${first?.type === 'h1' && first.text?.trim() === d.title.trim() ? '' : `<h1>${escapeHtml(d.title)}</h1>`}${parts.join('\n')}`
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: file:">
<title>${escapeHtml(d.title)}</title>
<style>
:root{color-scheme:light dark}body{font:${d.content.style?.size ? Math.round(d.content.style.size * 4 / 3) : 16}px/1.6 ${d.content.style?.font ? `"${d.content.style.font}",` : ''}-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1a;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ececec;background:#161616}th{background:#232323!important}blockquote,aside{color:#bbb}}
h1{font-size:2em;line-height:1.2}h2{font-size:1.45em}h3{font-size:1.15em}blockquote{border-left:3px solid #ccc;margin:1em 0;padding:.1em 1em;color:#444}
aside.callout{border-left:4px solid #3b82f6;background:rgba(59,130,246,.08);padding:.7em 1em;border-radius:8px;margin:1em 0}aside.warn{border-color:#f59e0b;background:rgba(245,158,11,.1)}aside.danger{border-color:#ef4444;background:rgba(239,68,68,.08)}aside.tip{border-color:#10b981;background:rgba(16,185,129,.08)}
pre{background:rgba(127,127,127,.12);padding:12px 14px;border-radius:8px;overflow:auto}code{font:.9em "SF Mono",Menlo,monospace}
table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid rgba(127,127,127,.35);padding:6px 10px;text-align:left;vertical-align:top}th{background:#f4f4f4}
li.check{list-style:none;margin-left:-1.2em}img{max-width:100%}hr{border:0;border-top:1px solid rgba(127,127,127,.35);margin:2em 0}
</style></head><body>
${body}
</body></html>
`
}

/**
 * Writes the document to `dir` in `format` and returns the file's path. Images come only through
 * `readImage` (default: the folder `dir` is in, i.e. the workspace for <workspace>/exports).
 */
export async function exportDoc(d: DocSnapshot, format: DocExportFormat, dir: string, o: { name?: string; create?: CreateDocumentFn; readImage?: ReadImageFn } = {}): Promise<string> {
  const deck = d.type !== 'sheet' && d.content.kind === 'slides'
  const allowed = d.type === 'sheet' ? SHEET_FORMATS : deck ? DECK_FORMATS : DOC_FORMATS
  if (!allowed.includes(format)) throw new Error(`A ${d.type === 'sheet' ? 'sheet' : 'document'} exports to ${allowed.join(', ')}; not ${format}.`)
  const create = o.create ?? defaultCreate
  const readImage = o.readImage ?? folderImageReader([dirname(resolve(dir))])
  const name = slug(o.name?.replace(/\.[a-z0-9]{2,5}$/i, '') || d.title)
  const ext = format === 'pptx_pictures' ? 'pptx' : format === 'png' ? '' : format
  const path = format === 'png' ? freePath(dir, `${name}-slides`, '') : freePath(dir, format === 'pptx_pictures' ? `${name}-pictures` : name, ext)
  const deckIn = { title: d.title, blocks: d.content.blocks, style: d.content.style }
  if (deck && format === 'pdf') { mkdirSync(dir, { recursive: true }); await deckPdf(path, deckIn, readImage); return done(path, format) }
  const dashboard = d.type !== 'sheet' && d.content.kind === 'dashboard'
  if (dashboard && format === 'pdf') { mkdirSync(dir, { recursive: true }); await dashboardPdf(path, deckIn, readImage); return done(path, format) }
  if (dashboard && format === 'html') { writeFileSync(path, dashboardPage(deckIn, readImage)); return done(path, format) }
  switch (format) {
    case 'png': await deckPngFolder(path, deckIn, readImage); break
    case 'pptx_pictures': mkdirSync(dir, { recursive: true }); await deckPptxPictures(path, deckIn, readImage); break
    case 'odp': mkdirSync(dir, { recursive: true }); await deckOdp(path, deckIn, readImage); break
    case 'md': writeFileSync(path, exportMarkdown(d)); break
    case 'html': writeFileSync(path, exportHtml(d)); break
    case 'csv': writeFileSync(path, toCsv(sheetRows(d.content.sheet ?? { rows: 0, cols: 0, cells: {} }, d.computed ?? {}))); break
    case 'xlsx': {
      // Formulas go in as formulas (Excel recalculates them); everything else as typed numbers or text.
      const raw = sheetRows(d.content.sheet ?? { rows: 0, cols: 0, cells: {} })
      const rows = raw.map((r) => r.map((c): string | number | null => (c === '' ? null : c.trim().startsWith('=') ? c.trim() : /^-?\d+(\.\d+)?$/.test(c.trim()) ? Number(c) : c)))
      await create(path, { path, title: d.title, sheets: [{ name: d.title.slice(0, 31) || 'Sheet1', rows: rows.length ? rows : [[null]], header: !!d.content.sheet?.header }] }, { readImage })
      break
    }
    case 'pptx': {
      // A native deck as PowerPoint: one slide per heading, its points, picture and speaker notes.
      const st = d.content.style
      const slides = blocksToSlides(d.content.blocks).map((s, i) => {
        const p = slidePieces(s, i)
        const bullets = p.bullets.map((b) => `${'  '.repeat(b.indent ?? 0)}${plainInline(b.text)}`)
        const stats = p.stats.map((x) => ({ value: plainInline(x.value), label: plainInline(x.label) }))
        // A ```chart block: PowerPoint's own chart (editable data), the points as the takeaway beside it.
        const fence = (s.extra ?? []).find((x) => x.type === 'code' && /^chart$/i.test(x.lang ?? ''))
        const ct = fence ? chartTable(fence.text ?? '') : null
        const nums = ct ? ct.header.map((_, c) => c).filter((c) => c > 0 && ct.rows.some((r) => numberOf(r[c] ?? '') !== null)) : []
        const chart = ct && nums.length ? {
          // The same rule as the slide's own chart (dashboard.ts chartKind), so the file matches the editor.
          type: (donutSvg(ct, ['#000']) ? 'doughnut' : chartKind(ct)) as 'doughnut' | 'line' | 'column',
          categories: ct.rows.map((r) => r[0] ?? ''),
          series: nums.map((c) => ({ name: ct.header[c], values: ct.rows.map((r) => numberOf(r[c] ?? '')) }))
        } : undefined
        // Light slides with big numbers use PowerPoint's stats layout (numbers on cards, points underneath).
        const layout = chart && !p.dark ? 'chart' : p.layout === 'bullets' && stats.length ? 'stats' : p.layout
        const desc = p.description.map(plainInline)
        return {
          title: plainInline(s.title) || (i === 0 ? d.title : ' '), layout,
          ...(s.kicker?.trim() ? { kicker: plainInline(s.kicker) } : {}),
          ...(p.dark ? { ...(p.subtitle ? { subtitle: plainInline(p.subtitle) } : {}), ...(desc.length ? { bullets: desc } : {}) } : bullets.length ? { bullets } : {}),
          ...(stats.length && layout !== 'chart' ? { stats } : {}),
          ...(chart && layout === 'chart' ? { chart } : {}),
          ...(s.image ? { image: s.image } : {}), ...(s.notes ? { notes: s.notes } : {})
        }
      })
      await create(path, { path, title: d.title, slides: slides.length ? slides : [{ title: d.title, layout: 'title' }], ...(st?.font ? { font: st.font } : {}), ...(st?.theme ? { theme: st.theme } : {}) }, { readImage })
      break
    }
    case 'docx':
    case 'pdf': {
      const st = d.content.style
      await create(path, { path, title: d.title, markdown: exportMarkdown(d), ...(st?.font ? { font: st.font } : {}), ...(st?.size ? { font_size: st.size } : {}), ...(st?.theme ? { theme: st.theme } : {}) }, { readImage })
      break
    }
  }
  return done(path, format)
}

function done(path: string, format: DocExportFormat): string {
  if (!existsSync(path)) throw new Error(`The ${format} export didn't produce a file.`)
  return path
}
