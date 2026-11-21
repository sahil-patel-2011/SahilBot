import type { DocBlock, DocContent } from '@shared/types'
import { sameBlock } from './diff'

/**
 * Three-way merge by block id: `mine` and `theirs` were both made from `base`. Blocks only one side changed
 * take that side; blocks both changed take `mine` (the user's own typing wins in the editor). Blocks a side
 * added keep their place after the block that preceded them; a block either side deleted stays deleted
 * unless the other side changed it. Sheets merge cell by cell, titles the same way. Pure.
 */
export function merge3(base: DocContent, theirs: DocContent, mine: DocContent): DocContent {
  const baseM = new Map(base.blocks.map((b) => [b.id, b]))
  const theirM = new Map(theirs.blocks.map((b) => [b.id, b]))
  const mineM = new Map(mine.blocks.map((b) => [b.id, b]))

  const pick = (id: string): DocBlock | null => {
    const b0 = baseM.get(id)
    const t = theirM.get(id)
    const m = mineM.get(id)
    if (!b0) return m ?? t ?? null
    const mineChanged = !m || !sameBlock(b0, m)
    const theirChanged = !t || !sameBlock(b0, t)
    if (!m) return theirChanged && t ? t : null // I deleted it: gone, unless they changed it
    if (!t) return mineChanged ? m : null // they deleted it: gone, unless I changed it
    return mineChanged ? m : t
  }

  // Order: mine's order, then their new blocks after their predecessor (in their order).
  const order: string[] = mine.blocks.map((b) => b.id)
  const theirOrder = theirs.blocks.map((b) => b.id)
  // Their moves of blocks I didn't move: follow their order for blocks whose relative order only they changed.
  const mineMoved = movedIds(base.blocks.map((b) => b.id), order)
  const theirMoved = movedIds(base.blocks.map((b) => b.id), theirOrder)
  for (const id of theirOrder) {
    if (!theirMoved.has(id) || mineMoved.has(id) || !mineM.has(id)) continue
    const k = order.indexOf(id)
    if (k !== -1) order.splice(k, 1)
    insertAfterPred(order, theirOrder, id)
  }
  for (const id of theirOrder) if (!baseM.has(id) && !mineM.has(id)) insertAfterPred(order, theirOrder, id)
  // Blocks they still have that I never had nor deleted (cannot happen without base) are covered above;
  // blocks I deleted that they changed come back at their place.
  for (const id of theirOrder) if (baseM.has(id) && !mineM.has(id) && !order.includes(id) && pick(id)) insertAfterPred(order, theirOrder, id)

  const blocks = order.map(pick).filter((b): b is DocBlock => !!b)
  const title = mine.title !== base.title ? mine.title : theirs.title
  let sheet = mine.sheet ?? theirs.sheet
  if (base.sheet && theirs.sheet && mine.sheet) {
    const cells: Record<string, string> = {}
    const keys = new Set([...Object.keys(base.sheet.cells), ...Object.keys(theirs.sheet.cells), ...Object.keys(mine.sheet.cells)])
    for (const k of keys) {
      const b0 = base.sheet.cells[k] ?? ''
      const m = mine.sheet.cells[k] ?? ''
      const t = theirs.sheet.cells[k] ?? ''
      const v = m !== b0 ? m : t
      if (v !== '') cells[k] = v
    }
    sheet = {
      ...mine.sheet,
      rows: Math.max(mine.sheet.rows, theirs.sheet.rows),
      cols: Math.max(mine.sheet.cols, theirs.sheet.cols),
      cells,
      header: mine.sheet.header !== base.sheet.header ? mine.sheet.header : theirs.sheet.header
    }
  }
  // The look: mine when I changed it, else theirs.
  const style = JSON.stringify(mine.style ?? null) !== JSON.stringify(base.style ?? null) ? mine.style : theirs.style
  return { title, blocks, ...(sheet ? { sheet } : {}), ...(style ? { style } : {}) }
}

function insertAfterPred(order: string[], ref: string[], id: string): void {
  const k = ref.indexOf(id)
  for (let j = k - 1; j >= 0; j--) {
    const at = order.indexOf(ref[j])
    if (at !== -1) { order.splice(at + 1, 0, id); return }
  }
  order.unshift(id)
}

/** Ids whose order relative to the others changed (not on the longest kept run). */
function movedIds(a: string[], b: string[]): Set<string> {
  const inB = new Set(b)
  const shared = a.filter((x) => inB.has(x))
  const pos = new Map(b.map((x, i) => [x, i]))
  // Longest increasing subsequence of positions = blocks that stayed in place.
  const seq = shared.map((x) => pos.get(x)!)
  const tails: number[] = []
  const prevIdx: number[] = new Array(seq.length).fill(-1)
  const tailIdx: number[] = []
  seq.forEach((v, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid }
    tails[lo] = v
    tailIdx[lo] = i
    prevIdx[i] = lo > 0 ? tailIdx[lo - 1] : -1
  })
  const keep = new Set<string>()
  let k = tailIdx[tails.length - 1]
  while (k !== undefined && k >= 0) { keep.add(shared[k]); k = prevIdx[k] }
  return new Set(shared.filter((x) => !keep.has(x)))
}
