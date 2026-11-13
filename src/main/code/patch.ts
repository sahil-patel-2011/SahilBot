// Editing primitives for the coding tools: exact string replacement with a uniqueness check, multi-file
// patches (unified diffs and the "*** Begin Patch" format) with forgiving context matching, and a
// line diff for showing what changed. Pure functions: the tool layer reads and writes the files.

// ------------------------------------------------------------------ text helpers

export const eolOf = (s: string): '\r\n' | '\n' => (/\r\n/.test(s) ? '\r\n' : '\n')

/** Lines without the final empty element a trailing newline makes. */
export function splitLines(s: string): { lines: string[]; trailingNewline: boolean } {
  if (s === '') return { lines: [], trailingNewline: false }
  const lines = s.split(/\r?\n/)
  const trailingNewline = lines[lines.length - 1] === ''
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

export const joinLines = (lines: string[], eol: string, trailingNewline: boolean): string => (lines.length ? lines.join(eol) + (trailingNewline ? eol : '') : '')

/** Curly quotes, dashes and odd spaces models type instead of what's in the file. */
export function normalizePunct(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[  -​  　]/g, ' ')
    .replace(/…/g, '...')
}

type Tier = 'exact' | 'trailing-space' | 'indentation' | 'punctuation'
const TIERS: Array<{ tier: Tier; norm: (s: string) => string }> = [
  { tier: 'exact', norm: (s) => s },
  { tier: 'trailing-space', norm: (s) => s.replace(/\s+$/, '') },
  { tier: 'indentation', norm: (s) => s.trim() },
  { tier: 'punctuation', norm: (s) => normalizePunct(s).trim().replace(/\s+/g, ' ') }
]

const indentOf = (s: string): string => /^\s*/.exec(s)![0]

/** Re-indents added lines when the match only worked with different leading whitespace. */
function reindent(lines: string[], from: string, to: string): string[] {
  if (from === to) return lines
  return lines.map((l) => (l.startsWith(from) ? to + l.slice(from.length) : !l.trim() ? l : from === '' ? to + l : l))
}

/** All start indexes where `needle` lines occur in `hay` under `norm`. */
function findSeq(hay: string[], needle: string[], norm: (s: string) => string, from = 0): number[] {
  const out: number[] = []
  if (!needle.length) return out
  const n = needle.map(norm)
  const h = hay.map(norm)
  outer: for (let i = Math.max(0, from); i + n.length <= h.length; i++) {
    for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer
    out.push(i)
  }
  return out
}

/** The region of `hay` most like `needle` (share of equal trimmed lines), for failure messages. */
export function closestRegion(hay: string[], needle: string[]): { start: number; score: number } | null {
  if (!needle.length || !hay.length) return null
  const n = needle.map((s) => normalizePunct(s).trim())
  const h = hay.map((s) => normalizePunct(s).trim())
  let best = { start: 0, score: -1 }
  const span = Math.min(n.length, 60)
  for (let i = 0; i <= Math.max(0, h.length - 1); i++) {
    let eq = 0
    for (let j = 0; j < span && i + j < h.length; j++) if (h[i + j] === n[j] && n[j] !== '') eq++
    const score = eq / Math.max(1, n.slice(0, span).filter(Boolean).length)
    if (score > best.score) best = { start: i, score }
    if (h.length > 20_000 && i > 20_000) break
  }
  return best.score > 0 ? best : null
}

