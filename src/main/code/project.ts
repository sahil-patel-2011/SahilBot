import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

// What kind of project a folder is and how to test, type-check and lint it, plus parsers that turn
// the output of common tools into a short list of file:line problems the agent can act on.

export type Check = 'test' | 'typecheck' | 'lint' | 'build'

export interface CommandSpec {
  /** A zsh command line (run with zsh -lc so nvm/pyenv shims work). */
  command: string
  /** What produced it: vitest, jest, pytest, cargo, go, gradle, tsc, eslint, ruff, mypy… (picks the parser). */
  tool: string
  kind: Check
}

export interface ProjectInfo {
  root: string
  kinds: string[]
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun'
  scripts: Record<string, string>
  test?: CommandSpec
  typecheck: CommandSpec[]
  lint: CommandSpec[]
  build?: CommandSpec
}

export const shQuote = (s: string): string => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined } }
const readText = (p: string): string => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const has = (root: string, ...names: string[]): boolean => names.some((n) => existsSync(join(root, n)))
const anyFile = (root: string, re: RegExp): boolean => { try { return readdirSync(root).some((f) => re.test(f)) } catch { return false } }

/** A filter that names a file or folder (rather than a test name). */
export const pathLike = (f: string): boolean => /[\\/]/.test(f) || /\.(test|spec)\.|\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|swift)$/.test(f)

const NPM_DEFAULT_TEST = /no test specified/

