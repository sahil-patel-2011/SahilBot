import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { overwriteTargets, permanentDeletes, shellTool } from '../../src/main/agent/tools/shell'
import { noteOwned, noteSeen, staleReason } from '../../src/main/agent/tools/freshness'
import { beginRun } from '../../src/main/agent/undo-journal'

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

const ctxFor = (threadId: string, ws: string) => ({ threadId, workspaceDir: ws, sandbox: false, state: { roots: [], loaded: [], alwaysAllow: [], todos: [] }, signal: new AbortController().signal }) as never

test('rm of a test folder a command made during this task is fine; one with a file moved in from before is not', async () => {
  const ws = mkdtempSync(join(homedir(), '.sb-rm-task-'))
  try {
    writeFileSync(join(ws, 'old.jpg'), 'the user\'s photo')
    await new Promise((r) => setTimeout(r, 300))
    beginRun('t-rm-task', 'task-rm')
    const tool = shellTool({ workspace: () => ws })
    await tool.run({ command: 'mkdir test_photos && touch test_photos/a.jpg test_photos/b.jpg' }, ctxFor('t-rm-task', ws))
    await tool.run({ command: 'rm -rf test_photos' }, ctxFor('t-rm-task', ws))
    expect(existsSync(join(ws, 'test_photos'))).toBe(false)
    // The user's own file is still refused, and the message names both ways a file counts as made here.
    await expect(tool.run({ command: 'rm old.jpg' }, ctxFor('t-rm-task', ws))).rejects.toThrow(/files you made in this chat with the file tools or during this task/)
    mkdirSync(join(ws, 'mixed'))
    await tool.run({ command: 'mv old.jpg mixed/' }, ctxFor('t-rm-task', ws))
    await expect(tool.run({ command: 'rm -rf mixed' }, ctxFor('t-rm-task', ws))).rejects.toThrow(/Nothing was run/)
    expect(existsSync(join(ws, 'mixed', 'old.jpg'))).toBe(true)
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('which files a command writes over: >, >|, &>, cp/mv/tee/sed -i/curl -o; not >>, cp -n, /dev/null or heredoc text', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sb-over-'))
  mkdirSync(join(cwd, 'dir'))
  const at = (p: string) => join(cwd, p)
  expect(overwriteTargets('echo hi > existing.py', cwd)).toEqual([at('existing.py')])
  expect(overwriteTargets('cat >| a.txt && ls &> log.out', cwd)).toEqual([at('a.txt'), at('log.out')])
  expect(overwriteTargets('cp new.py existing.py', cwd)).toEqual([at('existing.py')])
  expect(overwriteTargets('mv draft.py notes.md dir', cwd)).toEqual([at('dir/draft.py'), at('dir/notes.md')])
  expect(overwriteTargets('echo x | tee out.txt', cwd)).toEqual([at('out.txt')])
  expect(overwriteTargets("sed -i '' 's/a/b/' f.py && sed -i 's/a/b/' g.py && perl -pi -e 's/a/b/' h.py", cwd)).toEqual([at('f.py'), at('g.py'), at('h.py')])
  expect(overwriteTargets('curl -o page.html https://example.com', cwd)).toEqual([at('page.html')])
  expect(overwriteTargets('echo hi >> log.txt; cp -n a b; tee -a c < d; sed -i.bak s/a/b/ e; ls > /dev/null 2>&1', cwd)).toEqual([])
  expect(overwriteTargets("cat > new.py <<'EOF'\nif a > b:\n    pass\nEOF\npython3 new.py", cwd)).toEqual([at('new.py')])
  expect(overwriteTargets('bash -c "echo hi > inner.txt"', cwd)).toEqual([at('inner.txt')])
})

test('run_command never replaces a file of the user\'s (>, cp, mv, sed -i); new files, its own files and asked-for changes are fine', async () => {
  const ws = mkdtempSync(join(homedir(), '.sb-clobber-'))
  try {
    writeFileSync(join(ws, 'rename_photos.py'), 'print("the user\'s")\n')
    writeFileSync(join(ws, 'draft.py'), 'print("draft")\n')
    let said = 'Write a Python script rename_photos.py that renames photos by date.'
    const tool = shellTool({ workspace: () => ws, userText: () => said })
    const ctx = ctxFor('t-clobber', ws)
    await new Promise((r) => setTimeout(r, 300))
    beginRun('t-clobber', 'task-clobber')
    for (const command of ["cat > rename_photos.py <<'EOF'\nprint('mine')\nEOF", 'cp draft.py rename_photos.py', 'mv draft.py rename_photos.py', "sed -i 's/user/bot/' rename_photos.py"]) {
      await expect(tool.run({ command }, ctx)).rejects.toThrow(/Nothing was run: this would replace rename_photos\.py, which is the user's.*file_write.*rename_photos \(2\)\.py/)
    }
    expect(readFileSync(join(ws, 'rename_photos.py'), 'utf8')).toBe('print("the user\'s")\n')
    expect(existsSync(join(ws, 'draft.py'))).toBe(true)
    // A new file, output thrown away, and appending are fine; a file the command made is the chat's own afterwards.
    await tool.run({ command: 'echo one > out.txt && ls > /dev/null && echo two >> draft.py' }, ctx)
    await tool.run({ command: 'echo three > out.txt' }, ctx)
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('three\n')
    // A file this chat wrote with the file tools.
    writeFileSync(join(ws, 'mine.py'), 'v1\n')
    noteOwned('t-clobber', join(ws, 'mine.py'))
    await tool.run({ command: 'echo v2 > mine.py' }, ctx)
    expect(readFileSync(join(ws, 'mine.py'), 'utf8')).toBe('v2\n')
    // The user asked to change that file.
    said = 'Fix the date bug in rename_photos.py'
    await tool.run({ command: "sed -i 's/user/fixed/' rename_photos.py" }, ctx)
    expect(readFileSync(join(ws, 'rename_photos.py'), 'utf8')).toContain('fixed')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('$HOME and ${HOME} paths count like ~ (writes and cd), and "| xargs rm" is a delete', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sb-over-'))
  const dl = join(homedir(), 'Downloads', 'rename_photos.py')
  expect(overwriteTargets(`cat > "$HOME/Downloads/rename_photos.py" <<'EOF'\nprint(1)\nEOF`, cwd)).toEqual([dl])
  expect(overwriteTargets('cp new.py "${HOME}/Downloads/rename_photos.py"', cwd)).toEqual([dl])
  expect(overwriteTargets('cp new.py ${HOME}/Downloads/rename_photos.py', cwd)).toEqual([dl])
  expect(overwriteTargets(`cd "$HOME/Downloads" && cat > rename_photos.py <<EOF\nx\nEOF`, cwd)).toEqual([dl])
  expect(permanentDeletes('cd "$HOME/Desktop" && rm notes.txt', cwd)).toEqual(['notes.txt'])
  // Piped deletes: the find's folder (unless it picks only build output), or "the files piped" from anything else.
  expect(permanentDeletes("find ~/Pictures -name '*.jpg' | xargs rm", cwd)).toEqual(['~/Pictures'])
  expect(permanentDeletes('find . -name "*.txt" -print0 | xargs -0 rm -f', join(homedir(), 'Documents'))).toEqual(['.'])
  expect(permanentDeletes('ls | xargs rm', cwd)).toEqual(['the files piped to xargs rm'])
  expect(permanentDeletes("find . -name '*.pyc' | xargs rm", cwd)).toEqual([])
  expect(permanentDeletes(`find ${tmpdir()}/sb-x -name '*.jpg' | xargs rm`, cwd)).toEqual([])
  expect(permanentDeletes('ls | xargs echo && find . -name "*.jpg" | xargs ls -l', cwd)).toEqual([])
})

test('run_command refuses writing over the user\'s file through $HOME, and a piped rm of their files', async () => {
  const ws = mkdtempSync(join(homedir(), '.sb-clobber-home-'))
  try {
    writeFileSync(join(ws, 'x.py'), 'mine\n')
    const tool = shellTool({ workspace: () => ws, userText: () => 'Write a script x.py that prints hi.' })
    const ctx = ctxFor('t-home', ws)
    await new Promise((r) => setTimeout(r, 300))
    beginRun('t-home', 'task-home')
    const rel = ws.slice(homedir().length + 1)
    for (const command of [`cat > "$HOME/${rel}/x.py" <<EOF\nprint('hi')\nEOF`, `cp x.py "\${HOME}/${rel}/x.py"`, `cd "$HOME/${rel}" && cat > x.py <<EOF\nhi\nEOF`]) {
      await expect(tool.run({ command }, ctx)).rejects.toThrow(/Nothing was run: this would replace x\.py/)
    }
    await expect(tool.run({ command: `find "$HOME/${rel}" -name '*.py' | xargs rm` }, ctx)).rejects.toThrow(/Nothing was run.*for good/)
    expect(readFileSync(join(ws, 'x.py'), 'utf8')).toBe('mine\n')
    // A new name through $HOME is fine.
    await tool.run({ command: `echo hi > "$HOME/${rel}/new.py"` }, ctx)
    expect(readFileSync(join(ws, 'new.py'), 'utf8')).toBe('hi\n')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('after the chat\'s own command changes its own file (sed -i), the next file_write or file_edit is not "edited outside"', async () => {
  const ws = mkdtempSync(join(homedir(), '.sb-own-cmd-'))
  try {
    const f = join(ws, 'script.py')
    writeFileSync(f, 'a = 1\n')
    noteOwned('t-own-cmd', f)
    noteSeen('t-own-cmd', f)
    const tool = shellTool({ workspace: () => ws, userText: () => 'Write script.py' })
    await new Promise((r) => setTimeout(r, 20))
    await tool.run({ command: "sed -i.bak 's/1/2/' script.py && rm -f script.py.bak" }, ctxFor('t-own-cmd', ws))
    expect(readFileSync(f, 'utf8')).toBe('a = 2\n')
    expect(staleReason('t-own-cmd', f, 'script.py')).toBeUndefined()
    // A change by someone else still is.
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(f, 'a = 3 # theirs\n')
    expect(staleReason('t-own-cmd', f, 'script.py')).toMatch(/changed on disk/)
  } finally { rmSync(ws, { recursive: true, force: true }) }
})
