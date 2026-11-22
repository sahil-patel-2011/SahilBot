import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fileTools } from '../../src/main/agent/tools/files'

// Stale-write protection (as in Claude Code): the agent read a file, the user edited it, then the agent tries to
// overwrite the whole file with its stale copy. The write is refused until it reads the current version.
test('an overwrite after the user changed the file is refused; after a fresh read it goes through', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'sb-stale-'))
  const file = join(ws, 'notes.md')
  writeFileSync(file, 'Meeting notes\n')
  const [read, write] = fileTools(() => ws, ws)
  const ctx = { threadId: 't-stale', state: { roots: [], loaded: [], alwaysAllow: [], todos: [] } } as never
  expect((await read.run({ path: 'notes.md' }, ctx)).text).toBe('Meeting notes\n')

  // The user adds a line in their editor (a later mtime, a different size).
  writeFileSync(file, 'Meeting notes\nUser: call Dana on Monday\n')
  utimesSync(file, new Date(), new Date(Date.now() + 2000))

  await expect(write.run({ path: 'notes.md', content: 'Meeting notes\nBudget approved\n' }, ctx)).rejects.toThrow(/changed on disk since you last read it/)
  expect(readFileSync(file, 'utf8')).toContain('call Dana')

  // Read again, write on top of the current version: fine.
  const now = (await read.run({ path: 'notes.md' }, ctx)).text
  await write.run({ path: 'notes.md', content: `${now}Budget approved\n` }, ctx)
  expect(readFileSync(file, 'utf8')).toBe('Meeting notes\nUser: call Dana on Monday\nBudget approved\n')

  // Its own consecutive writes never trip it, and a file it never read is written as before.
  await write.run({ path: 'notes.md', content: 'v2\n' }, ctx)
  await write.run({ path: 'notes.md', content: 'v3\n' }, ctx)
  writeFileSync(join(ws, 'other.md'), 'x')
  await write.run({ path: 'other.md', content: 'y' }, ctx)
  expect(readFileSync(join(ws, 'other.md'), 'utf8')).toBe('y')
})
