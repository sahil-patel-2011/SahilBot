// Splits extracted text into passages of about 800 tokens for search. Language-aware: Markdown is cut
// at headings (each passage knows its heading path), code at functions and classes (each passage
// knows the names it holds), prose at paragraphs, spreadsheets by rows with the header repeated.
// Passages keep their original line numbers (text files) or page (PDFs) for citations.

export type SectionKind = 'markdown' | 'code' | 'text' | 'sheet'

/** A run of extracted text: a whole text file, one PDF page, one sheet, one slide. */
export interface Section {
  text: string
  kind: SectionKind
  page?: number
  /** A label for the whole section (sheet name, "Slide 3"). */
  heading?: string
  /** Line number of the section's first line in the file (text files only). */
  firstLine?: number
}

export interface Chunk {
  text: string
  heading?: string
  startLine?: number
  endLine?: number
  page?: number
  /** Estimated tokens (about 4 characters each). */
  tokens: number
}

export interface ChunkOptions {
  /** Target size in tokens (default 800). */
  maxTokens?: number
  /** Overlap between consecutive passages cut from the same block, in tokens (default 100). */
  overlapTokens?: number
}

interface Line { t: string; n?: number }
interface Block { lines: Line[]; heading?: string; level?: number; names?: string[] }

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4)

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)/

const CONTROL = /^(if|for|while|switch|return|else|catch|do|try|case|elif|except|with)\b/
const DECL: RegExp[] = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:data\s+|sealed\s+|open\s+|final\s+|public\s+|private\s+|internal\s+)*class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace|struct|protocol|extension|object|trait)\s+([A-Za-z_$][\w$.]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|impl|enum|mod)\s*(?:<[^>]*>\s*)?([A-Za-z_]\w*)/,
  /^fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/,
  /^(?:module)\s+([A-Za-z_][\w:.]*)/,
  /^(?:(?:public|private|protected|internal|static|final|abstract|override|open|suspend|inline|virtual|async|synchronized|unsafe|extern)\s+)+(?:function\s+)?(?:[\w<>[\],.?]+\s+)?([A-Za-z_]\w*)\s*\(/,
  /^(?:[A-Za-z_][\w*&:<>,]*\s+)+\**&?([A-Za-z_][\w:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{\s*)?$/
]

/** The name a code line declares, when it starts a function, class or type (top level or one indent in). */
export function declName(line: string): string | null {
  const indent = line.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length
  if (indent > 4) return null
  const s = line.trim()
  if (!s || CONTROL.test(s)) return null
  for (const re of DECL) {
    const m = s.match(re)
    if (m) return m[1] ?? s.slice(0, 60)
  }
  return null
}

/** Long lines (minified text, a PDF page without newlines) are wrapped so no line exceeds `max`. */
function wrap(text: string, firstLine: number | undefined, max: number): Line[] {
  const out: Line[] = []
  text.split('\n').forEach((t, i) => {
    const n = firstLine === undefined ? undefined : firstLine + i
    if (t.length <= max) { out.push({ t, n }); return }
    let rest = t
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max)
      if (cut < max * 0.5) cut = max
      out.push({ t: rest.slice(0, cut), n })
      rest = rest.slice(cut).replace(/^ /, '')
    }
    if (rest) out.push({ t: rest, n })
  })
  return out
}

function markdownBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = []
  const path: string[] = []
  let cur: Block = { lines: [] }
  let fenced = false
  for (const l of lines) {
    if (FENCE.test(l.t)) fenced = !fenced
    const m = fenced ? null : l.t.match(MD_HEADING)
    if (m) {
      if (cur.lines.length) blocks.push(cur)
      const level = m[1].length
      path.length = level - 1
      path[level - 1] = m[2].replace(/[*_`]/g, '').trim()
      cur = { lines: [l], heading: path.filter(Boolean).join(' > '), level }
    } else cur.lines.push(l)
  }
  if (cur.lines.length) blocks.push(cur)
  return blocks
}

function codeBlocks(lines: Line[]): Block[] {
  const starts: Array<{ i: number; name: string }> = []
  lines.forEach((l, i) => {
    const name = declName(l.t)
    if (name) starts.push({ i, name })
  })
  if (!starts.length) return paragraphBlocks(lines)
  // Doc comments, attributes and decorators just above a declaration belong to it.
  const begin = starts.map(({ i }) => {
    let j = i
    while (j > 0 && /^\s*(\/\/|\/\*|\*|#(?!include|define|!)|@|\[|"""|''')/.test(lines[j - 1].t)) j--
    return j
  })
  const blocks: Block[] = []
  if (begin[0] > 0) blocks.push({ lines: lines.slice(0, begin[0]) })
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? begin[k + 1] : lines.length
    const from = begin[k]
    if (end > from) blocks.push({ lines: lines.slice(from, end), names: [s.name] })
  })
  return blocks
}

function paragraphBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = []
  let cur: Line[] = []
  for (const l of lines) {
    cur.push(l)
    if (!l.t.trim()) { if (cur.some((x) => x.t.trim())) blocks.push({ lines: cur }); cur = [] }
  }
  if (cur.some((x) => x.t.trim())) blocks.push({ lines: cur })
  return blocks
}

const size = (lines: Line[]): number => lines.reduce((a, l) => a + l.t.length + 1, 0)

/** The last lines of a passage, up to `max` characters, to start the next one with. */
function tail(lines: Line[], max: number): Line[] {
  const out: Line[] = []
  let n = 0
  for (let i = lines.length - 1; i > 0; i--) {
    n += lines[i].t.length + 1
    if (n > max) break
    out.unshift(lines[i])
  }
  return out
}

/** Cuts one oversized block into windows of at most `max` characters that overlap by about `overlap`. */
function windows(lines: Line[], max: number, overlap: number): Line[][] {
  const out: Line[][] = []
  let cur: Line[] = []
  let n = 0
  for (const l of lines) {
    if (n + l.t.length + 1 > max && cur.length) {
      out.push(cur)
      cur = tail(cur, overlap)
      n = size(cur)
    }
    cur.push(l)
    n += l.t.length + 1
  }
  if (cur.some((l) => l.t.trim())) out.push(cur)
  return out
}

function makeChunk(lines: Line[], heading: string | undefined, section: Section): Chunk | null {
  let a = 0
  let b = lines.length - 1
  while (a <= b && !lines[a].t.trim()) a++
  while (b >= a && !lines[b].t.trim()) b--
  if (a > b) return null
  const kept = lines.slice(a, b + 1)
  const text = kept.map((l) => l.t).join('\n')
  const head = [section.heading, heading].filter(Boolean).join(' > ') || undefined
  return {
    text,
    heading: head,
    startLine: kept[0].n,
    endLine: kept[kept.length - 1].n,
    page: section.page,
    tokens: estimateTokens(text)
  }
}

function chunkSection(section: Section, maxChars: number, overlapChars: number): Chunk[] {
  if (!section.text.trim()) return []
  let lines = wrap(section.text.replace(/\r\n?/g, '\n'), section.firstLine, Math.max(200, Math.floor(maxChars / 2)))
  // Spreadsheets: the header row is repeated at the top of every passage.
  let header: Line | undefined
  if (section.kind === 'sheet' && lines.length > 1) { header = lines[0]; lines = lines.slice(1) }
  const blocks: Block[] = section.kind === 'markdown' ? markdownBlocks(lines)
    : section.kind === 'code' ? codeBlocks(lines)
      : section.kind === 'sheet' ? lines.map((l) => ({ lines: [l] }))
        : paragraphBlocks(lines)
  const budget = maxChars - (header ? header.t.length + 1 : 0)
  const out: Chunk[] = []
  let cur: Line[] = []
  let heads: string[] = []
  let n = 0
  const label = (): string | undefined => {
    if (section.kind === 'code') return heads.length ? heads.slice(0, 3).join(', ') + (heads.length > 3 ? ', …' : '') : undefined
    return heads[0]
  }
  const push = (lines: Line[], heading: string | undefined): void => {
    const c = makeChunk(header ? [header, ...lines] : lines, heading, section)
    if (c) {
      // The header line is not part of the passage's line range.
      if (header && lines.length) { c.startLine = lines.find((l) => l.t.trim())?.n ?? c.startLine }
      out.push(c)
    }
  }
  const flush = (carry: boolean): void => {
    if (cur.some((l) => l.t.trim())) push(cur, label())
    // Prose keeps a little overlap across a size cut; headings and code boundaries need none.
    cur = carry && (section.kind === 'text' || section.kind === 'sheet') ? tail(cur, overlapChars) : []
    heads = []
    n = size(cur)
  }
  for (const b of blocks) {
    const bs = size(b.lines)
    // A new chapter (# or ##) starts a new passage once the current one has some substance.
    if (section.kind === 'markdown' && b.level !== undefined && b.level <= 2 && n >= maxChars * 0.15) flush(false)
    if (n + bs > budget && n > 0) {
      flush(true)
      // The carried overlap only fits if the next block leaves room for it.
      if (n + bs > budget) { cur = []; n = 0 }
    }
    if (bs > budget) {
      for (const w of windows(cur.length ? [...cur, ...b.lines] : b.lines, budget, overlapChars)) push(w, b.heading ?? b.names?.[0] ?? label())
      cur = []
      heads = []
      n = 0
      continue
    }
    cur.push(...b.lines)
    n += bs
    const h = b.heading ?? b.names?.[0]
    if (h && !heads.includes(h)) heads.push(h)
  }
  flush(false)
  return out
}

/** Passages for a file's extracted sections. */
export function chunkSections(sections: Section[], opts: ChunkOptions = {}): Chunk[] {
  const maxChars = (opts.maxTokens ?? 800) * 4
  const overlapChars = (opts.overlapTokens ?? 100) * 4
  return sections.flatMap((s) => chunkSection(s, maxChars, overlapChars))
}
