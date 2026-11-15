import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cursorTool } from '../../src/main/agent/tools/apps'
import { briefGaps, composeCursorPrompt, diffFiles, formatReview, reviewCursorChange } from '../../src/main/code/cursor'

// The Cursor hand-off: what a brief is missing before it goes out, and the automatic review when Cursor reports done.

afterEach(() => { vi.unstubAllGlobals(); delete process.env.CURSOR_AGENT_PATH })

const DIFF = `diff --git a/src/export/rows.ts b/src/export/rows.ts
--- a/src/export/rows.ts
+++ b/src/export/rows.ts
@@ -1,3 +1,4 @@
-export const rows = (all) => all.filter((r) => !r.archived)
+export const rows = (all, archived = false) => all.filter((r) => archived || !r.archived)
+console.log('rows', all.length)
+// TODO handle pagination
diff --git a/src/db/schema.sql b/src/db/schema.sql
--- a/src/db/schema.sql
+++ b/src/db/schema.sql
@@ -1 +1 @@
-create table t (id int);
+create table t (id bigint);
diff --git a/src/export/rows.test.ts b/src/export/rows.test.ts
--- a/src/export/rows.test.ts
+++ b/src/export/rows.test.ts
@@ -1,4 +1,2 @@
-test('drops archived rows', () => { expect(rows([{ archived: true }])).toEqual([]) })
-test('keeps live rows', () => { expect(rows([{}])).toHaveLength(1) })
+test.skip('keeps live rows', () => { expect(rows([{}])).toHaveLength(1) })
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-  "dependencies": {}
+  "dependencies": { "left-pad": "^1.3.0" }
`

describe('brief gaps', () => {
  test('a thin brief is told exactly what to add', () => {
    const g = briefGaps({ goal: 'fix it' }).join('\n')
    expect(g).toMatch(/goal is vague/)
    expect(g).toMatch(/No acceptance criteria/)
    expect(g).toMatch(/Cursor starts blind/)
    expect(g).toMatch(/No commands to verify/)
    expect(g).toMatch(/paste the exact error output/)
    expect(briefGaps({ goal: 'Add a --json flag to export that prints one JSON object per row', context: 'export is in src/cli/export.ts', files: ['src/cli/export.ts'], acceptance: ['one object per line'] }, { projectChecks: true })).toEqual([])
  })
  test('several tasks in one goal, and working notes left out of the context', () => {
    const goal = 'Do all of this:\n1. add login\n2. add signup\n3. add password reset\n4. add 2FA'
    expect(briefGaps({ goal, acceptance: ['x'], files: ['a'] }, { projectChecks: true }).join('\n')).toMatch(/split it into Cursor-sized pieces/)
    expect(briefGaps({ goal: 'Add a dark mode toggle to the settings page', acceptance: ['x'], files: ['a'] }, { projectChecks: true, notes: '## Constraints\n- No new deps' }).join('\n')).toMatch(/working notes/)
  })
})

