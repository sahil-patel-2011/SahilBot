import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { permanentDeletes, shellTool } from '../../src/main/agent/tools/shell'
import { noteOwned } from '../../src/main/agent/tools/freshness'

// Auto deletes without a card because deletes go to the Trash and Undo takes them back. rm can't be taken back, so a
// command that would delete the user's files for good isn't run: the bot is told to use file_manage delete. Build
// output, caches, temp files and files the chat made itself can still go with rm. No approval card either way.

test('which deletes are for good: the user\'s files, not build output, temp files or the chat\'s own', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sb-rm-'))
  expect(permanentDeletes('rm ~/Documents/a.txt', cwd)).toEqual(['~/Documents/a.txt'])
  expect(permanentDeletes('rm -rf ~/Documents/old', cwd)).toEqual(['~/Documents/old'])
  expect(permanentDeletes('cd ~/Desktop && rm -f notes.txt report.pdf', cwd)).toEqual(['notes.txt', 'report.pdf'])
  expect(permanentDeletes('find ~/Downloads -name "*.jpg" -delete', cwd)).toEqual(['~/Downloads'])
  expect(permanentDeletes('bash -c "rm -r ~/Pictures/trip"', cwd)).toEqual(['~/Pictures/trip'])
  expect(permanentDeletes('unlink ~/a.txt', cwd)).toEqual(['~/a.txt'])
  // Fine with rm: build output, caches, temp files, empty folders, git rm, the Trash.
  expect(permanentDeletes('rm -rf node_modules dist build .cache coverage __pycache__', cwd)).toEqual([])
  expect(permanentDeletes(`rm -rf ${tmpdir()}/sb-scratch /tmp/x.log`, cwd)).toEqual([])
  expect(permanentDeletes('rm -f *.pyc && find . -name "*.pyc" -delete', cwd)).toEqual([])
  expect(permanentDeletes('rmdir empty && git rm old.ts && trash old.txt', cwd)).toEqual([])
  expect(permanentDeletes('ls -la && echo rm', cwd)).toEqual([])
  // A file this chat made itself.
  const own = join(homedir(), 'sb-test-own-file.txt')
  expect(permanentDeletes(`rm ${own}`, cwd, (p) => p === own)).toEqual([])
})

test('run_command refuses a permanent delete of the user\'s files (nothing runs) and points to file_manage delete', async () => {
  // Not under the temp folder (temp files may go with rm).
  const ws = mkdtempSync(join(homedir(), '.sb-rm-ws-'))
  try {
  writeFileSync(join(ws, 'a.txt'), 'mine')
  const tool = shellTool({ workspace: () => ws })
  const ctx = { threadId: 't-rm', workspaceDir: ws, state: { roots: [], loaded: [], alwaysAllow: [], todos: [] }, signal: new AbortController().signal } as never
  await expect(tool.run({ command: 'rm a.txt' }, ctx)).rejects.toThrow(/Nothing was run.*a\.txt for good.*file_manage delete.*Trash.*Undo/)
  expect(existsSync(join(ws, 'a.txt'))).toBe(true)
  // The chat's own file is fine to rm (checked before anything runs).
  noteOwned('t-rm', join(ws, 'a.txt'))
  expect(permanentDeletes('rm a.txt', ws, (p) => p === join(ws, 'a.txt'))).toEqual([])
  // The description steers deletes away from rm.
  expect(tool.description).toMatch(/Never delete files of the user with rm: use file_manage delete/)
  } finally { rmSync(ws, { recursive: true, force: true }) }
})
