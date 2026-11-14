import type { DocBlock, DocBlockType, DocCalloutTone } from '@shared/types'

// Markdown ⇄ blocks. The bot writes and reads Markdown; the document is a list of blocks with stable ids.
// Pure (no DOM, no Node): the editor uses it for pasted Markdown too.

// ---------------------------------------------------------------- ids

const ID_RE = /^b[0-9a-z]{3,8}$/

export function isBlockId(s: unknown): s is string {
  return typeof s === 'string' && ID_RE.test(s)
}

/** A new block id ("b" + 3+ base-36 characters) not in `taken`; adds it to `taken`. */
export function newId(taken: Set<string>, rand: () => number = Math.random): string {
  for (let len = 3; ; len++) {
    for (let tries = 0; tries < 40; tries++) {
      let s = 'b'
      for (let i = 0; i < len; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(rand() * 36)]
      if (!taken.has(s)) { taken.add(s); return s }
    }
  }
}

// ---------------------------------------------------------------- parse

const TONES: Record<string, DocCalloutTone> = { NOTE: 'info', INFO: 'info', TIP: 'tip', IMPORTANT: 'info', WARNING: 'warn', CAUTION: 'danger', DANGER: 'danger' }
const TONE_LABEL: Record<DocCalloutTone, string> = { info: 'NOTE', tip: 'TIP', warn: 'WARNING', danger: 'CAUTION' }

