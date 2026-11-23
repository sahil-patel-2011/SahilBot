import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fileTools } from '../../src/main/agent/tools/files'
import { undoTool } from '../../src/main/agent/tools/undo'
import { beginRun, changesOf, setUndoRoot, undoRun, undoSummary } from '../../src/main/agent/undo-journal'
import { noteSeen } from '../../src/main/agent/tools/freshness'
import { Db } from '../../src/main/db'

// Grok Bot reviewers: "approvals don't reverse anything". A task's file changes can be taken back: files it changed go
// back, files it made go to a holding folder (never deleted), and anything changed since is left alone.

const ctxFor = (threadId: string) => ({ threadId, state: { roots: [], loaded: [], alwaysAllow: [], todos: [] } }) as never

test('undo puts a task\'s file changes back: edits, new files, moves; a file you changed since is left alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sb-undo-root-'))
  setUndoRoot(root)
  const ws = mkdtempSync(join(tmpdir(), 'sb-undo-ws-'))
  writeFileSync(join(ws, 'notes.md'), 'original notes\n')
  writeFileSync(join(ws, 'plan.md'), 'original plan\n')
  writeFileSync(join(ws, 'old-name.txt'), 'keep me\n')
  const t = Object.fromEntries(fileTools(() => ws, mkdtempSync(join(tmpdir(), 'sb-docs-'))).map((x) => [x.name, x]))
  const ctx = ctxFor('t-undo')
  for (const f of ['notes.md', 'plan.md']) noteSeen('t-undo', join(ws, f))

  beginRun('t-undo', 'task-1')
  await t.file_edit.run({ path: 'notes.md', old_string: 'original', new_string: 'rewritten' }, ctx)
  await t.file_write.run({ path: 'plan.md', content: 'the bot\'s plan\n' }, ctx)
  await t.file_write.run({ path: 'report.md', content: '# New report\n' }, ctx)
  await t.file_manage.run({ op: 'move', path: 'old-name.txt', to: 'new-name.txt' }, ctx)
  expect(changesOf('t-undo', 'task-1')?.files.length).toBe(5)

  // You change plan.md yourself afterwards: undo leaves your edit alone.
  writeFileSync(join(ws, 'plan.md'), 'my own edit\n')
  const r = undoRun('t-undo', 'task-1')
  expect(readFileSync(join(ws, 'notes.md'), 'utf8')).toBe('original notes\n')
  expect(readFileSync(join(ws, 'plan.md'), 'utf8')).toBe('my own edit\n')
  expect(existsSync(join(ws, 'report.md'))).toBe(false)
  expect(readFileSync(join(ws, 'old-name.txt'), 'utf8')).toBe('keep me\n')
  expect(existsSync(join(ws, 'new-name.txt'))).toBe(false)
  expect(r.skipped.map((s) => s.why)).toEqual(['it was changed after the task'])
  const text = undoSummary(r)
  expect(text).toMatch(/put back .*notes\.md/)
  expect(text).toMatch(/removed .*report\.md.*not deleted/)
  expect(text).toMatch(/Left alone: plan\.md \(it was changed after the task\)/)
  // Removed files are kept, not deleted; and a task can't be undone twice.
  expect(readdirSync(join(root, 't-undo', 'task-1', 'removed')).some((f) => f.endsWith('report.md'))).toBe(true)
  expect(changesOf('t-undo', 'task-1')?.undone).toBe(true)
  expect(undoRun('t-undo', 'task-1')).toEqual({ restored: [], removed: [], skipped: [] })
})

test('"undo that" in chat takes back the previous task; only when the user asked', async () => {
  setUndoRoot(mkdtempSync(join(tmpdir(), 'sb-undo-root-')))
  const ws = mkdtempSync(join(tmpdir(), 'sb-undo-ws-'))
  const db = new Db(':memory:')
  const space = db.createSpace('Bot', '#000')
  const th = db.createThread(space.id, 'auto', null)
  const t = Object.fromEntries(fileTools(() => ws, mkdtempSync(join(tmpdir(), 'sb-docs-'))).map((x) => [x.name, x]))
  const undo = undoTool(db)
  const first = db.insertMessage({ threadId: th.id, role: 'user', kind: 'normal', status: 'done', content: 'Write me a packing list' })
  beginRun(th.id, first.id)
  await t.file_write.run({ path: 'packing.md', content: '- socks\n' }, ctxFor(th.id))
  expect(existsSync(join(ws, 'packing.md'))).toBe(true)

  // A page or a different request can't make it undo.
  const other = db.insertMessage({ threadId: th.id, role: 'user', kind: 'normal', status: 'done', content: 'Thanks, what is the weather?' })
  beginRun(th.id, other.id)
  await expect(undo.run({}, ctxFor(th.id))).rejects.toThrow(/Only undo when the user asks/)

  const ask = db.insertMessage({ threadId: th.id, role: 'user', kind: 'normal', status: 'done', content: 'Actually undo that, put it back' })
  beginRun(th.id, ask.id)
  const r = await undo.run({}, ctxFor(th.id))
  expect(r.text).toMatch(/Undone: removed packing\.md/)
  expect(existsSync(join(ws, 'packing.md'))).toBe(false)
  expect((await undo.run({}, ctxFor(th.id))).text).toMatch(/no file changes from an earlier task/)
})
