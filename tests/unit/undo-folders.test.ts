import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test, vi } from 'vitest'

const trash = mkdtempSync(join(tmpdir(), 'sb-trash-'))
vi.mock('electron', () => ({ shell: { trashItem: async (p: string) => { renameSync(p, join(trash, `${Date.now()}-${basename(p)}`)) } }, BrowserWindow: class {} }))

const { fileTools } = await import('../../src/main/agent/tools/files')
const { officeTool } = await import('../../src/main/agent/tools/office')
const { beginRun, changesOf, setUndoRoot, undoRun } = await import('../../src/main/agent/undo-journal')

// Undo said "Undone" (or "Undo brings it back") for things it never recorded: a folder moved or copied, a huge folder
// deleted, a spreadsheet edited in place. Now each of those is either undoable or says plainly that it isn't.

const ctxFor = (threadId: string, ws: string) => ({ threadId, workspaceDir: ws, state: { roots: [], loaded: [], alwaysAllow: [], todos: [] }, signal: new AbortController().signal }) as never

test('a moved folder is moved back, and a copied folder is taken away', async () => {
  setUndoRoot(mkdtempSync(join(tmpdir(), 'sb-undo-')))
  const ws = mkdtempSync(join(tmpdir(), 'sb-undo-dirs-'))
  mkdirSync(join(ws, 'photos'))
  writeFileSync(join(ws, 'photos', 'a.jpg'), 'a')
  mkdirSync(join(ws, 'Archive'))
  mkdirSync(join(ws, 'drafts'))
  writeFileSync(join(ws, 'drafts', 'd.md'), 'd')
  const t = Object.fromEntries(fileTools(() => ws, ws).map((x) => [x.name, x]))
  const ctx = ctxFor('t-dirs', ws)
  beginRun('t-dirs', 'task-dirs')
  await t.file_manage.run({ op: 'move', path: 'photos', to: 'Archive' }, ctx)
  await t.file_manage.run({ op: 'copy', path: 'drafts', to: 'drafts-copy' }, ctx)
  expect(existsSync(join(ws, 'Archive', 'photos', 'a.jpg'))).toBe(true)
  expect(changesOf('t-dirs', 'task-dirs')?.files.length).toBe(2)
  const r = undoRun('t-dirs', 'task-dirs')
  expect(r.skipped).toEqual([])
  expect(readFileSync(join(ws, 'photos', 'a.jpg'), 'utf8')).toBe('a')
  expect(existsSync(join(ws, 'Archive', 'photos'))).toBe(false)
  expect(existsSync(join(ws, 'drafts-copy'))).toBe(false)
  expect(readFileSync(join(ws, 'drafts', 'd.md'), 'utf8')).toBe('d')
})

test('deleting a folder too big to copy says Undo can\'t bring it back (the Trash can)', async () => {
  setUndoRoot(mkdtempSync(join(tmpdir(), 'sb-undo-')))
  const ws = mkdtempSync(join(tmpdir(), 'sb-undo-big-'))
  mkdirSync(join(ws, 'big'))
  for (let i = 0; i < 5001; i++) writeFileSync(join(ws, 'big', `${i}.txt`), '')
  writeFileSync(join(ws, 'small.txt'), 'x')
  const t = Object.fromEntries(fileTools(() => ws, ws).map((x) => [x.name, x]))
  beginRun('t-big', 'task-big')
  const big = await t.file_manage.run({ op: 'delete', path: 'big' }, ctxFor('t-big', ws))
  expect(big.text).toMatch(/too big to keep a copy, so Undo can't bring it back.*restore it from the Trash/)
  const small = await t.file_manage.run({ op: 'delete', path: 'small.txt' }, ctxFor('t-big', ws))
  expect(small.text).toMatch(/Undo brings it back/)
})

test('sheet_write in place is in the undo journal', async () => {
  setUndoRoot(mkdtempSync(join(tmpdir(), 'sb-undo-')))
  const ws = mkdtempSync(join(tmpdir(), 'sb-undo-sheet-'))
  const t = Object.fromEntries(fileTools(() => ws, ws).map((x) => [x.name, x]))
  await t.create_document.run({ path: 'budget.xlsx', sheets: [{ name: 'Budget', rows: [['Item', 'Cost'], ['Rent', 1000]] }] }, ctxFor('t-sheet', ws))
  const before = readFileSync(join(ws, 'budget.xlsx'))
  beginRun('t-sheet', 'task-sheet')
  await officeTool({ getWorkspace: () => ws }).run({ action: 'sheet_write', path: 'budget.xlsx', edits: [{ cell: 'Budget!B2', value: 1200 }] }, ctxFor('t-sheet', ws))
  expect(readFileSync(join(ws, 'budget.xlsx')).equals(before)).toBe(false)
  const r = undoRun('t-sheet', 'task-sheet')
  expect(r.restored).toEqual([join(ws, 'budget.xlsx')])
  expect(readFileSync(join(ws, 'budget.xlsx')).equals(before)).toBe(true)
})
