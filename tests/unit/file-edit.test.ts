import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { applyEdit, fileTools, shrinkReason } from '../../src/main/agent/tools/files'

// Agent Arena findings: without an edit tool, changing one line of a big file meant rewriting the whole file from
// a read whose middle was omitted (3,000 lines became 70); and a project's own docs/ folder was unreadable.
const ctx = { threadId: 't-edit', state: { roots: [], loaded: [], alwaysAllow: [], todos: [] } } as never
const tools = (ws: string) => Object.fromEntries(fileTools(() => ws, mkdtempSync(join(tmpdir(), 'sb-manual-'))).map((t) => [t.name, t]))

test('file_edit changes exactly the text it names, on disk, without the model seeing the whole file', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'sb-edit-'))
  const lines = Array.from({ length: 3000 }, (_, i) => `export const R${i} = ${i}`)
  lines[2399] = 'export const TAX_RATE = 0.07 // sales tax'
  writeFileSync(join(ws, 'rates.js'), lines.join('\n'))
  const t = tools(ws)
  const r = await t.file_edit.run({ path: 'rates.js', old_string: 'TAX_RATE = 0.07 //', new_string: 'TAX_RATE = 0.0725 //' }, ctx)
  expect(r.text).toMatch(/1 replacement \(line 2400\)/)
  const after = readFileSync(join(ws, 'rates.js'), 'utf8').split('\n')
  expect(after).toHaveLength(3000)
  expect(after[2399]).toBe('export const TAX_RATE = 0.0725 // sales tax')
  expect(after.filter((l, i) => l !== lines[i])).toHaveLength(1)
  // Not found, or ambiguous: refused with a reason, file untouched.
  await expect(t.file_edit.run({ path: 'rates.js', old_string: 'NOPE', new_string: 'x' }, ctx)).rejects.toThrow(/not found/)
  await expect(t.file_edit.run({ path: 'rates.js', old_string: 'export const R1', new_string: 'x' }, ctx)).rejects.toThrow(/appears \d+ times/)
  expect(applyEdit('a b a', 'a', 'c', true)).toMatchObject({ text: 'c b c', count: 2, line: 1 })
})

test('file_write refuses to replace a big file with a shortened view of it (unless replace_whole)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'sb-shrink-'))
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  writeFileSync(join(ws, 'big.txt'), big)
  // The user asked to change it (else a new file would be saved beside it: tests/unit/never-replace.test.ts).
  const t = Object.fromEntries(fileTools(() => ws, mkdtempSync(join(tmpdir(), 'sb-manual-')), { userText: () => 'Rewrite big.txt' }).map((x) => [x.name, x]))
  await t.file_read.run({ path: 'big.txt' }, ctx)
  await expect(t.file_write.run({ path: 'big.txt', content: 'line 0\nline 1\n' }, ctx)).rejects.toThrow(/delete the rest.*file_edit/)
  expect(readFileSync(join(ws, 'big.txt'), 'utf8')).toBe(big)
  await t.file_write.run({ path: 'big.txt', content: 'fresh start\n', replace_whole: true }, ctx)
  expect(readFileSync(join(ws, 'big.txt'), 'utf8')).toBe('fresh start\n')
  // Content that still carries the "Middle omitted" note is refused at any size.
  expect(shrinkReason('a.txt', 'x\n', 'head\n\n[… 9000 tokens, 3000 lines total. Middle omitted. Full result saved as id="r1". Call read_result …]\n\ntail')).toMatch(/shortened view/)
  // Small files and ordinary rewrites are untouched.
  expect(shrinkReason('a.txt', 'one\ntwo\n', 'three\n')).toBeUndefined()
})

test('a project\'s own docs/ folder is readable and writable; the app manual is the fallback', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'sb-docs-'))
  mkdirSync(join(ws, 'docs'))
  writeFileSync(join(ws, 'docs/notes.md'), '# Planning\n- Launch Dec 4\n')
  const t = tools(ws)
  expect((await t.file_read.run({ path: 'docs/notes.md' }, ctx)).text).toContain('Launch Dec 4')
  await t.file_write.run({ path: 'docs/summary.md', content: '- Launch Dec 4\n' }, ctx)
  expect(readFileSync(join(ws, 'docs/summary.md'), 'utf8')).toBe('- Launch Dec 4\n')
})