/** Lines that start a block of their own (a paragraph that starts like this is escaped with "\"). */
const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|```|~~~|\||!\[|\[( |x|X)?\]\s)/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const ID_MARK = /^\s*\[(b[0-9a-z]{3,8})\]\s?/

/** Splits a table row into cells, honoring "\|" escapes. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

const isSep = (line: string): boolean => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')

export interface ParseOptions {
  /** Ids already in the document (new ids avoid them). */
  taken?: Set<string>
  /** Keep "[b7kq]" markers from doc_read output as the blocks' ids (when they are free). */
  keepIds?: boolean
  rand?: () => number
}

/** Markdown → blocks. Every block gets a fresh id unless keepIds and the line carries a free "[id]" marker. */
export function markdownToBlocks(md: string, opts: ParseOptions = {}): DocBlock[] {
  const taken = opts.taken ?? new Set<string>()
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const out: DocBlock[] = []
  const mk = (type: DocBlockType, extra: Partial<DocBlock>, marked?: string): DocBlock => {
    let id: string
    if (marked && opts.keepIds && !taken.has(marked)) { taken.add(marked); id = marked } else id = newId(taken, opts.rand)
    const b: DocBlock = { id, type, ...extra }
    out.push(b)
    return b
  }
  // List nesting: the indentation widths of open list levels.
  let listStack: number[] = []
  let listBase = 0
  let i = 0
  while (i < lines.length) {
    let line = lines[i]
    let marked: string | undefined
    const m0 = line.match(ID_MARK)
    if (m0) { marked = m0[1]; line = line.slice(m0[0].length) }
    if (!line.trim()) { i++; listStack = listStack.length && lines[i] !== undefined && /^\s*([-*+]|\d{1,9}[.)])\s/.test(lines[i] ?? '') ? listStack : []; continue }

    // Fenced code
    const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++])
      i++
      mk('code', { text: body.join('\n'), ...(fence[2] ? { lang: fence[2] } : {}) }, marked)
      listStack = []
      continue
    }

    // Headings
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (h) {
      const level = Math.min(3, h[1].length)
      mk(`h${level}` as DocBlockType, { text: h[2] }, marked)
      i++
      listStack = []
      continue
    }

    if (RULE.test(line)) {
      mk('divider', {}, marked)
      i++
      listStack = []
      continue
    }

    // Image on its own line
    const img = line.match(/^\s*!\[([^\]]*)\]\((.+?)\)\s*$/)
    if (img) {
      mk('image', { src: img[2].trim().replace(/^<|>$/g, ''), ...(img[1] ? { alt: img[1] } : {}) }, marked)
      i++
      listStack = []
      continue
    }

    // Tables: a header row, then a separator row.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const rows = [splitRow(line)]
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]))
      const cols = Math.max(...rows.map((r) => r.length))
      mk('table', { rows: rows.map((r) => [...r, ...Array(cols - r.length).fill('')]), header: true }, marked)
      listStack = []
      continue
    }

    // Quotes and callouts ("> [!NOTE]")
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      const alert = body[0]?.match(/^\[!(\w+)\]\s*(.*)$/)
      if (alert && TONES[alert[1].toUpperCase()]) {
        const rest = [alert[2], ...body.slice(1)].filter((x, k) => k > 0 || x)
        mk('callout', { tone: TONES[alert[1].toUpperCase()], text: rest.join('\n') }, marked)
      } else mk('quote', { text: body.join('\n') }, marked)
      listStack = []
      continue
    }

    // List items (and "[ ] task" checklists without a dash)
    const li = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/) ?? line.match(/^(\s*)()\[( |x|X)?\]\s+(.*)$/)
    if (li) {
      const width = li[1].length
      while (listStack.length && width < listStack[listStack.length - 1]) listStack.pop()
      // A list that starts indented keeps that depth (about 3 spaces a level).
      if (!listStack.length) listBase = Math.floor(width / 3)
      if (!listStack.length || width > listStack[listStack.length - 1]) listStack.push(width)
      const indent = Math.min(5, listBase + listStack.length - 1)
      const box = li[3]
      const type: DocBlockType = box !== undefined || li[2] === '' ? 'check' : /\d/.test(li[2]) ? 'numbered' : 'bullet'
      const text = [li[4]]
      i++
      // Continuation lines: indented text right under the item.
      while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d{1,9}[.)])\s/.test(lines[i]) && !ID_MARK.test(lines[i])) text.push(unescapeStart(lines[i++].trim()))
      mk(type, { text: joinSoft(text), ...(indent ? { indent } : {}), ...(type === 'check' ? { checked: /x/i.test(box ?? '') } : {}) }, marked)
      continue
    }
    listStack = []

    // Paragraph: lines until a blank line or another block.
    const para: string[] = [unescapeStart(line.trim())]
    i++
    while (i < lines.length && lines[i].trim() && !ID_MARK.test(lines[i]) && !BLOCK_START.test(lines[i].trim()) && !RULE.test(lines[i])) para.push(unescapeStart(lines[i++].trim()))
    mk('p', { text: joinSoft(para) }, marked)
  }
  return out
}

/** Joins wrapped lines with spaces; a line ending in "\" is a hard line break. */
function joinSoft(lines: string[]): string {
  let s = ''
  lines.forEach((l, k) => {
    if (k === 0) { s = l; return }
    if (s.endsWith('\\') && !s.endsWith('\\\\')) s = `${s.slice(0, -1)}\n${l}`
    else s = `${s} ${l}`
  })
  return s
}

function unescapeStart(s: string): string {
  return s.startsWith('\\') && BLOCK_START.test(s.slice(1)) ? s.slice(1) : s.startsWith('\\') && RULE.test(s.slice(1)) ? s.slice(1) : s
}

// ---------------------------------------------------------------- serialize

export interface SerializeOptions {
  /** Prefix every block with its "[id]" marker (doc_read). */
  ids?: boolean
  /** Callouts as "> **Note:** text" and plain checkboxes, for other Markdown renderers (export). */
  portable?: boolean
}

const LIST = new Set<DocBlockType>(['bullet', 'numbered', 'check'])

const cell = (s: string): string => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

const guard = (l: string): string => (BLOCK_START.test(l) || RULE.test(l) ? `\\${l}` : l)

/**
 * Text with hard breaks written as "\" line ends (continuation lines indented by `cont`); a line that would
 * start a block of its own is escaped with "\".
 */
function textOut(s: string, guardStart = true, cont = ''): string {
  return (s ?? '').split('\n').map((l, k) => (k === 0 ? (guardStart ? guard(l) : l) : `${cont}${guard(l)}`)).join('\\\n')
}

/** Markdown for one block (no id). `num` is its number in a numbered list. */
export function blockToMarkdown(b: DocBlock, num = 1, opts: SerializeOptions = {}): string {
  const pad = '   '.repeat(Math.max(0, Math.min(5, b.indent ?? 0)))
  const t = b.text ?? ''
  switch (b.type) {
    case 'h1': return `# ${t.replace(/\n/g, ' ')}`
    case 'h2': return `## ${t.replace(/\n/g, ' ')}`
    case 'h3': return `### ${t.replace(/\n/g, ' ')}`
    case 'p': return textOut(t)
    case 'bullet': return `${pad}- ${textOut(t, false, `${pad}   `)}`
    case 'numbered': return `${pad}${num}. ${textOut(t, false, `${pad}   `)}`
    case 'check': return `${pad}- [${b.checked ? 'x' : ' '}] ${textOut(t, false, `${pad}   `)}`
    case 'quote': return t.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n') || '>'
    case 'callout': {
      const tone = b.tone ?? 'info'
      if (opts.portable) return `> **${tone === 'warn' ? 'Warning' : tone === 'danger' ? 'Caution' : tone === 'tip' ? 'Tip' : 'Note'}:** ${t.replace(/\n/g, ' ')}`
      return [`> [!${TONE_LABEL[tone]}]`, ...t.split('\n').map((l) => `> ${l}`.trimEnd())].join('\n')
    }
    case 'code': {
      const body = t
      const fence = body.includes('```') ? '~~~' : '```'
      return `${fence}${b.lang ?? ''}\n${body}\n${fence}`
    }
    case 'table': {
      const rows = b.rows?.length ? b.rows : [['']]
      const cols = Math.max(1, ...rows.map((r) => r.length))
      const line = (r: string[]): string => `| ${Array.from({ length: cols }, (_, k) => cell(r[k] ?? '')).join(' | ')} |`
      return [line(rows[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
    }
    case 'divider': return '---'
    case 'image': return `![${(b.alt ?? '').replace(/[[\]]/g, '')}](${/[\s()]/.test(b.src ?? '') ? `<${b.src}>` : b.src ?? ''})`
  }
}

/** The number each numbered-list block shows (runs restart after any other block at that level). */
export function listNumbers(blocks: DocBlock[]): Map<string, number> {
  const out = new Map<string, number>()
  const counters: number[] = []
  for (const b of blocks) {
    if (!LIST.has(b.type)) { counters.length = 0; continue }
    const lvl = b.indent ?? 0
    counters.length = lvl + 1
    if (b.type === 'numbered') {
      counters[lvl] = (counters[lvl] ?? 0) + 1
      out.set(b.id, counters[lvl])
    } else counters[lvl] = 0
  }
  return out
}

/** Blocks → Markdown. List items sit on consecutive lines; everything else is separated by a blank line. */
export function blocksToMarkdown(blocks: DocBlock[], opts: SerializeOptions = {}): string {
  const nums = listNumbers(blocks)
  let out = ''
  blocks.forEach((b, k) => {
    const prev = blocks[k - 1]
    const md = blockToMarkdown(b, nums.get(b.id) ?? 1, opts)
    const body = opts.ids ? `[${b.id}] ${md}` : md
    if (k > 0) out += prev && LIST.has(prev.type) && LIST.has(b.type) ? '\n' : '\n\n'
    out += body
  })
  return out
}

/** Removes "[b7kq]" markers the model may have copied from doc_read output. */
export function stripIdMarkers(md: string): string {
  return String(md ?? '').split('\n').map((l) => l.replace(ID_MARK, (m) => m.match(/^\s*/)![0])).join('\n')
}
