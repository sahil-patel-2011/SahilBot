import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Section } from './chunker'
import { extractRich, zipProblem } from './extract-worker'
import { HTML_EXT, isSecretContent, redactSecrets, SHEET_EXT, TEXT_EXT } from './ignore'

// Text extraction for the knowledge base. Everything runs locally, with the same readers the file
// tools use (pdfjs for PDF, mammoth for Word, exceljs for Excel). Rich documents are parsed in a worker
// thread with memory and time limits (extract-worker.ts); Office files that would unpack too big are
// refused before parsing.

/** Rows read from each sheet or CSV file. */
export const MAX_SHEET_ROWS = 1000

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx'])
const PROSE_EXT = new Set(['.txt', '.rst', '.adoc', '.org', '.tex', '.rtf', '.log'])
const DATA_EXT = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.plist'])

export type DocKind = 'markdown' | 'code' | 'text' | 'data' | 'html' | 'pdf' | 'docx' | 'pptx' | 'sheet'

export type Extracted = { kind: DocKind; sections: Section[] } | { skip: string }

export function kindOf(path: string): DocKind {
  const e = extname(path).toLowerCase()
  if (MARKDOWN_EXT.has(e)) return 'markdown'
  if (e === '.pdf') return 'pdf'
  if (e === '.docx') return 'docx'
  if (e === '.pptx') return 'pptx'
  if (SHEET_EXT.has(e)) return 'sheet'
  if (HTML_EXT.has(e)) return 'html'
  if (PROSE_EXT.has(e) || !e) return 'text'
  if (DATA_EXT.has(e)) return 'data'
  return TEXT_EXT.has(e) ? 'code' : 'text'
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Readable text from HTML: no scripts, styles or navigation; headings become Markdown headings. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|nav|footer|template|iframe|form|button|select)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre|h[1-6]|header|main|aside|figure|figcaption|dd|dt)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** A small CSV/TSV parser (quoted fields, doubled quotes, newlines inside quotes). */
export function parseDelimited(text: string, delim: string, maxRows: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false } else field += c
    } else if (c === '"' && !field) quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((x) => x.trim())) rows.push(row)
      row = []
    } else field += c
  }
  if ((field || row.length) && rows.length < maxRows) { row.push(field); if (row.some((x) => x.trim())) rows.push(row) }
  return rows
}

const rowLine = (cells: Array<string | number | boolean | null>): string => cells.map((c) => (c === null || c === undefined ? '' : String(c).replace(/\s+/g, ' ').trim())).join(' | ')

/** Text of a Jupyter notebook: Markdown cells as they are, code cells fenced. */
function notebookText(raw: string): string {
  try {
    const nb = JSON.parse(raw) as { cells?: Array<{ cell_type: string; source: string | string[] }> }
    return (nb.cells ?? []).map((c) => {
      const src = Array.isArray(c.source) ? c.source.join('') : String(c.source ?? '')
      return c.cell_type === 'code' ? '```\n' + src + '\n```' : src
    }).join('\n\n')
  } catch { return '' }
}

/** Formats parsed in the worker (the rest is plain text). */
export const isRich = (path: string): boolean => {
  const e = extname(path).toLowerCase()
  return e === '.pdf' || e === '.docx' || e === '.pptx' || e === '.xlsx' || e === '.xlsm'
}

/**
 * Extracts a file's text as sections ready for chunking, or says why it was skipped. `data`: the file's
 * bytes, already read (the indexer reads once, without following links); otherwise it is read here.
 */
export async function extractFile(path: string, o: { data?: Buffer; timeoutMs?: number; maxHeapMb?: number } = {}): Promise<Extracted> {
  const kind = kindOf(path)
  const ext = extname(path).toLowerCase()
  try {
    const buf = o.data ?? readFileSync(path)
    const limits = { timeoutMs: o.timeoutMs, maxHeapMb: o.maxHeapMb, maxRows: MAX_SHEET_ROWS }
    if (kind === 'docx' || kind === 'pptx' || (kind === 'sheet' && (ext === '.xlsx' || ext === '.xlsm'))) {
      const problem = zipProblem(buf)
      if (problem) return { skip: problem }
    }
    if (kind === 'pdf') {
      const r = await extractRich('pdf', buf, limits)
      const sections = r.kind === 'pdf' ? r.pages.map((p) => ({ text: redactSecrets(p.text), kind: 'text' as const, page: p.n })).filter((s) => s.text) : []
      return sections.length ? { kind, sections } : { skip: 'no text (scanned PDF?)' }
    }
    if (kind === 'docx') {
      const r = await extractRich('docx', buf, limits)
      const text = htmlToText(r.kind === 'docx' ? r.html : '')
      if (isSecretContent(text)) return { skip: 'secret' }
      return { kind, sections: [{ text: redactSecrets(text), kind: 'markdown' }] }
    }
    if (kind === 'pptx') {
      const r = await extractRich('pptx', buf, limits)
      const slides = r.kind === 'pptx' ? r.slides : []
      return { kind, sections: slides.map((s) => ({ text: redactSecrets([...s.texts, s.notes ? `Notes: ${s.notes}` : ''].filter(Boolean).join('\n')), kind: 'text' as const, heading: `Slide ${s.n}` })).filter((s) => s.text.trim()) }
    }
    if (kind === 'sheet' && (ext === '.xlsx' || ext === '.xlsm')) {
      const r = await extractRich('xlsx', buf, limits)
      const sheets = r.kind === 'xlsx' ? r.sheets : []
      return { kind, sections: sheets.map((s) => ({ text: redactSecrets(s.rows.map(rowLine).join('\n')), kind: 'sheet' as const, heading: `Sheet "${s.name}"` })).filter((s) => s.text.trim()) }
    }
    if (buf.subarray(0, 8000).includes(0)) return { skip: 'binary' }
    let text = buf.toString('utf8').replace(/^﻿/, '')
    if (isSecretContent(text)) return { skip: 'secret' }
    if (kind === 'sheet') {
      const rows = parseDelimited(text, ext === '.tsv' ? '\t' : delimiterOf(text), MAX_SHEET_ROWS)
      return { kind, sections: [{ text: redactSecrets(rows.map(rowLine).join('\n')), kind: 'sheet', firstLine: 1, heading: basename(path) }] }
    }
    if (kind === 'html') return { kind, sections: [{ text: redactSecrets(htmlToText(text)), kind: 'markdown' }] }
    if (ext === '.ipynb') return { kind: 'code', sections: [{ text: redactSecrets(notebookText(text)), kind: 'markdown' }] }
    text = redactSecrets(text)
    return { kind, sections: [{ text, kind: kind === 'markdown' ? 'markdown' : kind === 'code' ? 'code' : 'text', firstLine: 1 }] }
  } catch (e) {
    return { skip: `unreadable: ${(e as Error).message.slice(0, 120)}` }
  }
}

/** Comma, semicolon or tab, whichever the first line uses most. */
function delimiterOf(text: string): string {
  const nl = text.indexOf('\n')
  const first = text.slice(0, nl < 0 ? 2000 : nl)
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}
