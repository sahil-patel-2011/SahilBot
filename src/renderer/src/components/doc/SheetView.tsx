import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocSheet } from '@shared/types'
import { addr, colName, evaluateSheet, isFormula, MAX_COLS, MAX_ROWS, showValue } from '../../../../main/docspace/sheet'

// The sheet view: a grid with column letters and row numbers, a formula bar for the selected cell, and
// values computed locally with the same engine the bot reads.

export function SheetView({ sheet, onChange, flash, readOnly }: {
  sheet: DocSheet
  onChange: (next: DocSheet, structural?: boolean) => void
  /** Cells to flash (just changed by the bot), with a counter that restarts the animation. */
  flash: Record<string, number>
  readOnly: boolean
}) {
  const computed = useMemo(() => evaluateSheet(sheet.cells), [sheet.cells])
  const [sel, setSel] = useState<{ c: number; r: number }>({ c: 0, r: 0 })
  const [edit, setEdit] = useState<{ c: number; r: number; draft: string; from: 'cell' | 'bar' } | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const rows = Math.max(sheet.rows, 1)
  const cols = Math.max(sheet.cols, 1)
  const selAddr = addr(sel.c, sel.r)

  useEffect(() => { if (edit?.from === 'cell') input.current?.focus() }, [edit?.c, edit?.r, edit?.from])

  const target = (dc: number, dr: number): { c: number; r: number } => ({
    c: Math.min(MAX_COLS - 1, Math.max(0, sel.c + dc)),
    r: Math.min(MAX_ROWS - 1, Math.max(0, sel.r + dr))
  })

  /** Saves the cell being edited, then moves (one change, so a move can't undo the edit). */
  const commit = (move?: { dc: number; dr: number }): void => {
    let next = sheet
    let structural = false
    if (edit && !readOnly) {
      const a = addr(edit.c, edit.r)
      if (edit.draft !== (sheet.cells[a] ?? '')) {
        const cells = { ...sheet.cells }
        if (edit.draft.trim() === '') delete cells[a]
        else cells[a] = edit.draft
        next = { ...next, cells, rows: Math.max(rows, edit.r + 1), cols: Math.max(cols, edit.c + 1) }
        structural = true
      }
    }
    setEdit(null)
    if (move) {
      const t = target(move.dc, move.dr)
      // Moving past the last row or column grows the grid.
      if ((t.r >= next.rows || t.c >= next.cols) && !readOnly) next = { ...next, rows: Math.max(next.rows, t.r + 1), cols: Math.max(next.cols, t.c + 1) }
      setSel(t)
    }
    if (next !== sheet) onChange(next, structural)
    requestAnimationFrame(() => grid.current?.focus())
  }

  const go = (dc: number, dr: number): void => commit({ dc, dr })

  const startEdit = (draft?: string): void => {
    if (readOnly) return
    setEdit({ c: sel.c, r: sel.r, draft: draft ?? sheet.cells[selAddr] ?? '', from: 'cell' })
  }

  const onGridKey = (e: React.KeyboardEvent): void => {
    if (edit) return
    const k = e.key
    if (k === 'ArrowUp') { e.preventDefault(); go(0, -1) } else if (k === 'ArrowDown') { e.preventDefault(); go(0, 1) } else if (k === 'ArrowLeft') { e.preventDefault(); go(-1, 0) } else if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) { e.preventDefault(); go(1, 0) } else if (k === 'Tab' && e.shiftKey) { e.preventDefault(); go(-1, 0) } else if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit() } else if ((k === 'Backspace' || k === 'Delete') && !readOnly) {
      e.preventDefault()
      if (sheet.cells[selAddr] !== undefined) { const cells = { ...sheet.cells }; delete cells[selAddr]; onChange({ ...sheet, cells }, true) }
    } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); startEdit(k) }
  }

  const raw = edit && edit.c === sel.c && edit.r === sel.r ? edit.draft : sheet.cells[selAddr] ?? ''
  const v = computed[selAddr]

  return (
    <div className="doc-sheet">
      <div className="doc-formula-bar">
        <span className="doc-namebox" aria-label="Selected cell">{selAddr}</span>
        <span className="doc-fx" aria-hidden>fx</span>
        <input className="doc-formula" value={raw} readOnly={readOnly} aria-label={`Contents of ${selAddr}`} spellCheck={false} data-testid="sheet-formula"
          placeholder={readOnly ? '' : 'Type a value or a formula like =SUM(B2:B9)'}
          onFocus={() => { if (!edit && !readOnly) setEdit({ c: sel.c, r: sel.r, draft: sheet.cells[selAddr] ?? '', from: 'bar' }) }}
          onChange={(e) => setEdit({ c: sel.c, r: sel.r, draft: e.target.value, from: 'bar' })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit({ dc: 0, dr: 1 }) } else if (e.key === 'Escape') { setEdit(null); grid.current?.focus() } }}
          onBlur={() => { if (edit?.from === 'bar') commit() }} />
        {v?.error && <span className="doc-cell-err" title="This formula has an error">{v.error}</span>}
        {!v?.error && isFormula(sheet.cells[selAddr]) && <span className="doc-cell-val" title="Computed value">= {showValue(v)}</span>}
      </div>
      <div className="doc-grid-wrap" ref={grid} tabIndex={0} onKeyDown={onGridKey} role="grid" aria-label="Sheet" aria-rowcount={rows} aria-colcount={cols}>
        <table className={`doc-grid${sheet.header ? ' has-header' : ''}`}>
          <thead>
            <tr>
              <th className="corner" />
              {Array.from({ length: cols }, (_, c) => <th key={c} scope="col" className={c === sel.c ? 'on' : ''}>{colName(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r} className={r === 0 && sheet.header ? 'hdr' : ''}>
                <th scope="row" className={r === sel.r ? 'on' : ''}>{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const a = addr(c, r)
                  const cv = computed[a]
                  const editing = edit && edit.from === 'cell' && edit.c === c && edit.r === r
                  const isSel = sel.c === c && sel.r === r
                  const fl = flash[`cell:${a}`]
                  return (
                    <td key={c} role="gridcell" aria-selected={isSel} data-testid="sheet-cell" data-addr={a}
                      className={[isSel ? 'sel' : '', typeof cv?.value === 'number' ? 'num' : '', cv?.error ? 'err' : '', fl ? `doc-flash-${fl % 2}` : ''].filter(Boolean).join(' ')}
                      title={cv?.error ? `${cv.error} in ${sheet.cells[a]}` : isFormula(sheet.cells[a]) ? sheet.cells[a] : undefined}
                      onMouseDown={() => { if (edit && !(edit.c === c && edit.r === r)) commit(); setSel({ c, r }) }}
                      onDoubleClick={() => { setSel({ c, r }); if (!readOnly) setEdit({ c, r, draft: sheet.cells[a] ?? '', from: 'cell' }) }}>
                      {editing ? (
                        <input ref={input} className="doc-cell-input" value={edit.draft} spellCheck={false} aria-label={`Edit ${a}`}
                          onChange={(e) => setEdit({ ...edit, draft: e.target.value })}
                          onBlur={() => commit()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commit({ dc: 0, dr: e.shiftKey ? -1 : 1 }) } else if (e.key === 'Tab') { e.preventDefault(); commit({ dc: e.shiftKey ? -1 : 1, dr: 0 }) } else if (e.key === 'Escape') { e.preventDefault(); setEdit(null); grid.current?.focus() }
                          }} />
                      ) : showValue(cv)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="doc-sheet-tools" role="toolbar" aria-label="Sheet">
          <button onClick={() => onChange({ ...sheet, rows: Math.min(MAX_ROWS, rows + 5) }, true)} data-testid="sheet-add-rows">+ 5 rows</button>
          <button onClick={() => onChange({ ...sheet, cols: Math.min(MAX_COLS, cols + 1) }, true)}>+ Column</button>
          <label><input type="checkbox" checked={!!sheet.header} onChange={(e) => onChange({ ...sheet, header: e.target.checked }, true)} /> Header row</label>
          <span className="hint">Formulas: + − × ÷ ^, SUM, AVERAGE, MIN, MAX, COUNT over ranges like B2:B9</span>
        </div>
      )}
    </div>
  )
}
