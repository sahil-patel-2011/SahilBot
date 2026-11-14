import type { DocBlock, DocContent, DocDiff, DocDiffRow } from '@shared/types'
import { preview } from './inline'

// What changed between two versions of a document: by block id (and by cell for sheets). Pure.

/** A block's content without its id, for comparing. */
export function blockKey(b: DocBlock | undefined): string {
  if (!b) return ''
  const { id: _id, ...rest } = b
  return JSON.stringify(rest, Object.keys(rest).sort())
}

export const sameBlock = (a: DocBlock | undefined, b: DocBlock | undefined): boolean => blockKey(a) === blockKey(b)

export interface ContentDelta {
  /** Blocks in b but not in a. */
  added: string[]
  /** Blocks in a but not in b. */
  removed: string[]
  /** Blocks in both whose content differs. */
  changed: string[]
  /** Blocks whose position among the shared blocks moved. */
  moved: string[]
  title: boolean
  /** Sheet cells whose input differs. */
  cells: string[]
}

/** The longest common subsequence of two id lists (for moves). */
function lcs(a: string[], b: string[]): Set<string> {
  if (a.length * b.length > 4_000_000) return new Set(a.filter((x, i) => b[i] === x))
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const keep = new Set<string>()
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { keep.add(a[i]); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return keep
}

export function diffContent(a: DocContent, b: DocContent): ContentDelta {
  const am = new Map(a.blocks.map((x) => [x.id, x]))
  const bm = new Map(b.blocks.map((x) => [x.id, x]))
  const added = b.blocks.filter((x) => !am.has(x.id)).map((x) => x.id)
  const removed = a.blocks.filter((x) => !bm.has(x.id)).map((x) => x.id)
  const changed = b.blocks.filter((x) => am.has(x.id) && !sameBlock(am.get(x.id), x)).map((x) => x.id)
  const sharedA = a.blocks.map((x) => x.id).filter((id) => bm.has(id))
  const sharedB = b.blocks.map((x) => x.id).filter((id) => am.has(id))
  const stay = lcs(sharedA, sharedB)
  const moved = sharedB.filter((id) => !stay.has(id))
  const cells: string[] = []
  const ac = a.sheet?.cells ?? {}
  const bc = b.sheet?.cells ?? {}
  for (const k of new Set([...Object.keys(ac), ...Object.keys(bc)])) if ((ac[k] ?? '') !== (bc[k] ?? '')) cells.push(k)
  return { added, removed, changed, moved, title: a.title !== b.title, cells }
}

/** The change keys a version records: block ids, "title", "cell:A1". */
export function changeKeys(d: ContentDelta): string[] {
  return [...new Set([...d.added, ...d.removed, ...d.changed, ...d.moved, ...(d.title ? ['title'] : []), ...d.cells.map((c) => `cell:${c}`)])]
}

export const isEmptyDelta = (d: ContentDelta): boolean => !d.added.length && !d.removed.length && !d.changed.length && !d.moved.length && !d.title && !d.cells.length

/** A one-line summary of a change, e.g. 'Edited "Day 1: Paris…" and added 2 blocks'. */
export function summarize(a: DocContent, b: DocContent, d: ContentDelta = diffContent(a, b)): string {
  const parts: string[] = []
  const bm = new Map(b.blocks.map((x) => [x.id, x]))
  const am = new Map(a.blocks.map((x) => [x.id, x]))
  const label = (x: DocBlock | undefined): string => {
    if (!x) return 'a block'
    if (x.type === 'table') return 'a table'
    if (x.type === 'divider') return 'a divider'
    if (x.type === 'image') return 'an image'
    const t = preview(x.text ?? '', 36)
    return t ? `"${t}"` : 'an empty line'
  }
  if (d.title) parts.push(`renamed to "${preview(b.title, 40)}"`)
  if (d.changed.length === 1) parts.push(`edited ${label(bm.get(d.changed[0]))}`)
  else if (d.changed.length > 1) parts.push(`edited ${d.changed.length} blocks`)
  if (d.added.length === 1) parts.push(`added ${label(bm.get(d.added[0]))}`)
  else if (d.added.length > 1) parts.push(`added ${d.added.length} blocks`)
  if (d.removed.length === 1) parts.push(`removed ${label(am.get(d.removed[0]))}`)
  else if (d.removed.length > 1) parts.push(`removed ${d.removed.length} blocks`)
  if (d.moved.length && !d.added.length && !d.removed.length) parts.push(d.moved.length === 1 ? `moved ${label(bm.get(d.moved[0]))}` : `moved ${d.moved.length} blocks`)
  if (d.cells.length) parts.push(d.cells.length === 1 ? `changed cell ${d.cells[0]}` : `changed ${d.cells.length} cells`)
  const s = parts.join(', ') || 'no changes'
  return s[0].toUpperCase() + s.slice(1)
}

// ---------------------------------------------------------------- view diff

/** Word-level diff (LCS over words and spaces). */
export function wordDiff(a: string, b: string): Array<{ t: 'same' | 'add' | 'del'; s: string }> {
  const A = a.split(/(\s+)/).filter(Boolean)
  const B = b.split(/(\s+)/).filter(Boolean)
  if (A.length * B.length > 1_000_000) return [{ t: 'del', s: a }, { t: 'add', s: b }]
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0))
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: Array<{ t: 'same' | 'add' | 'del'; s: string }> = []
  const push = (t: 'same' | 'add' | 'del', s: string): void => {
    const last = out[out.length - 1]
    if (last && last.t === t) last.s += s
    else out.push({ t, s })
  }
  let i = 0
  let j = 0
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { push('same', A[i]); i++; j++ } else if (j < B.length && (i >= A.length || dp[i][j + 1] >= dp[i + 1][j])) { push('add', B[j]); j++ } else { push('del', A[i]); i++ }
  }
  return out
}