describe('automatic review', () => {
  test('flags protected paths, removed and skipped tests, debug output, TODOs, new deps and scope; lists the criteria', () => {
    expect(diffFiles(DIFF)).toEqual(['src/export/rows.ts', 'src/db/schema.sql', 'src/export/rows.test.ts', 'package.json'])
    const r = reviewCursorChange({ brief: { goal: 'Add an include-archived option to rows()', files: ['src/export/rows.ts'], dontChange: ['src/db/'], acceptance: ['Default output unchanged', 'A test covers archived=true'] }, diff: DIFF, checksOk: false, checksRun: true })
    const f = r.findings.join('\n')
    expect(f).toMatch(/Checks failed/)
    expect(f).toMatch(/not to touch: src\/db\/schema\.sql/)
    expect(f).toMatch(/Removes 1 test/)
    expect(f).toMatch(/Skips or focuses tests/)
    expect(f).toMatch(/dependency manifests \(package\.json\)/)
    expect(f).toMatch(/Outside the files named in the brief: src\/db\/schema\.sql, package\.json/)
    expect(f).toMatch(/debug output \(1 line/)
    expect(f).toMatch(/1 TODO/)
    expect(r.checklist[0]).toBe('[ ] Default output unchanged: point to the evidence (a test, a command\'s output, or the lines in the diff).')
    expect(r.followup).toMatch(/^Fix these problems in your last change, keeping the original goal \("Add an include-archived option to rows\(\)"\)/)
    const text = formatReview(r, 'cursor(action="agent", resume: true)')
    expect(text).toMatch(/## Automatic review[\s\S]*Before you report done:[\s\S]*Suggested follow-up \(cursor\(action="agent", resume: true\)\)/)
  })
  test('a clean, tested diff gets no findings; no diff at all says so', () => {
    const clean = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\ndiff --git a/src/a.test.ts b/src/a.test.ts\n--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@ -1 +1,2 @@\n test('a', () => expect(a).toBe(1))\n+test('a is 2', () => expect(a).toBe(2))\n`
    const r = reviewCursorChange({ brief: { goal: 'Make a 2', files: ['src/a.ts'] }, diff: clean, checksOk: true, checksRun: true })
    expect(r.findings).toEqual([])
    expect(r.followup).toBeUndefined()
    expect(reviewCursorChange({ diff: '' }).findings[0]).toMatch(/^No changes/)
  })
})

describe('follow-ups keep the original goal', () => {
  test('composeCursorPrompt restates it, with its criteria', () => {
    const p = composeCursorPrompt({ goal: 'Fix: the toggle does not persist', mode: 'followup', original: { goal: 'Add dark mode', acceptance: ['toggle persists across restarts'] } })
    expect(p).toMatch(/^# Follow-up\nFix: the toggle does not persist\n\n# Original goal \(still applies; don't undo it\)\nAdd dark mode\n- toggle persists across restarts/)
    expect(p).toContain("Never delete, skip or weaken tests or type checks")
    expect(p).toMatch(/stop and say exactly what you need instead of guessing/)
  })
  test('a cloud follow-up after a launch shows the original goal in its approval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agent: { id: 'bc-9' }, run: { status: 'CREATING' } }), { status: 200 })))
    const t = cursorTool(() => 'key', () => tmpdir())
    const ctx = { state: { roots: [], loaded: [], alwaysAllow: [], todos: [] }, workspaceDir: tmpdir(), signal: new AbortController().signal } as never
    await t.run({ action: 'cloud_launch', repo: 'https://github.com/me/app', goal: 'Add dark mode to settings', acceptance: ['toggle persists'] }, ctx)
    expect(t.describe!({ action: 'cloud_followup', id: 'bc-9', goal: 'Fix: toggle resets on reload' })).toMatch(/# Follow-up\nFix: toggle resets on reload\n\n# Original goal[^\n]*\nAdd dark mode to settings\n- toggle persists/)
  })
})

describe('cursor tool', () => {
  test('prompt lists the gaps and surfaces the working notes', async () => {
    const t = cursorTool(() => undefined, () => tmpdir())
    const ctx = { state: { roots: [], loaded: [], alwaysAllow: [], todos: [], taskNotes: { entries: [{ section: 'Constraints', text: 'Never touch the billing module', by: 'user', at: 1 }] } }, workspaceDir: tmpdir(), signal: new AbortController().signal } as never
    const r = await t.run({ action: 'prompt', goal: 'fix it' }, ctx)
    expect(r.text).toMatch(/Improve the brief first[\s\S]*No acceptance criteria/)
    expect(r.text).toMatch(/Your working notes[\s\S]*Never touch the billing module/)
  })
  test('the local agent result ends with the automatic review against the brief', async () => {
    const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cur-rv-')))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node ok.js' } }))
    writeFileSync(join(root, 'ok.js'), 'process.exit(0)\n')
    writeFileSync(join(root, 'a.txt'), 'one\n')
    g(root, 'init', '-q', '-b', 'main'); g(root, 'config', 'user.email', 't@example.com'); g(root, 'config', 'user.name', 'T'); g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', 'init')
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'bin-')))
    const fake = join(bin, 'cursor-agent')
    writeFileSync(fake, `#!/usr/bin/env node
require('fs').writeFileSync('a.txt', 'two\\n')
require('fs').writeFileSync('debug.js', "console.log('x')\\n")
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's' }))
`)
    chmodSync(fake, 0o755)
    process.env.CURSOR_AGENT_PATH = fake
    const t = cursorTool(() => undefined, () => root)
    const ctx = { state: { roots: [root], loaded: [], alwaysAllow: [], todos: [] }, workspaceDir: root, signal: new AbortController().signal } as never
    const r = await t.run({ action: 'agent', folder: root, goal: 'Make a.txt say two', files: ['a.txt'], acceptance: ['a.txt contains "two"'] }, ctx)
    expect(r.text).toMatch(/## Automatic review/)
    expect(r.text).toMatch(/\[ \] a\.txt contains "two": point to the evidence/)
    expect(r.text).toMatch(/Checks pass \(above\)/)
  })
})
