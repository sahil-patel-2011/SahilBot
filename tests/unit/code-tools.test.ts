import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { codeEffect, codeTool, gitEffect, gitTool } from '../../src/main/agent/tools/code'
import { lineSecret, scanDiffForSecrets } from '../../src/main/code/git'

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-')))
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), c)
  }
  return root
}
const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
function repo(files: Record<string, string>): string {
  const root = tree(files)
  g(root, 'init', '-q', '-b', 'main')
  g(root, 'config', 'user.email', 'test@example.com')
  g(root, 'config', 'user.name', 'Test')
  g(root, 'config', 'commit.gpgsign', 'false')
  g(root, 'add', '-A')
  g(root, 'commit', '-q', '-m', 'init')
  return root
}
const ctxFor = (root: string, ws = tree({})) => ({ state: { roots: [root], loaded: [], alwaysAllow: [], todos: [] }, workspaceDir: ws, signal: new AbortController().signal }) as never

const SRC = { 'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node run-tests.js' } }), 'src/math.ts': 'export function add(a: number, b: number) {\n  return a - b\n}\n', 'README.md': '# demo\n' }

describe('code tool', () => {
  test('project, search, symbols and numbered read', async () => {
    const root = repo(SRC)
    const code = codeTool({ getWorkspace: () => root })
    const ctx = ctxFor(root)
    expect((await code.run({ action: 'project' }, ctx)).text).toMatch(/Kind: node[\s\S]*Tests: npm test[\s\S]*## main[\s\S]*Recent commits:\n\w+ init/)
    expect((await code.run({ action: 'search', pattern: 'return a' }, ctx)).text).toMatch(/src\/math\.ts\n {2}2: {3}return a - b/)
    expect((await code.run({ action: 'symbols', name: 'add' }, ctx)).text).toMatch(/src\/math\.ts:1 {2}function add/)
    const r = await code.run({ action: 'read', path: 'src/math.ts', start: 2, end: 2 }, ctx)
    expect(r.text).toBe('src/math.ts\n2│   return a - b\n[lines 2-2 of 3; read more with start=3]')
  })
  test('edit shows a diff, keeps a backup, and refuses ambiguous or missing text', async () => {
    const root = repo(SRC)
    const ws = tree({})
    const code = codeTool({ getWorkspace: () => ws })
    const ctx = ctxFor(root, ws)
    const r = await code.run({ action: 'edit', path: 'src/math.ts', old_string: '  return a - b', new_string: '  return a + b' }, ctx)
    expect(r.text).toMatch(/Edited .*math\.ts \(1 replacement, \+1 −1\)\n--- a\/src\/math\.ts\n\+\+\+ b\/src\/math\.ts\n@@ -1,3 \+1,3 @@\n export function add[\s\S]*-  return a - b\n\+  return a \+ b/)
    expect(readFileSync(join(root, 'src/math.ts'), 'utf8')).toContain('a + b')
    expect(existsSync(join(ws, '.foreman', 'backups'))).toBe(true)
    await expect(code.run({ action: 'edit', path: 'src/math.ts', old_string: 'nope', new_string: 'x' }, ctx)).rejects.toThrow(/not found/)
    writeFileSync(join(root, 'dup.ts'), 'x\nx\n')
    await expect(code.run({ action: 'edit', path: 'dup.ts', old_string: 'x', new_string: 'y' }, ctx)).rejects.toThrow(/occurs 2 times/)
    // Several edits are all-or-nothing.
    await expect(code.run({ action: 'edit', path: 'dup.ts', edits: [{ old_string: 'x\nx', new_string: 'z\nx' }, { old_string: 'missing', new_string: 'q' }] }, ctx)).rejects.toThrow(/Edit 2 of 2[\s\S]*Nothing was changed/)
    expect(readFileSync(join(root, 'dup.ts'), 'utf8')).toBe('x\nx\n')
  })
  test('paths cannot leave the attached folders', async () => {
    const root = repo(SRC)
    const code = codeTool({ getWorkspace: () => root })
    await expect(code.run({ action: 'read', path: '../../etc/passwd' }, ctxFor(root))).rejects.toThrow(/outside/)
    await expect(code.run({ action: 'edit', path: '/etc/hosts', old_string: 'a', new_string: 'b' }, ctxFor(root))).rejects.toThrow(/outside/)
  })
  test('apply_patch: preview, all-or-nothing, add/update/move/delete', async () => {
    const root = repo({ ...SRC, 'old.txt': 'bye\n' })
    const trashed: string[] = []
    const code = codeTool({ getWorkspace: () => root, trash: async (p) => { trashed.push(p) } })
    const ctx = ctxFor(root)
    const patch = `*** Begin Patch
*** Update File: src/math.ts
*** Move to: src/ops.ts
@@ export function add
-  return a - b
+  return a + b
*** Add File: src/index.ts
+export * from './ops'
*** Delete File: old.txt
*** End Patch`
    expect(codeEffect({ action: 'apply_patch', patch })).toBe('destructive')
    expect(code.hardStop!({ action: 'apply_patch', patch })).toMatch(/deleting old\.txt/)
    expect(codeEffect({ action: 'apply_patch', patch, dry_run: true })).toBe('read')
    const preview = await code.run({ action: 'apply_patch', patch, dry_run: true }, ctx)
    expect(preview.text).toMatch(/nothing written[\s\S]*R src\/math\.ts → src\/ops\.ts\nA src\/index\.ts\nD old\.txt/)
    expect(existsSync(join(root, 'src/index.ts'))).toBe(false)
    // One bad hunk: nothing is written.
    const bad = patch.replace('-  return a - b', '-  return a * b')
    await expect(code.run({ action: 'apply_patch', patch: bad }, ctx)).rejects.toThrow(/did not apply/)
    expect(existsSync(join(root, 'src/index.ts'))).toBe(false)
    const done = await code.run({ action: 'apply_patch', patch }, ctx)
    expect(done.text).toMatch(/Applied the patch \(\+2 −2\)/)
    expect(readFileSync(join(root, 'src/ops.ts'), 'utf8')).toContain('return a + b')
    expect(existsSync(join(root, 'src/math.ts'))).toBe(false)
    expect(readFileSync(join(root, 'src/index.ts'), 'utf8')).toBe("export * from './ops'\n")
    expect(trashed).toEqual([join(root, 'old.txt')])
  })
  test('run_tests parses failures from the project command', async () => {
    const root = repo({ ...SRC, 'run-tests.js': "console.log('FAILED tests/test_math.py::test_add - assert 3 == 4');process.exit(1)" })
    const code = codeTool({ getWorkspace: () => root })
    const r = await code.run({ action: 'run_tests', command: 'node run-tests.js', timeout: 30 }, ctxFor(root))
    expect(r.display).toMatch(/tests failed/)
    expect(r.text).toMatch(/Failures:\n1\. tests\/test_math\.py — tests\/test_math\.py::test_add: assert 3 == 4/)
    await expect(code.run({ action: 'lint' }, ctxFor(root))).rejects.toThrow(/No lint setup found/)
  })
  test('custom commands are classified like run_command', () => {
    expect(codeEffect({ action: 'run_tests' })).toBe('write_local')
    expect(codeEffect({ action: 'run_tests', command: 'npm install && npm test' })).toBe('write_external')
    expect(codeEffect({ action: 'build', command: 'rm -rf dist && npm run build' })).toBe('destructive')
    expect(codeTool({ getWorkspace: () => '/' }).hardStop!({ action: 'build', command: 'rm -rf dist' })).toMatch(/deletes/)
    expect(codeEffect({ action: 'search', pattern: 'x' })).toBe('read')
  })
})

describe('secret scan', () => {
  test('flags keys, tokens, passwords and secret files', () => {
    expect(lineSecret('const key = "sk-proj-abcdefghijklmnopqrstuvwx"')?.why).toMatch(/API key/)
    expect(lineSecret('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')?.why).toMatch(/AWS_SECRET_ACCESS_KEY/)
    expect(lineSecret('db = "postgres://admin:hunter2pass@db.example.com/x"')?.why).toMatch(/URL/)
    expect(lineSecret('password = "correct-horse-battery"')?.why).toMatch(/hard-coded password/)
    expect(lineSecret('-----BEGIN RSA PRIVATE KEY-----')?.why).toMatch(/private key/)
  })
  test('ordinary code is not flagged', () => {
    for (const l of ['const token = getToken()', 'password: string', 'API_KEY=${API_KEY}', 'API_KEY=your_api_key_here', 'const sha = "3f786850e387550fdab836ed7e6dc881de23001b"', 'export function readConfigurationFromEnvironment2024()', 'id: "123e4567-e89b-12d3-a456-426614174000"', 'secret: process.env.SECRET']) {
      expect(lineSecret(l), l).toBeNull()
    }
  })
  test('scans only added lines, skips lockfiles, reports line numbers', () => {
    const diff = 'diff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1,2 @@\n+DEBUG=1\n+STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234\ndiff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-x\n+"integrity": "sha512-AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789=="\n'
    const f = scanDiffForSecrets(diff)
    expect(f.map((x) => `${x.file}:${x.line ?? ''}`)).toEqual(['.env:', '.env:2'])
    expect(f[1].preview).not.toContain('abcdefghijklmnop')
  })
})

describe('git tool', () => {
  test('effects: reads are free, push and PR reach outside', () => {
    expect(gitEffect({ action: 'status' })).toBe('read')
    expect(gitEffect({ action: 'branch' })).toBe('read')
    expect(gitEffect({ action: 'branch', name: 'x' })).toBe('write_local')
    expect(gitEffect({ action: 'commit', message: 'm' })).toBe('write_local')
    expect(gitEffect({ action: 'push' })).toBe('write_external')
    expect(gitEffect({ action: 'pr', title: 't', body: 'b' })).toBe('write_external')
    expect(gitTool().hardStop!({ action: 'commit', message: 'm', allow_flagged: true })).toMatch(/secret/)
    expect(gitTool().consequential!({ action: 'push' }, { threadId: 't' })).toBe(true)
  })
  test('status, branch, diff, commit, log, stash and push to a local remote', async () => {
    const root = repo(SRC)
    const gt = gitTool()
    const ctx = ctxFor(root)
    expect((await gt.run({ action: 'status' }, ctx)).text).toMatch(/## main[\s\S]*Working tree clean/)
    expect((await gt.run({ action: 'branch', name: 'fix/add' }, ctx)).text).toMatch(/switched to fix\/add/)
    await expect(gt.run({ action: 'branch', name: 'bad name' }, ctx)).rejects.toThrow(/not a valid branch name/)
    writeFileSync(join(root, 'src/math.ts'), SRC['src/math.ts'].replace('a - b', 'a + b'))
    writeFileSync(join(root, 'notes.md'), 'new\n')
    const diff = (await gt.run({ action: 'diff' }, ctx)).text
    expect(diff).toMatch(/# Not staged[\s\S]*\+  return a \+ b[\s\S]*# Untracked \(not in the diff\)\nnotes\.md/)
    await expect(gt.run({ action: 'commit', message: 'x' }, ctx)).rejects.toThrow(/Nothing is staged/)
    expect(gt.describe!({ action: 'commit', message: 'Fix add' })).toMatch(/Commit the staged changes: "Fix add"/)
    const c = await gt.run({ action: 'commit', message: 'Fix add\n\nIt subtracted.', paths: ['src/math.ts'] }, ctx)
    expect(c.text).toMatch(/Committed \w+ Fix add on fix\/add:\n src\/math\.ts \| 2/)
    expect((await gt.run({ action: 'log', n: 2 }, ctx)).text).toMatch(/Fix add[\s\S]*init/)
    // Secrets block the commit and nothing is committed.
    writeFileSync(join(root, 'config.ts'), 'export const key = "sk-proj-abcdefghijklmnopqrstuvwx"\n')
    await gt.run({ action: 'add', paths: ['config.ts'] }, ctx)
    await expect(gt.run({ action: 'commit', message: 'Add config' }, ctx)).rejects.toThrow(/look like they contain secrets[\s\S]*config\.ts:1/)
    expect(g(root, 'log', '-1', '--format=%s').trim()).toBe('Fix add')
    // Stash keeps work safe; switching branches never forces.
    expect((await gt.run({ action: 'stash', op: 'push', include_untracked: true, message: 'wip' }, ctx)).text).toMatch(/Saved working directory/)
    expect((await gt.run({ action: 'stash', op: 'list' }, ctx)).text).toMatch(/wip/)
    expect((await gt.run({ action: 'checkout', name: 'main' }, ctx)).text).toMatch(/Switched to main/)
    await gt.run({ action: 'checkout', name: 'fix/add' }, ctx)
    await gt.run({ action: 'stash', op: 'pop' }, ctx)
    expect(existsSync(join(root, 'config.ts'))).toBe(true)
    // Push to a bare repo on disk (no network).
    const remote = realpathSync(mkdtempSync(join(tmpdir(), 'remote-')))
    g(remote, 'init', '-q', '--bare')
    g(root, 'remote', 'add', 'origin', remote)
    expect((await gt.run({ action: 'push' }, ctx)).text).toMatch(/Pushed fix\/add to origin/)
    expect(g(remote, 'log', '-1', '--format=%s', 'fix/add').trim()).toBe('Fix add')
    await expect(gt.run({ action: 'push', remote: 'upstream' }, ctx)).rejects.toThrow(/No remote named "upstream"/)
  })
  test('outside a repository it says so', async () => {
    const dir = tree({ 'a.txt': 'x' })
    await expect(gitTool().run({ action: 'status' }, ctxFor(dir))).rejects.toThrow(/not inside a git repository/)
  })
})