const show = (lines: string[], start: number, count: number): string => lines.slice(start, start + count).map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`).join('\n')

// ------------------------------------------------------------------ exact replace

export interface ReplaceResult { content: string; count: number; note?: string; firstLine: number }

/**
 * Replaces `oldStr` with `newStr`. It must occur exactly once unless replaceAll. When the exact text
 * isn't there, a single match that differs only in trailing spaces, indentation or typographic
 * punctuation is accepted (and said so); otherwise the error shows the closest lines.
 */
export function replaceExact(content: string, oldStr: string, newStr: string, replaceAll = false, file = 'the file'): ReplaceResult {
  if (oldStr === '') throw new Error('old_string is empty. To create a file use file_write; to add text, include a nearby line in old_string.')
  if (oldStr === newStr) throw new Error('old_string and new_string are the same: nothing to change.')
  const eol = eolOf(content)
  if (eol === '\r\n' && !oldStr.includes('\r')) { oldStr = oldStr.replace(/\n/g, '\r\n'); newStr = newStr.replace(/\n/g, '\r\n') }
  const starts: number[] = []
  for (let i = content.indexOf(oldStr); i >= 0; i = content.indexOf(oldStr, i + oldStr.length)) starts.push(i)
  const lineAt = (idx: number): number => content.slice(0, idx).split('\n').length
  if (starts.length === 1 || (starts.length > 1 && replaceAll)) {
    let out = ''
    let last = 0
    for (const s of starts) { out += content.slice(last, s) + newStr; last = s + oldStr.length }
    return { content: out + content.slice(last), count: starts.length, firstLine: lineAt(starts[0]) }
  }
  if (starts.length > 1) {
    const where = starts.slice(0, 8).map(lineAt).join(', ')
    throw new Error(`old_string occurs ${starts.length} times in ${file} (lines ${where}${starts.length > 8 ? ', …' : ''}). Include more surrounding lines so it matches exactly one place, or set replace_all: true to change every one.`)
  }
  // Not found exactly: line-based matching that forgives whitespace and punctuation.
  const { lines, trailingNewline } = splitLines(content)
  const oldLines = splitLines(oldStr.replace(/\r\n/g, '\n')).lines
  const newLines = splitLines(newStr.replace(/\r\n/g, '\n')).lines
  // old_string may cut a line mid-way; line matching only applies when it is whole lines.
  if (oldLines.length) {
    for (const t of TIERS.slice(1)) {
      const hits = findSeq(lines, oldLines, t.norm)
      if (hits.length > 1 && !replaceAll) {
        throw new Error(`old_string matches ${hits.length} places in ${file} when ignoring ${t.tier === 'trailing-space' ? 'trailing spaces' : t.tier} (lines ${hits.slice(0, 8).map((h) => h + 1).join(', ')}). Include more surrounding lines so it matches exactly one place.`)
      }
      if (!hits.length) continue
      const firstOld = oldLines.find((l) => l.trim()) ?? ''
      let next = lines.slice()
      for (const h of [...hits].reverse()) {
        const firstFile = lines.slice(h, h + oldLines.length).find((l) => l.trim()) ?? ''
        const repl = t.tier === 'trailing-space' ? newLines : reindent(newLines, indentOf(firstOld), indentOf(firstFile))
        next = [...next.slice(0, h), ...repl, ...next.slice(h + oldLines.length)]
      }
      return { content: joinLines(next, eol, trailingNewline), count: hits.length, firstLine: hits[0] + 1, note: `matched ignoring ${t.tier === 'trailing-space' ? 'trailing spaces' : t.tier === 'indentation' ? 'indentation (new text re-indented to fit)' : 'quote/dash style and spacing'}` }
    }
  }
  const near = closestRegion(lines, oldLines.length ? oldLines : [oldStr])
  const hint = near ? `\nClosest lines in ${file} (${Math.round(near.score * 100)}% of lines equal):\n${show(lines, near.start, Math.min(Math.max(oldLines.length, 1) + 2, 20))}` : ''
  throw new Error(`old_string was not found in ${file}. It must match the current file exactly (copy it from a fresh file_read, without line numbers).${hint}`)
}

// ------------------------------------------------------------------ patches

export type HunkLine = { t: ' ' | '-' | '+'; s: string }
export interface Hunk { lines: HunkLine[]; hint?: number; header?: string; eof?: boolean }
export interface FilePatch { op: 'add' | 'delete' | 'update'; path: string; moveTo?: string; hunks: Hunk[] }

const stripPrefix = (p: string): string => p.replace(/\t.*$/, '').trim().replace(/^"(.*)"$/, '$1').replace(/^[ab]\//, '')

/** Parses a "*** Begin Patch" patch or a unified / git diff into per-file operations. */
export function parsePatch(text: string): FilePatch[] {
  const src = text.replace(/\r\n/g, '\n').replace(/^\s*```(?:diff|patch)?\s*\n/, '').replace(/\n```\s*$/, '\n')
  return /^\*\*\* Begin Patch/m.test(src) ? parseCodex(src) : parseUnified(src)
}

function parseCodex(src: string): FilePatch[] {
  const lines = src.split('\n')
  let i = lines.findIndex((l) => l.startsWith('*** Begin Patch')) + 1
  const out: FilePatch[] = []
  let cur: FilePatch | null = null
  let hunk: Hunk | null = null
  const newHunk = (header?: string): Hunk => { const h: Hunk = { lines: [], ...(header ? { header } : {}) }; cur!.hunks.push(h); return h }
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('*** End Patch')) break
    let m: RegExpExecArray | null
    if ((m = /^\*\*\* (Add|Delete|Update) File:\s*(.+)$/.exec(l))) {
      cur = { op: m[1].toLowerCase() as FilePatch['op'], path: m[2].trim(), hunks: [] }
      out.push(cur)
      hunk = cur.op === 'add' ? newHunk() : null
      continue
    }
    if (!cur) { if (l.trim()) throw new Error(`Patch line ${i + 1} is outside a file section: "${l.slice(0, 80)}". Start each file with "*** Update File: path", "*** Add File: path" or "*** Delete File: path".`); continue }
    if ((m = /^\*\*\* Move to:\s*(.+)$/.exec(l))) { cur.moveTo = m[1].trim(); continue }
    if (l.startsWith('*** End of File')) { if (hunk) hunk.eof = true; continue }
    if (cur.op === 'delete') continue
    if (cur.op === 'add') {
      hunk!.lines.push({ t: '+', s: l.startsWith('+') ? l.slice(1) : l })
      continue
    }
    if (l.startsWith('@@')) { hunk = newHunk(l.replace(/^@@\s?/, '').replace(/\s*@@.*$/, '').trim() || undefined); continue }
    hunk ??= newHunk()
    if (l.startsWith('+')) hunk.lines.push({ t: '+', s: l.slice(1) })
    else if (l.startsWith('-')) hunk.lines.push({ t: '-', s: l.slice(1) })
    else if (l.startsWith(' ')) hunk.lines.push({ t: ' ', s: l.slice(1) })
    else hunk.lines.push({ t: ' ', s: l }) // a context line whose leading space got lost
  }
  // A trailing blank line before "*** End Patch" is usually an artifact.
  for (const f of out) {
    if (f.op === 'add') { const h = f.hunks[0]; while (h?.lines.length && h.lines[h.lines.length - 1].s === '') h.lines.pop() }
    for (const h of f.hunks) while (h.lines.length && h.lines[h.lines.length - 1].t === ' ' && h.lines[h.lines.length - 1].s === '') h.lines.pop()
    f.hunks = f.hunks.filter((h) => h.lines.length || f.op === 'add')
  }
  if (!out.length) throw new Error('The patch has no file sections ("*** Update File: path" etc.).')
  return out
}

function parseUnified(src: string): FilePatch[] {
  const lines = src.split('\n')
  const out: FilePatch[] = []
  let cur: FilePatch | null = null
  let hunk: Hunk | null = null
  let pendingGit: { a: string; b: string; deleted?: boolean; added?: boolean; rename?: { from?: string; to?: string } } | null = null
  const flushGit = (): void => {
    // A git diff with no hunks (pure rename, mode change, empty new file).
    if (pendingGit && !cur) {
      if (pendingGit.rename?.from && pendingGit.rename.to) out.push({ op: 'update', path: pendingGit.rename.from, moveTo: pendingGit.rename.to, hunks: [] })
      else if (pendingGit.deleted) out.push({ op: 'delete', path: pendingGit.a, hunks: [] })
      else if (pendingGit.added) out.push({ op: 'add', path: pendingGit.b, hunks: [{ lines: [] }] })
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    let m: RegExpExecArray | null
    if ((m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(l))) { flushGit(); cur = null; hunk = null; pendingGit = { a: m[1], b: m[2] }; continue }
    if (pendingGit && !cur) {
      if (/^deleted file mode/.test(l)) { pendingGit.deleted = true; continue }
      if (/^new file mode/.test(l)) { pendingGit.added = true; continue }
      if ((m = /^rename from (.+)$/.exec(l))) { pendingGit.rename = { ...pendingGit.rename, from: m[1] }; continue }
      if ((m = /^rename to (.+)$/.exec(l))) { pendingGit.rename = { ...pendingGit.rename, to: m[1] }; continue }
      if (/^(index |similarity index|old mode|new mode|Binary files)/.test(l)) continue
    }
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const a = l.slice(4)
      const b = lines[i + 1].slice(4)
      i++
      const aNull = /^\/dev\/null\b/.test(a.trim())
      const bNull = /^\/dev\/null\b/.test(b.trim())
      const from = stripPrefix(a)
      const to = stripPrefix(b)
      cur = aNull ? { op: 'add', path: to, hunks: [] } : bNull ? { op: 'delete', path: from, hunks: [] } : { op: 'update', path: from, hunks: [], ...(from !== to ? { moveTo: to } : {}) }
      if (pendingGit?.rename?.from && pendingGit.rename.to && cur.op === 'update') { cur.path = pendingGit.rename.from; cur.moveTo = pendingGit.rename.to }
      out.push(cur)
      pendingGit = null
      hunk = null
      continue
    }
    if (!cur) continue
    if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(l)) || /^@@/.test(l)) {
      const oldStart = m ? Number(m[1]) : undefined
      const oldCount = m ? (m[2] === undefined ? 1 : Number(m[2])) : undefined
      // "-a,0" inserts after line a; otherwise the hunk starts at line a.
      hunk = { lines: [], ...(oldStart !== undefined ? { hint: oldCount === 0 ? oldStart + 1 : oldStart } : {}) }
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (l.startsWith('\\')) continue // "\ No newline at end of file"
    if (l.startsWith('+')) hunk.lines.push({ t: '+', s: l.slice(1) })
    else if (l.startsWith('-')) hunk.lines.push({ t: '-', s: l.slice(1) })
    else if (l.startsWith(' ')) hunk.lines.push({ t: ' ', s: l.slice(1) })
    else if (l === '') hunk.lines.push({ t: ' ', s: '' })
    else { cur = null; hunk = null } // prose between files
  }
  flushGit()
  for (const f of out) for (const h of f.hunks) while (h.lines.length && h.lines[h.lines.length - 1].t === ' ' && h.lines[h.lines.length - 1].s === '' && f.op !== 'add') h.lines.pop()
  if (!out.length) throw new Error('No file changes found. Send a unified diff ("--- a/path", "+++ b/path", "@@ … @@" hunks) or a "*** Begin Patch" patch.')
  return out
}

/** Paths a patch touches, split by what happens to them (for permission checks before running). */
export function patchSummary(text: string): { paths: string[]; deletes: string[]; adds: string[]; moves: Array<{ from: string; to: string }> } {
  const fps = parsePatch(text)
  return {
    paths: [...new Set(fps.flatMap((f) => [f.path, ...(f.moveTo ? [f.moveTo] : [])]))],
    deletes: fps.filter((f) => f.op === 'delete').map((f) => f.path),
    adds: fps.filter((f) => f.op === 'add').map((f) => f.path),
    moves: fps.filter((f) => f.moveTo).map((f) => ({ from: f.path, to: f.moveTo! }))
  }
}

/** Applies one file's hunks to its text. Throws a precise message when a hunk's lines can't be found. */
export function applyHunks(content: string, hunks: Hunk[], file: string): { content: string; notes: string[] } {
  const eol = eolOf(content)
  const { lines: orig, trailingNewline } = splitLines(content)
  let lines = orig.slice()
  const notes: string[] = []
  let cursor = 0
  let delta = 0
  hunks.forEach((h, hi) => {
    const label = `Hunk ${hi + 1}${hunks.length > 1 ? ` of ${hunks.length}` : ''} in ${file}`
    let oldL = h.lines.filter((x) => x.t !== '+').map((x) => x.s)
    const added = h.lines.filter((x) => x.t !== '-')
    // A context header ("@@ def foo"): start looking after the line that has it.
    if (h.header) {
      const hdr = normalizePunct(h.header).trim()
      const at = lines.findIndex((l, i) => i >= cursor && normalizePunct(l).trim().includes(hdr))
      const any = at >= 0 ? at : lines.findIndex((l) => normalizePunct(l).trim().includes(hdr))
      if (any >= 0) cursor = any + 1
    }
    const hint = h.hint !== undefined ? Math.max(0, h.hint - 1 + delta) : undefined
    if (!oldL.length) {
      // Pure insertion: at the hinted line, after the header, or at the end.
      const at = hint !== undefined ? Math.min(hint, lines.length) : h.header || !h.eof ? (h.header ? cursor : lines.length) : lines.length
      lines = [...lines.slice(0, at), ...added.map((x) => x.s), ...lines.slice(at)]
      cursor = at + added.length
      delta += added.length
      return
    }
    let found: { at: number; tier: Tier; lead: number; trail: number } | null = null
    // Models often add or drop blank context lines at a hunk's edges: retry without them.
    const variants: Array<{ lead: number; trail: number }> = [{ lead: 0, trail: 0 }]
    let lead = 0
    while (lead < h.lines.length && h.lines[lead].t === ' ' && !h.lines[lead].s.trim()) lead++
    let trail = 0
    while (trail < h.lines.length - lead && h.lines[h.lines.length - 1 - trail].t === ' ' && !h.lines[h.lines.length - 1 - trail].s.trim()) trail++
    if (lead || trail) variants.push({ lead, trail })
    search: for (const v of variants) {
      const sub = h.lines.slice(v.lead, h.lines.length - v.trail)
      const o = sub.filter((x) => x.t !== '+').map((x) => x.s)
      if (!o.length) continue
      for (const t of TIERS) {
        let hits = findSeq(lines, o, t.norm, cursor)
        if (!hits.length) hits = findSeq(lines, o, t.norm, 0)
        if (!hits.length) continue
        if (h.eof) { const end = hits.filter((x) => x + o.length === lines.length); if (end.length) hits = end }
        const pick = hint !== undefined ? hits.reduce((a, b) => (Math.abs(b - hint) < Math.abs(a - hint) ? b : a)) : hits[0]
        found = { at: pick, tier: t.tier, ...v }
        break search
      }
    }
    if (!found) {
      const near = closestRegion(lines, oldL)
      const want = oldL.slice(0, 12).map((s) => `        ${s}`).join('\n')
      throw new Error(`${label} did not apply: these lines are not in the file:\n${want}${oldL.length > 12 ? '\n        …' : ''}${near ? `\nClosest lines (${Math.round(near.score * 100)}% equal) start at line ${near.start + 1}:\n${show(lines, near.start, Math.min(oldL.length + 2, 16))}` : ''}\nRe-read the file (file_read with start/end) and make the patch's context and "-" lines match it exactly.`)
    }
    const sub = h.lines.slice(found.lead, h.lines.length - found.trail)
    oldL = sub.filter((x) => x.t !== '+').map((x) => x.s)
    const fileSlice = lines.slice(found.at, found.at + oldL.length)
    // Each old line's indentation in the patch vs. in the file; an added line follows the nearest
    // removed line in its change block, else the nearest context line.
    const pairs: Array<{ from: string; to: string; t: ' ' | '-' } | null> = []
    {
      let k = 0
      for (const x of sub) {
        if (x.t === '+') { pairs.push(null); continue }
        const f = fileSlice[k++]
        pairs.push(x.s.trim() && f?.trim() ? { from: indentOf(x.s), to: indentOf(f), t: x.t } : null)
      }
    }
    const pairFor = (i: number): { from: string; to: string } | null => {
      let lo = i
      while (lo > 0 && sub[lo - 1].t !== ' ') lo--
      let hi = i
      while (hi < sub.length - 1 && sub[hi + 1].t !== ' ') hi++
      for (let d = 1; d < sub.length; d++) {
        for (const j of [i - d, i + d]) if (j >= lo && j <= hi && pairs[j]?.t === '-') return pairs[j]
      }
      for (let j = i - 1; j >= 0; j--) if (pairs[j]) return pairs[j]
      for (let j = i + 1; j < sub.length; j++) if (pairs[j]) return pairs[j]
      return null
    }
    const repl: string[] = []
    let k = 0
    sub.forEach((x, i) => {
      if (x.t === ' ') repl.push(fileSlice[k++])
      else if (x.t === '-') k++
      else if (found!.tier === 'indentation' || found!.tier === 'punctuation') {
        const p = pairFor(i)
        repl.push(p ? reindent([x.s], p.from, p.to)[0] : x.s)
      } else repl.push(x.s)
    })
    lines = [...lines.slice(0, found.at), ...repl, ...lines.slice(found.at + oldL.length)]
    if (found.tier !== 'exact') notes.push(`${label} matched ignoring ${found.tier === 'trailing-space' ? 'trailing spaces' : found.tier === 'indentation' ? 'indentation' : 'quote/dash style and spacing'}`)
    if (hint !== undefined && Math.abs(found.at - hint) > 3) notes.push(`${label} applied at line ${found.at + 1} (the header said ${hint + 1})`)
    cursor = found.at + repl.length
    delta += repl.length - oldL.length
  })
  return { content: joinLines(lines, eol, trailingNewline || (!orig.length && lines.length > 0)), notes }
}

