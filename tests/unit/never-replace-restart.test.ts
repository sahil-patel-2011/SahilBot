import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: async () => undefined } }))

// After an app restart the in-memory record of what the chat read and wrote is gone; only the undo journal remains.
// A file the chat made is still its own only while it is exactly what the chat wrote (FFA-02: "even to restore").

const ctxFor = (threadId: string) => ({ threadId, state: { roots: [], loaded: [], alwaysAllow: [], todos: [] } }) as never
const said = 'Write a Python script rename_photos.py that renames photos by date.'

async function app(ws: string, root: string, run: string) {
  vi.resetModules()
  const { fileTools } = await import('../../src/main/agent/tools/files')
  const { beginRun, setUndoRoot } = await import('../../src/main/agent/undo-journal')
  setUndoRoot(root)
  beginRun('t-restart', run)
  return Object.fromEntries(fileTools(() => ws, ws, { userText: () => said }).map((x) => [x.name, x]))
}

test('after a restart, a file the chat made and someone else then changed is not replaced', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'sb-restart-'))
  const root = mkdtempSync(join(tmpdir(), 'sb-undo-'))
  let t = await app(ws, root, 'task-1')
  await t.file_write.run({ path: 'rename_photos.py', content: 'print("mine")\n' }, ctxFor('t-restart'))
  writeFileSync(join(ws, 'rename_photos.py'), 'print("GROK VERSION")\n')
  t = await app(ws, root, 'task-2')
  const r = await t.file_write.run({ path: 'rename_photos.py', content: 'print("mine again")\n' }, ctxFor('t-restart'))
  expect(readFileSync(join(ws, 'rename_photos.py'), 'utf8')).toBe('print("GROK VERSION")\n')
  expect(readFileSync(join(ws, 'rename_photos (2).py'), 'utf8')).toBe('print("mine again")\n')
  expect(r.display).toBe('created rename_photos (2).py')
})

test('after a restart, a file the chat made and nobody changed is still rebuilt in place', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'sb-restart-'))
  const root = mkdtempSync(join(tmpdir(), 'sb-undo-'))
  let t = await app(ws, root, 'task-1')
  await t.file_write.run({ path: 'rename_photos.py', content: 'print("v1")\n' }, ctxFor('t-restart'))
  t = await app(ws, root, 'task-2')
  await t.file_write.run({ path: 'rename_photos.py', content: 'print("v2")\n' }, ctxFor('t-restart'))
  expect(readFileSync(join(ws, 'rename_photos.py'), 'utf8')).toBe('print("v2")\n')
  expect(existsSync(join(ws, 'rename_photos (2).py'))).toBe(false)
})
