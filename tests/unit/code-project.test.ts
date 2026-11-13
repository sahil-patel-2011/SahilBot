import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildCommand, runCheck } from '../../src/main/code/checks'
import { detectProject, parseDiagnostics, parseTestOutput, suggestNext, testCommand } from '../../src/main/code/project'

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'proj-'))
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), c)
  }
  return root
}

describe('detectProject', () => {
  test('node with vitest, tsc script, eslint and pnpm', () => {
    const root = tree({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', build: 'vite build' }, devDependencies: { vitest: '1', eslint: '9', typescript: '5' } }), 'pnpm-lock.yaml': '', 'tsconfig.json': '{}' })
    const p = detectProject(root)
    expect(p.kinds).toEqual(['node'])
    expect(p.packageManager).toBe('pnpm')
    expect(p.test).toEqual({ command: 'pnpm test', tool: 'vitest', kind: 'test' })
    expect(p.typecheck[0].command).toBe('pnpm typecheck')
    expect(p.lint[0].tool).toBe('eslint')
    expect(p.build?.command).toBe('pnpm build')
    expect(testCommand(p.test!, 'tests/a.test.ts', 'pnpm')).toBe('pnpm test tests/a.test.ts')
    expect(testCommand({ ...p.test!, command: 'npm test' }, 'adds numbers', 'npm')).toBe("npm test -- -t 'adds numbers'")
  })
  test('the npm placeholder test script does not count', () => {
    expect(detectProject(tree({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })).test).toBeUndefined()
  })
  test('python with a venv, mypy and ruff', () => {
    const root = tree({ 'pyproject.toml': '[tool.mypy]\nstrict = true\n[tool.ruff]\nline-length = 100\n', '.venv/bin/python': '' })
    const p = detectProject(root)
    expect(p.test?.command).toBe('.venv/bin/python -m pytest -q -rfE --no-header')
    expect(testCommand(p.test!, 'test_login')).toMatch(/-k test_login$/)
    expect(testCommand(p.test!, 'tests/test_a.py::test_b')).toMatch(/ tests\/test_a\.py::test_b$/)
    expect(p.typecheck.map((c) => c.tool)).toEqual(['mypy'])
    expect(p.lint.map((c) => c.tool)).toEqual(['ruff'])
  })
  test('go, rust, gradle', () => {
    expect(testCommand(detectProject(tree({ 'go.mod': 'module x' })).test!, 'TestAdd')).toBe('go test ./... -run TestAdd')
    expect(detectProject(tree({ 'Cargo.toml': '' })).typecheck[0].command).toBe('cargo check --message-format short')
    const g = detectProject(tree({ 'build.gradle': '', gradlew: '' }))
    expect(testCommand(g.test!, 'frc.robot.ArmTest')).toBe('./gradlew test --console=plain --tests frc.robot.ArmTest')
  })
  test('lint/typecheck paths narrow eslint and ruff', () => {
    expect(buildCommand({ kind: 'lint', spec: { command: 'npx --no-install eslint . --format json', tool: 'eslint', kind: 'lint' }, path: 'src' })).toBe('npx --no-install eslint src --format json')
  })
})

describe('parsers', () => {
  const root = '/repo'
  test('tsc (both formats)', () => {
    const d = parseDiagnostics('tsc', "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n/repo/src/b.ts:9:1 - error TS2304: Cannot find name 'x'.\n", root)
    expect(d).toEqual([
      { file: 'src/a.ts', line: 3, col: 7, severity: 'error', code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
      { file: 'src/b.ts', line: 9, col: 1, severity: 'error', code: 'TS2304', message: "Cannot find name 'x'." }
    ])
  })
  test('eslint json and stylish', () => {
    const json = JSON.stringify([{ filePath: '/repo/src/a.ts', messages: [{ line: 2, column: 5, severity: 2, message: "'x' is unused", ruleId: 'no-unused-vars' }, { line: 4, column: 1, severity: 1, message: 'prefer const', ruleId: 'prefer-const' }] }])
    expect(parseDiagnostics('eslint', json, root).map((x) => `${x.file}:${x.line} ${x.severity} ${x.code}`)).toEqual(['src/a.ts:2 error no-unused-vars', 'src/a.ts:4 warning prefer-const'])
    const stylish = '\n/repo/src/b.ts\n  10:3  error  Unexpected console statement  no-console\n\n✖ 1 problem (1 error, 0 warnings)\n'
    expect(parseDiagnostics('eslint', stylish, root)).toEqual([{ file: 'src/b.ts', line: 10, col: 3, severity: 'error', message: 'Unexpected console statement', code: 'no-console' }])
  })
  test('ruff json, mypy, cargo short, go vet', () => {
    expect(parseDiagnostics('ruff', JSON.stringify([{ filename: '/repo/app.py', location: { row: 1, column: 8 }, code: 'F401', message: '`os` imported but unused' }]), root)[0]).toMatchObject({ file: 'app.py', line: 1, code: 'F401' })
    expect(parseDiagnostics('mypy', 'app.py:12: error: Incompatible return value type  [return-value]\napp.py:3: note: See docs\n', root)).toEqual([{ file: 'app.py', line: 12, col: undefined, severity: 'error', code: 'return-value', message: 'Incompatible return value type' }])
    expect(parseDiagnostics('cargo', 'src/main.rs:4:9: error[E0308]: mismatched types\nsrc/main.rs:2:5: warning: unused variable: `x`\n', root).map((x) => `${x.severity} ${x.code ?? ''}`)).toEqual(['error E0308', 'warning '])
    expect(parseDiagnostics('go', './main.go:7:2: fmt.Printf format %d has arg s of wrong type string\n', root)[0]).toMatchObject({ file: 'main.go', line: 7 })
  })
  test('vitest failures with location and message', () => {
    const out = ` ❯ tests/a.test.ts (2 tests | 1 failed) 5ms
   × math > adds 3ms

⎯⎯⎯ Failed Tests 1 ⎯⎯⎯

 FAIL  tests/a.test.ts > math > adds
AssertionError: expected 3 to be 4 // Object.is equality

 ❯ tests/a.test.ts:5:15
      3|   test('adds', () => {

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)`
    const r = parseTestOutput('vitest', out, root)
    expect(r.failures).toEqual([{ test: 'tests/a.test.ts > math > adds', file: 'tests/a.test.ts', line: 5, severity: 'error', message: 'AssertionError: expected 3 to be 4 // Object.is equality' }])
    expect(r.passed).toBe(1)
    expect(suggestNext('test', r.failures)).toMatch(/code\(action="read", path="tests\/a\.test\.ts", start=1, end=20\)[\s\S]*filter="adds"/)
  })
  test('jest failures', () => {
    const out = `FAIL src/sum.test.js
  ● sum › adds

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 3

      at Object.toBe (src/sum.test.js:4:20)

Tests:       1 failed, 2 passed, 3 total`
    const r = parseTestOutput('jest', out, root)
    expect(r.failures[0]).toMatchObject({ test: 'sum › adds', file: 'src/sum.test.js', line: 4 })
    expect(r.failures[0].message).toMatch(/toBe/)
    expect(r.failed).toBe(1)
  })
  test('pytest failures', () => {
    const out = `=================================== FAILURES ===================================
__________________________________ test_add ___________________________________

    def test_add():
>       assert add(1, 2) == 4
E       assert 3 == 4

tests/test_math.py:5: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_add - assert 3 == 4
========================= 1 failed, 3 passed in 0.05s ==========================`
    const r = parseTestOutput('pytest', out, root)
    expect(r.failures).toEqual([{ test: 'tests/test_math.py::test_add', file: 'tests/test_math.py', line: 5, severity: 'error', message: 'assert 3 == 4' }])
    expect([r.failed, r.passed]).toEqual([1, 3])
  })
  test('go, cargo and gradle failures', () => {
    expect(parseTestOutput('go', '--- FAIL: TestAdd (0.00s)\n    math_test.go:9: got 3, want 4\nFAIL\nFAIL\texample/math\t0.01s\n', root).failures[0]).toMatchObject({ test: 'TestAdd', file: 'math_test.go', line: 9, message: 'got 3, want 4' })
    const cargo = "---- tests::adds stdout ----\nthread 'tests::adds' panicked at src/lib.rs:10:9:\nassertion `left == right` failed\n  left: 3\n right: 4\n\ntest result: FAILED. 2 passed; 1 failed; 0 ignored"
    expect(parseTestOutput('cargo', cargo, root).failures[0]).toMatchObject({ test: 'tests::adds', file: 'src/lib.rs', line: 10, message: 'assertion `left == right` failed' })
    const gradle = 'ArmTest > holdsPosition() FAILED\n    org.opentest4j.AssertionFailedError: expected: <1.0> but was: <0.5>\n        at app//frc.robot.ArmTest.holdsPosition(ArmTest.java:23)\n'
    expect(parseTestOutput('gradle', gradle, root).failures[0]).toMatchObject({ file: 'ArmTest.java', line: 23, message: 'org.opentest4j.AssertionFailedError: expected: <1.0> but was: <0.5>' })
  })
})

describe('runCheck', () => {
  test('runs, streams progress and parses failures', async () => {
    const root = tree({ 'fail.js': "console.log(' FAIL  tests/x.test.ts > suite > works');console.log('AssertionError: expected 1 to be 2');console.log(' ❯ tests/x.test.ts:7:3');process.exit(1)" })
    const lines: string[] = []
    const r = await runCheck({ cwd: root, kind: 'test', spec: { command: 'node fail.js', tool: 'vitest', kind: 'test' }, timeoutMs: 30_000, progress: (l) => lines.push(l) })
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatchObject({ file: 'tests/x.test.ts', line: 7 })
    expect(r.text).toMatch(/FAILED[\s\S]*Failures:\n1\. tests\/x\.test\.ts:7 — tests\/x\.test\.ts > suite > works: AssertionError[\s\S]*Next:/)
    expect(lines[0]).toBe('$ node fail.js')
  })
  test('passes and times out', async () => {
    const root = tree({})
    expect((await runCheck({ cwd: root, kind: 'typecheck', spec: { command: 'true', tool: 'tsc', kind: 'typecheck' }, timeoutMs: 30_000 })).text).toMatch(/PASSED/)
    const slow = await runCheck({ cwd: root, kind: 'test', spec: { command: 'sleep 30', tool: 'npm', kind: 'test' }, timeoutMs: 500 })
    expect(slow.timedOut).toBe(true)
    expect(slow.text).toMatch(/timed out/)
  })
})
