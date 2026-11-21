import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { DocBlock, DocContent, DocType } from '@shared/types'
import { pdfText, pptxSlides, xlsxSheets } from '../docs/read'
import { markdownToBlocks } from './markdown'
import { addr } from './sheet'

// Opening a file in the Document tab: Word, PDF, slides, Markdown, text and web pages become an editable block
// document; spreadsheets and CSV files become a sheet. The original file is never changed here (saving back is
// docs:saveBack, which keeps a backup first).

/** File types the editor opens. */
export const EDITABLE = ['.docx', '.pdf', '.pptx', '.md', '.markdown', '.txt', '.html', '.htm', '.xlsx', '.csv', '.tsv'] as const
export const isEditable = (path: string): boolean => (EDITABLE as readonly string[]).includes(extname(path).toLowerCase())

const decode = (s: string): string => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
const inline = (html: string): string => decode(html
  .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/** Simple HTML (mammoth's Word output, a saved web page) as Markdown: headings, paragraphs, lists, tables, quotes. */
export function htmlToMarkdown(html: string): string {
  const body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html).replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
  const out: string[] = []
  const re = /<(h[1-6]|p|li|blockquote|table|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const tag = m[1].toLowerCase()
    if (tag === 'table') {
      const rows = [...m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inline(c[1]).replace(/\|/g, '\\|')))
      if (!rows.length) continue
      const w = Math.max(...rows.map((r) => r.length))
      const line = (r: string[]): string => `| ${Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ')} |`
      out.push([line(rows[0]), `| ${Array.from({ length: w }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'))
      continue
    }
    if (tag === 'pre') { out.push('```\n' + decode(m[2].replace(/<[^>]+>/g, '')) + '\n```'); continue }
    const text = inline(m[2])
    if (!text) continue
    if (tag.startsWith('h')) out.push(`${'#'.repeat(Math.min(3, Number(tag[1])))} ${text}`)
    else if (tag === 'li') out.push(`- ${text}`)
    else if (tag === 'blockquote') out.push(`> ${text}`)
    else out.push(text)
  }
  return out.join('\n\n')
}

/** Plain text (a PDF's) as paragraphs: blank lines split them, single line breaks inside one are joined. */
function textToMarkdown(text: string): string {
  return text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n\n')
}

function sheetContent(title: string, rows: Array<Array<string | number | boolean | null>>): DocContent {
  const cells: Record<string, string> = {}
  rows.slice(0, 2000).forEach((r, ri) => r.slice(0, 100).forEach((v, ci) => { if (v !== null && v !== '') cells[addr(ci, ri)] = String(v) }))
  return { title, blocks: [], sheet: { rows: Math.max(1, rows.length), cols: Math.max(1, ...rows.map((r) => r.length)), cells, header: true } }
}

function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false; else cell += ch; continue }
    if (ch === '"') quoted = true
    else if (ch === sep) { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** A file as a document or sheet the editor opens. */
export async function importFile(path: string): Promise<{ title: string; type: DocType; content: DocContent }> {
  const ext = extname(path).toLowerCase()
  const title = basename(path, extname(path)).replace(/[-_]+/g, ' ').trim() || 'Untitled'
  if (ext === '.xlsx') {
    const sheets = await xlsxSheets(path)
    return { title, type: 'sheet', content: sheetContent(title, sheets[0]?.rows ?? [[]]) }
  }
  if (ext === '.csv' || ext === '.tsv') return { title, type: 'sheet', content: sheetContent(title, parseDelimited(readFileSync(path, 'utf8'), ext === '.tsv' ? '\t' : ',')) }
  let md: string
  if (ext === '.docx') {
    // Word's Title and Subtitle styles aren't headings to the converter by default: map them.
    const mammoth = await import('mammoth')
    const html = (await mammoth.convertToHtml({ path }, { styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h3:fresh"] })).value
    md = htmlToMarkdown(html)
  }
  else if (ext === '.pdf') md = textToMarkdown((await pdfText(path)).text)
  else if (ext === '.pptx') md = (await pptxSlides(path)).map((s) => [`## ${s.texts[0] || `Slide ${s.n}`}`, ...s.texts.slice(1).map((t) => `- ${t}`), ...(s.notes ? [`> ${s.notes}`] : [])].join('\n')).join('\n\n')
  else if (ext === '.html' || ext === '.htm') md = htmlToMarkdown(readFileSync(path, 'utf8'))
  else md = readFileSync(path, 'utf8')
  const blocks: DocBlock[] = markdownToBlocks(md)
  // A PowerPoint file opens as a native deck (each slide a heading with its points and notes).
  return { title, type: 'doc', content: { title, blocks: blocks.length ? blocks : [{ id: 'b000', type: 'p', text: '' }], ...(ext === '.pptx' ? { kind: 'slides' as const } : {}) } }
}

/** The export format that matches the original file (slides and plain text save as Word / Markdown). */
export function saveFormat(path: string): 'docx' | 'pdf' | 'md' | 'html' | 'xlsx' | 'csv' | 'pptx' {
  const ext = extname(path).toLowerCase()
  return ext === '.pptx' ? 'pptx' : ext === '.pdf' ? 'pdf' : ext === '.md' || ext === '.markdown' || ext === '.txt' ? 'md' : ext === '.html' || ext === '.htm' ? 'html' : ext === '.xlsx' ? 'xlsx' : ext === '.csv' || ext === '.tsv' ? 'csv' : 'docx'
}