// ------------------------------------------------------------------ diff

export type DiffOp = { t: ' ' | '-' | '+'; s: string }

/** Myers line diff (with common prefix/suffix trimmed; very different middles become delete + insert). */
export function diffLines(a: string[], b: string[], maxD = 2000): DiffOp[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const head: DiffOp[] = a.slice(0, pre).map((s) => ({ t: ' ', s }))
  const tail: DiffOp[] = a.slice(a.length - suf).map((s) => ({ t: ' ', s }))
  return [...head, ...myers(A, B, maxD), ...tail]
}

function myers(a: string[], b: string[], maxD: number): DiffOp[] {
  const n = a.length
  const m = b.length
  if (!n) return b.map((s) => ({ t: '+', s }))
  if (!m) return a.map((s) => ({ t: '-', s }))
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Array<{ arr: Int32Array; base: number }> = []
  let done = -1
  outer: for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push({ arr: v.slice(off - d - 1, off + d + 2), base: off - d - 1 })
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) { done = d; break outer }
    }
  }
  if (done < 0) return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))]
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = done; d >= 0; d--) {
    const { arr, base } = trace[d]
    const at = (k: number): number => arr[off + k - base]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) { ops.push({ t: ' ', s: a[x - 1] }); x--; y-- }
    if (d > 0) {
      if (x === prevX) { ops.push({ t: '+', s: b[y - 1] }); y-- } else { ops.push({ t: '-', s: a[x - 1] }); x-- }
    }
  }
  return ops.reverse()
}