export function detectProject(root: string): ProjectInfo {
  const info: ProjectInfo = { root, kinds: [], scripts: {}, typecheck: [], lint: [] }
  const pkg = readJson(join(root, 'package.json'))
  const pyproject = readText(join(root, 'pyproject.toml'))
  if (pkg) {
    info.kinds.push('node')
    info.packageManager = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : has(root, 'bun.lockb', 'bun.lock') ? 'bun' : 'npm'
    info.scripts = pkg.scripts ?? {}
  }
  if (pyproject || has(root, 'setup.py', 'setup.cfg', 'requirements.txt', 'pytest.ini', 'tox.ini', 'conftest.py', 'Pipfile')) info.kinds.push('python')
  if (has(root, 'Cargo.toml')) info.kinds.push('rust')
  if (has(root, 'go.mod')) info.kinds.push('go')
  if (has(root, 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew')) info.kinds.push('gradle')
  if (has(root, 'pom.xml')) info.kinds.push('maven')
  if (has(root, 'Package.swift')) info.kinds.push('swift')

  const pm = info.packageManager ?? 'npm'
  const run = (script: string): string => (pm === 'npm' ? `npm run ${script}` : pm === 'bun' ? `bun run ${script}` : `${pm} ${script}`)
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>
  const testScript = info.scripts.test && !NPM_DEFAULT_TEST.test(info.scripts.test) ? info.scripts.test : undefined

  // Tests: the first ecosystem that has them.
  if (pkg && (testScript || deps.vitest || deps.jest || deps.mocha)) {
    const tool = /vitest/.test(testScript ?? '') || deps.vitest ? 'vitest' : /jest/.test(testScript ?? '') || deps.jest ? 'jest' : /mocha/.test(testScript ?? '') || deps.mocha ? 'mocha' : /node --test/.test(testScript ?? '') ? 'node' : 'npm'
    info.test = { command: testScript ? (pm === 'npm' ? 'npm test' : `${pm} test`) : `npx --no-install ${tool === 'vitest' ? 'vitest run' : tool}`, tool, kind: 'test' }
  } else if (info.kinds.includes('python')) {
    const py = has(root, '.venv/bin/python') ? '.venv/bin/python' : has(root, 'venv/bin/python') ? 'venv/bin/python' : has(root, 'uv.lock') ? 'uv run python' : has(root, 'poetry.lock') ? 'poetry run python' : 'python3'
    info.test = { command: `${py} -m pytest -q -rfE --no-header`, tool: 'pytest', kind: 'test' }
  } else if (info.kinds.includes('rust')) info.test = { command: 'cargo test', tool: 'cargo', kind: 'test' }
  else if (info.kinds.includes('go')) info.test = { command: 'go test ./...', tool: 'go', kind: 'test' }
  else if (info.kinds.includes('gradle')) info.test = { command: `${has(root, 'gradlew') ? './gradlew' : 'gradle'} test --console=plain`, tool: 'gradle', kind: 'test' }
  else if (info.kinds.includes('maven')) info.test = { command: 'mvn -q -B test', tool: 'maven', kind: 'test' }
  else if (info.kinds.includes('swift')) info.test = { command: 'swift test', tool: 'swift', kind: 'test' }

  // Type checks.
  if (pkg && (has(root, 'tsconfig.json') || deps.typescript)) {
    info.typecheck.push(info.scripts.typecheck ? { command: run('typecheck'), tool: 'tsc', kind: 'typecheck' } : { command: 'npx --no-install tsc --noEmit --pretty false', tool: 'tsc', kind: 'typecheck' })
  }
  if (info.kinds.includes('python')) {
    if (/\[tool\.mypy\]/.test(pyproject) || has(root, 'mypy.ini', '.mypy.ini') || /\[mypy\]/.test(readText(join(root, 'setup.cfg')))) info.typecheck.push({ command: 'mypy --no-color-output --no-error-summary .', tool: 'mypy', kind: 'typecheck' })
    if (has(root, 'pyrightconfig.json') || /\[tool\.pyright\]/.test(pyproject)) info.typecheck.push({ command: 'pyright', tool: 'pyright', kind: 'typecheck' })
  }
  if (info.kinds.includes('rust')) info.typecheck.push({ command: 'cargo check --message-format short', tool: 'cargo', kind: 'typecheck' })
  if (info.kinds.includes('go')) info.typecheck.push({ command: 'go vet ./...', tool: 'go', kind: 'typecheck' })

  // Linters.
  if (pkg && (deps.eslint || anyFile(root, /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\..+)?)$/))) info.lint.push({ command: 'npx --no-install eslint . --format json', tool: 'eslint', kind: 'lint' })
  else if (pkg && info.scripts.lint) info.lint.push({ command: run('lint'), tool: 'lint-script', kind: 'lint' })
  if (info.kinds.includes('python') && (/\[tool\.ruff/.test(pyproject) || has(root, 'ruff.toml', '.ruff.toml'))) info.lint.push({ command: 'ruff check --output-format json .', tool: 'ruff', kind: 'lint' })
  if (info.kinds.includes('rust')) info.lint.push({ command: 'cargo clippy --message-format short', tool: 'cargo', kind: 'lint' })
  if (info.kinds.includes('go') && anyFile(root, /^\.golangci\.ya?ml$/)) info.lint.push({ command: 'golangci-lint run', tool: 'golangci', kind: 'lint' })

  if (pkg && info.scripts.build) info.build = { command: run('build'), tool: 'build', kind: 'build' }
  else if (info.kinds.includes('rust')) info.build = { command: 'cargo build', tool: 'cargo', kind: 'build' }
  else if (info.kinds.includes('go')) info.build = { command: 'go build ./...', tool: 'go', kind: 'build' }
  else if (info.kinds.includes('gradle')) info.build = { command: `${has(root, 'gradlew') ? './gradlew' : 'gradle'} build -x test --console=plain`, tool: 'gradle', kind: 'build' }
  else if (info.kinds.includes('swift')) info.build = { command: 'swift build', tool: 'swift', kind: 'build' }
  return info
}

/** The test command narrowed to a file, folder or test name. */
export function testCommand(spec: CommandSpec, filter?: string, pm: ProjectInfo['packageManager'] = 'npm'): string {
  const f = filter?.trim()
  if (!f) return spec.command
  const q = shQuote(f)
  const viaScript = /^(npm|pnpm|yarn|bun) test$/.test(spec.command)
  const extra = (args: string): string => (viaScript ? (pm === 'npm' ? `${spec.command} -- ${args}` : `${spec.command} ${args}`) : `${spec.command} ${args}`)
  switch (spec.tool) {
    case 'vitest': return extra(pathLike(f) ? q : `-t ${q}`)
    case 'jest': return extra(pathLike(f) ? q : `-t ${q}`)
    case 'mocha': return extra(pathLike(f) ? q : `--grep ${q}`)
    case 'node': return extra(q)
    case 'pytest': return `${spec.command} ${pathLike(f) || f.includes('::') ? q : `-k ${q}`}`
    case 'cargo': return `cargo test ${q}`
    case 'go': return pathLike(f) || f.startsWith('./') ? `go test ${q}` : `go test ./... -run ${q}`
    case 'gradle': return `${spec.command} --tests ${q}`
    case 'maven': return `${spec.command} -Dtest=${q}`
    case 'swift': return `swift test --filter ${q}`
    default: return extra(q)
  }
}

// ------------------------------------------------------------------ parsing output

export interface Diagnostic {
  file?: string
  line?: number
  col?: number
  severity: 'error' | 'warning'
  code?: string
  message: string
  /** For test failures: the test's name. */
  test?: string
}

const rel = (root: string, f: string): string => {
  const clean = f.trim().replace(/^file:\/\//, '')
  return isAbsolute(clean) ? relative(root, clean) || clean : clean.replace(/^\.\//, '')
}

const SRC = '([\\w@./+-][\\w@./+ -]*\\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|kts|swift|rb|php|c|cc|cpp|h|hpp|cs))'
const LOC = new RegExp(`${SRC}:(\\d+)(?::(\\d+))?`)

/** tsc, mypy, pyright, go vet, cargo --message-format short, swift, eslint unix: "file:line:col: …" styles. */
export function parseCompilerStyle(out: string, root: string): Diagnostic[] {
  const diags: Diagnostic[] = []
  for (const raw of out.split('\n')) {
    const l = raw.trimEnd()
    let m: RegExpExecArray | null
    if ((m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(l))) diags.push({ file: rel(root, m[1]), line: +m[2], col: +m[3], severity: m[4] as 'error', code: m[5], message: m[6] })
    else if ((m = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/.exec(l))) diags.push({ file: rel(root, m[1]), line: +m[2], col: +m[3], severity: m[4] as 'error', code: m[5], message: m[6] })
    else if ((m = /^(.+?):(\d+)(?::(\d+))?: (error|warning|note)(?:\[(\w+)\])?: (.*?)(?:\s+\[([\w-]+)\])?$/.exec(l))) {
      if (m[4] === 'note') continue
      diags.push({ file: rel(root, m[1]), line: +m[2], col: m[3] ? +m[3] : undefined, severity: m[4] as 'error', code: m[5] ?? m[7], message: m[6] })
    } else if ((m = /^\s*(.+?):(\d+):(\d+) - (error|warning) (.*)$/.exec(l))) diags.push({ file: rel(root, m[1]), line: +m[2], col: +m[3], severity: m[4] as 'error', message: m[5] })
    else if ((m = new RegExp(`^${SRC}:(\\d+):(\\d+): (.+)$`).exec(l)) && !/^\s/.test(l)) {
      // go vet / unix formatter: "file:line:col: message [Error/rule]"
      const msg = m[4]
      const sev = /\[warning/i.test(msg) ? 'warning' : 'error'
      const code = /\[(?:Error|Warning)\/([\w@/-]+)\]$/.exec(msg)?.[1]
      diags.push({ file: rel(root, m[1]), line: +m[2], col: +m[3], severity: sev, code, message: msg.replace(/\s*\[(?:Error|Warning)\/[\w@/-]+\]$/, '') })
    }
  }
  return diags
}

export function parseEslint(out: string, root: string): Diagnostic[] {
  const start = out.indexOf('[{')
  if (start >= 0) {
    try {
      const data = JSON.parse(out.slice(start, out.lastIndexOf('}]') + 2)) as Array<{ filePath: string; messages: Array<{ line?: number; column?: number; severity: number; message: string; ruleId?: string | null }> }>
      return data.flatMap((f) => f.messages.map((m) => ({ file: rel(root, f.filePath), line: m.line, col: m.column, severity: m.severity >= 2 ? 'error' as const : 'warning' as const, code: m.ruleId ?? undefined, message: m.message })))
    } catch { /* fall through to the text formats */ }
  }
  // "stylish": a path line, then "  12:5  error  message  rule-id".
  const diags: Diagnostic[] = []
  let file = ''
  for (const l of out.split('\n')) {
    if (/^\S.*\.\w+$/.test(l.trim()) && !/^\s/.test(l) && !/problems?/.test(l)) { file = rel(root, l.trim()); continue }
    const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w@/-]+))?$/.exec(l)
    if (m && file) diags.push({ file, line: +m[1], col: +m[2], severity: m[3] as 'error', message: m[4].trim(), code: m[5] })
  }
  return diags.length ? diags : parseCompilerStyle(out, root)
}

export function parseRuff(out: string, root: string): Diagnostic[] {
  const start = out.indexOf('[')
  if (start >= 0) {
    try {
      const data = JSON.parse(out.slice(start)) as Array<{ filename: string; location?: { row: number; column: number }; code?: string; message: string }>
      return data.map((d) => ({ file: rel(root, d.filename), line: d.location?.row, col: d.location?.column, severity: 'error' as const, code: d.code ?? undefined, message: d.message }))
    } catch { /* text output */ }
  }
  const diags: Diagnostic[] = []
  for (const l of out.split('\n')) {
    const m = /^(.+?):(\d+):(\d+): ([A-Z]+\d+) (.*)$/.exec(l.trim())
    if (m) diags.push({ file: rel(root, m[1]), line: +m[2], col: +m[3], severity: 'error', code: m[4], message: m[5] })
  }
  return diags
}

export interface TestReport { failures: Diagnostic[]; summary?: string; passed?: number; failed?: number }

const firstLoc = (lines: string[], root: string): { file: string; line: number } | undefined => {
  for (const l of lines) {
    if (/node_modules|node:internal|\/lib\/python|site-packages|\.rustup|\/go\/src\//.test(l)) continue
    const m = LOC.exec(l)
    if (m) return { file: rel(root, m[1]), line: +m[2] }
  }
  return undefined
}

function parseJsTests(out: string, root: string): TestReport {
  const lines = out.split('\n')
  const failures: Diagnostic[] = []
  // Vitest: " FAIL  file > suite > test"; Jest: "  ● suite › test".
  const heads: number[] = []
  lines.forEach((l, i) => { if (/^\s*(FAIL|×|✕)\s+\S.*\s>\s/.test(l) || /^\s*●\s+(?!Console)/.test(l)) heads.push(i) })
  const byName = new Map<string, Diagnostic>()
  heads.forEach((h, k) => {
    const listLine = /^\s*(×|✕)\s/.test(lines[h])
    const name = lines[h].replace(/^\s*(FAIL|×|✕|●)\s+/, '').replace(/\s+\d+(?:\.\d+)?\s?m?s$/, '').trim()
    const body = listLine ? [] : lines.slice(h + 1, heads[k + 1] ?? Math.min(lines.length, h + 60))
    const msg = body.find((l) => /(Error|expected|Expected|assert|Received|toBe|toEqual|Cannot|is not|undefined)/.test(l) && !/^\s*at\s/.test(l))?.trim()
    const loc = firstLoc(body, root)
    const prev = byName.get(name)
    const d: Diagnostic = prev ?? { test: name, severity: 'error', message: 'failed' }
    d.file ??= loc?.file ?? /^(\S+\.[cm]?[jt]sx?)\b/.exec(name)?.[1]
    if (loc && !d.line) { d.file = loc.file; d.line = loc.line }
    if (msg && d.message === 'failed') d.message = msg.slice(0, 300)
    if (!prev) { byName.set(name, d); failures.push(d) }
  })
  // A results-list line ("× suite > test") and its detailed block ("FAIL  file > suite > test") are one failure.
  for (let i = failures.length - 1; i >= 0; i--) {
    const f = failures[i]
    if (failures.some((g) => g !== f && g.test !== f.test && g.test!.endsWith(` > ${f.test}`))) failures.splice(i, 1)
  }
  const v = /^\s*Tests\s+(?:(\d+) failed)?\s*\|?\s*(?:(\d+) passed)?/m.exec(out)
  const j = /^\s*Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(?:(\d+) passed,\s*)?\d+ total/m.exec(out)
  const sumLine = lines.find((l) => /^\s*Tests[:\s]/.test(l))?.trim()
  return { failures, summary: sumLine, failed: Number((v ?? j)?.[1] ?? failures.length) || failures.length, passed: Number((v ?? j)?.[2] ?? 0) }
}

function parsePytest(out: string, root: string): TestReport {
  const lines = out.split('\n')
  const failures: Diagnostic[] = []
  // Sections: "____ test_name ____" with "file.py:12: AssertionError" lines and "E   …" messages.
  const sections = new Map<string, { loc?: { file: string; line: number }; msg?: string }>()
  let cur: string | null = null
  for (const l of lines) {
    const s = /^_{3,} (.+?) _{3,}$/.exec(l)
    if (s) { cur = s[1].trim(); sections.set(cur, {}); continue }
    if (!cur) continue
    const sec = sections.get(cur)!
    const loc = /^([\w./-]+\.py):(\d+): (.*)$/.exec(l)
    if (loc) sec.loc = { file: rel(root, loc[1]), line: +loc[2] }
    const e = /^E\s+(.*)$/.exec(l)
    if (e && !sec.msg && e[1].trim()) sec.msg = e[1].trim()
  }
  for (const l of lines) {
    const m = /^(FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - (.*))?$/.exec(l.trim())
    if (!m) continue
    const test = m[3] ? `${m[2]}::${m[3]}` : m[2]
    const key = [...sections.keys()].find((k) => m[3] && (k === m[3] || k.endsWith(`.${m[3]}`) || m[3].endsWith(k.split('.').pop()!)))
    const sec = key ? sections.get(key) : undefined
    failures.push({ test, file: sec?.loc?.file ?? m[2].split('::')[0], line: sec?.loc?.line, severity: 'error', message: (m[4] ?? sec?.msg ?? (m[1] === 'ERROR' ? 'error during collection or setup' : 'failed')).slice(0, 300) })
  }
  const sum = [...lines].reverse().find((l) => /^=+ .*\b(passed|failed|error|no tests ran)\b.* =+$/.test(l.trim()))?.replace(/=/g, '').trim()
  return { failures, summary: sum, failed: Number(/(\d+) failed/.exec(sum ?? '')?.[1] ?? failures.length), passed: Number(/(\d+) passed/.exec(sum ?? '')?.[1] ?? 0) }
}

function parseGoTests(out: string, root: string): TestReport {
  const lines = out.split('\n')
  const failures: Diagnostic[] = []
  lines.forEach((l, i) => {
    const m = /^\s*--- FAIL: (\S+)/.exec(l)
    if (!m) return
    const body = lines.slice(i + 1, i + 30)
    const at = body.find((b) => /^\s+\S+_test\.go:\d+:/.test(b)) ?? lines.slice(Math.max(0, i - 20), i).reverse().find((b) => /^\s+\S+_test\.go:\d+:/.test(b))
    const loc = at ? /^\s+(\S+\.go):(\d+): (.*)$/.exec(at) : null
    failures.push({ test: m[1], file: loc ? rel(root, loc[1]) : undefined, line: loc ? +loc[2] : undefined, severity: 'error', message: (loc?.[3] ?? 'failed').slice(0, 300) })
  })
  // Build failures show up as compiler errors.
  if (!failures.length) failures.push(...parseCompilerStyle(out, root).filter((d) => d.severity === 'error'))
  const ok = lines.filter((l) => /^ok\s/.test(l)).length
  const bad = lines.filter((l) => /^FAIL\s/.test(l)).length
  return { failures, summary: `${ok} package${ok === 1 ? '' : 's'} ok, ${bad} failed`, failed: failures.length, passed: undefined }
}

function parseCargoTests(out: string, root: string): TestReport {
  const lines = out.split('\n')
  const failures: Diagnostic[] = []
  lines.forEach((l, i) => {
    const m = /^---- (\S+) stdout ----$/.exec(l)
    if (!m) return
    const body = lines.slice(i + 1, i + 25)
    const p = body.map((b) => /panicked at (?:'(.*)', )?([\w./-]+\.rs):(\d+):\d+:?/.exec(b)).find(Boolean)
    const msgIdx = body.findIndex((b) => /panicked at/.test(b))
    const msg = p?.[1] ?? body.slice(msgIdx + 1).find((b) => b.trim() && !/^note:/.test(b))?.trim()
    failures.push({ test: m[1], file: p ? rel(root, p[2]) : undefined, line: p ? +p[3] : undefined, severity: 'error', message: (msg ?? 'panicked').slice(0, 300) })
  })
  if (!failures.length) failures.push(...parseCompilerStyle(out, root).filter((d) => d.severity === 'error'))
  const sum = [...lines].reverse().find((l) => /^test result:/.test(l))
  return { failures, summary: sum?.trim(), failed: Number(/(\d+) failed/.exec(sum ?? '')?.[1] ?? failures.length), passed: Number(/(\d+) passed/.exec(sum ?? '')?.[1] ?? 0) }
}

function parseJvmTests(out: string, root: string): TestReport {
  const lines = out.split('\n')
  const failures: Diagnostic[] = []
  lines.forEach((l, i) => {
    const m = /^(\S+) > (.+?) FAILED$/.exec(l.trim())
    if (!m) return
    const body = lines.slice(i + 1, i + 20)
    const msg = body.find((b) => b.trim() && !/^\s*at /.test(b))?.trim()
    const at = body.map((b) => /\((\w+\.(?:java|kt)):(\d+)\)/.exec(b)).find(Boolean)
    failures.push({ test: `${m[1]} > ${m[2]}`, file: at?.[1], line: at ? +at[2] : undefined, severity: 'error', message: (msg ?? 'failed').slice(0, 300) })
  })
  // Maven surefire: "[ERROR]   FooTest.bar:23 expected: <1> but was: <2>"
  for (const l of lines) {
    const m = /^\[ERROR\]\s+(\w+)\.(\w+):(\d+) (.*)$/.exec(l.trim())
    if (m) failures.push({ test: `${m[1]}.${m[2]}`, file: `${m[1]}.java`, line: +m[3], severity: 'error', message: m[4].slice(0, 300) })
  }
  if (!failures.length) failures.push(...parseCompilerStyle(out, root).filter((d) => d.severity === 'error'))
  const sum = lines.find((l) => /tests completed|Tests run:/.test(l))?.trim()
  return { failures, summary: sum, failed: failures.length }
}

export function parseTestOutput(tool: string, out: string, root: string): TestReport {
  switch (tool) {
    case 'vitest': case 'jest': case 'mocha': case 'node': return parseJsTests(out, root)
    case 'pytest': return parsePytest(out, root)
    case 'go': return parseGoTests(out, root)
    case 'cargo': return parseCargoTests(out, root)
    case 'gradle': case 'maven': return parseJvmTests(out, root)
    default: {
      // Unknown runner: the first format that finds failures.
      for (const parse of [parseJsTests, parsePytest, parseGoTests, parseCargoTests, parseJvmTests]) {
        const r = parse(out, root)
        if (r.failures.length) return r
      }
      return { failures: parseCompilerStyle(out, root).filter((d) => d.severity === 'error') }
    }
  }
}

export function parseDiagnostics(tool: string, out: string, root: string): Diagnostic[] {
  const list = tool === 'eslint' || tool === 'lint-script' ? parseEslint(out, root) : tool === 'ruff' ? parseRuff(out, root) : parseCompilerStyle(out, root)
  // De-duplicate (cargo and tsc can repeat lines).
  const seen = new Set<string>()
  return list.filter((d) => { const k = `${d.file}:${d.line}:${d.col}:${d.message}`; if (seen.has(k)) return false; seen.add(k); return true })
}

export const formatDiag = (d: Diagnostic): string =>
  `${d.file ?? '?'}${d.line ? `:${d.line}${d.col ? `:${d.col}` : ''}` : ''}${d.test ? ` — ${d.test}` : ''}${d.severity === 'warning' ? ' (warning)' : ''}${d.code ? ` [${d.code}]` : ''}: ${d.message}`

/** One concrete next step for the agent, from the first problem found. */
export function suggestNext(kind: Check, items: Diagnostic[], filterHint?: string): string {
  const first = items.find((d) => d.severity === 'error') ?? items[0]
  if (!first) return ''
  const where = first.file && first.line ? `code(action="read", path="${first.file}", start=${Math.max(1, first.line - 15)}, end=${first.line + 15})` : first.file ? `code(action="read", path="${first.file}")` : 'the output below'
  if (kind === 'test') {
    const rerun = first.test ? first.test.split(/\s+>\s+|\s+›\s+|::/).pop() : filterHint
    return `Next: read the failing spot (${where}) and the code it tests, decide whether the code or the test is wrong (usually the code), make the smallest fix with code(action="edit"), then rerun just this test with code(action="run_tests", filter=${JSON.stringify(rerun ?? first.file ?? '')}) before the full suite.`
  }
  return `Next: fix the first ${kind === 'lint' ? 'lint error' : 'type error'} (${where}); related errors often disappear with it. Rerun code(action="${kind === 'lint' ? 'lint' : 'typecheck'}") after each fix.`
}