const textOf = (b: DocBlock): string => (b.type === 'table' ? (b.rows ?? []).map((r) => r.join(' | ')).join('\n') : b.text ?? '')

/** Rows for the version-diff view: b's blocks in order, with a's removed blocks where they used to be. */
export function diffView(a: DocContent, b: DocContent, from: number, to: number): DocDiff {
  const am = new Map(a.blocks.map((x) => [x.id, x]))
  const bm = new Map(b.blocks.map((x) => [x.id, x]))
  const rows: DocDiffRow[] = []
  const placed = new Set<string>()
  // Removed blocks go right after the block that preceded them in a (or at the top).
  const removedAfter = new Map<string, DocBlock[]>()
  let prev = ''
  for (const x of a.blocks) {
    if (!bm.has(x.id)) {
      const key = prev
      removedAfter.set(key, [...(removedAfter.get(key) ?? []), x])
    } else prev = x.id
  }
  const flushRemoved = (key: string): void => {
    for (const x of removedAfter.get(key) ?? []) if (!placed.has(x.id)) { placed.add(x.id); rows.push({ status: 'removed', block: x }) }
  }
  flushRemoved('')
  for (const x of b.blocks) {
    const old = am.get(x.id)
    if (!old) rows.push({ status: 'added', block: x })
    else if (sameBlock(old, x)) rows.push({ status: 'same', block: x })
    else rows.push({ status: 'changed', block: x, before: old, ...(old.type === x.type || (old.text !== undefined && x.text !== undefined) ? { words: wordDiff(textOf(old), textOf(x)) } : {}) })
    flushRemoved(x.id)
  }
  for (const [, xs] of removedAfter) for (const x of xs) if (!placed.has(x.id)) { placed.add(x.id); rows.push({ status: 'removed', block: x }) }
  const cells: NonNullable<DocDiff['cells']> = []
  const ac = a.sheet?.cells ?? {}
  const bc = b.sheet?.cells ?? {}
  for (const k of new Set([...Object.keys(ac), ...Object.keys(bc)])) if ((ac[k] ?? '') !== (bc[k] ?? '')) cells.push({ addr: k, before: ac[k] ?? '', after: bc[k] ?? '' })
  return { from, to, ...(a.title !== b.title ? { title: { before: a.title, after: b.title } } : {}), rows, ...(cells.length || a.sheet || b.sheet ? { cells } : {}) }
}