export interface DiffText { text: string; added: number; removed: number }

/** A unified diff of two versions of a file ('' before = new file, null after = deleted). */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3, toPath = path): DiffText {
  const a = before === null ? [] : splitLines(before).lines
  const b = after === null ? [] : splitLines(after).lines
  const ops = diffLines(a, b)
  const added = ops.filter((o) => o.t === '+').length
  const removed = ops.filter((o) => o.t === '-').length
  if (!added && !removed) return { text: path === toPath ? '' : `rename ${path} → ${toPath}`, added, removed }
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${toPath}`}`]
  // Positions of each op in the old and new files.
  const pos: Array<{ ai: number; bi: number }> = []
  let ai = 0
  let bi = 0
  for (const o of ops) { pos.push({ ai, bi }); if (o.t !== '+') ai++; if (o.t !== '-') bi++ }
  const changed = ops.map((o, i) => (o.t !== ' ' ? i : -1)).filter((i) => i >= 0)
  let gi = 0
  while (gi < changed.length) {
    let start = Math.max(0, changed[gi] - context)
    let end = changed[gi]
    while (gi + 1 < changed.length && changed[gi + 1] - end <= context * 2 + 1) end = changed[++gi]
    gi++
    end = Math.min(ops.length - 1, end + context)
    if (start < 0) start = 0
    const slice = ops.slice(start, end + 1)
    const oldCount = slice.filter((o) => o.t !== '+').length
    const newCount = slice.filter((o) => o.t !== '-').length
    const oldStart = oldCount ? pos[start].ai + 1 : pos[start].ai
    const newStart = newCount ? pos[start].bi + 1 : pos[start].bi
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const o of slice) out.push(`${o.t}${o.s}`)
  }
  return { text: out.join('\n'), added, removed }
}

/** Keeps a diff readable in a tool result: whole hunks up to the budget, then a note. */
export function clipDiff(text: string, max = 12_000): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n@@', max)
  return `${text.slice(0, cut > max / 2 ? cut : max)}\n… [diff cut: ${text.length - max} more characters]`
}
