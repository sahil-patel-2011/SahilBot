import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { findSymbols, formatSearch, globMatcher, globToRegExp, listFiles, searchCode, symbolsIn } from '../../src/main/code/search'
import { which } from '../../src/main/code/proc'

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'code-'))
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), c)
  }
  return root
}

const FILES = {
  '.gitignore': 'dist/\n*.log\n',
  'src/app.ts': 'export function startServer(port: number) {\n  return listen(port)\n}\n// TODO: tidy\n',
  'src/util.ts': 'export const add = (a: number, b: number) => a + b\nexport class Cache {\n  get(key: string) {\n    return null\n  }\n}\n',
  'src/app.test.ts': 'import { startServer } from "./app"\ntest("starts", () => startServer(1))\n',
  'dist/app.js': 'function startServer() {}\n',
  'debug.log': 'startServer failed\n',
  'node_modules/x/index.js': 'startServer\n',
  'img.png': Buffer.from([0, 1, 2, 3]).toString()
}

describe('globs', () => {
  test('*, **, ?, braces and classes', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true)
    expect(globToRegExp('*.{ts,tsx}').test('a.tsx')).toBe(true)
    expect(globToRegExp('file?.[jt]s').test('file1.js')).toBe(true)
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false)
  })
  test('name-only globs match anywhere; ! excludes', () => {
    const m = globMatcher(['*.ts', '!*.test.ts'])
    expect(m('src/deep/a.ts')).toBe(true)
    expect(m('src/a.test.ts')).toBe(false)
    expect(m('src/a.js')).toBe(false)
  })
})

describe.each([['walk'], ['git']])('listing and search (%s)', (mode) => {
  const root = tree(FILES)
  if (mode === 'git') execFileSync('git', ['init', '-q'], { cwd: root })
  test('respects .gitignore and skips node_modules', async () => {
    const { files, via } = await listFiles(root)
    expect(via).toBe(mode)
    expect(files).toEqual(expect.arrayContaining(['src/app.ts', 'src/util.ts', '.gitignore']))
    expect(files.some((f) => f.startsWith('dist/') || f.endsWith('.log') || f.includes('node_modules'))).toBe(false)
  })
  test('regex search with context, grouped by file', async () => {
    const r = await searchCode(root, { pattern: 'startServer\\(', context: 1, engine: 'node' })
    expect(r.files.map((f) => f.file)).toEqual(['src/app.test.ts', 'src/app.ts'])
    const text = formatSearch(r, { pattern: 'startServer\\(' })
    expect(text).toMatch(/^2 matches in 2 files:/)
    expect(text).toContain('src/app.ts\n  1: export function startServer(port: number) {\n  2-   return listen(port)')
  })
  test('literal, case, globs, path and files_only', async () => {
    expect((await searchCode(root, { pattern: 'todo:', literal: true, ignoreCase: true, engine: 'node' })).matches).toBe(1)
    expect((await searchCode(root, { pattern: 'startServer', globs: ['!*.test.ts'], engine: 'node' })).files.map((f) => f.file)).toEqual(['src/app.ts'])
    expect((await searchCode(root, { pattern: 'export', sub: 'src/util.ts', engine: 'node' })).matches).toBe(2)
    const fo = await searchCode(root, { pattern: 'export', filesOnly: true, engine: 'node' })
    expect(formatSearch(fo, { pattern: 'export', filesOnly: true })).toContain('src/util.ts  (2)')
  })
  test('caps results and says so', async () => {
    const r = await searchCode(root, { pattern: '.', maxResults: 3, engine: 'node' })
    expect(r.matches).toBe(3)
    expect(r.truncated).toBe(true)
    expect(formatSearch(r, { pattern: '.' })).toMatch(/stopped at the cap/)
  })
  test('bad regex is a clear error', async () => {
    await expect(searchCode(root, { pattern: 'a(', engine: 'node' })).rejects.toThrow(/Invalid regex[\s\S]*literal: true/)
  })
})

describe.runIf(!!which('rg'))('ripgrep engine', () => {
  test('gives the same matches as the built-in search', async () => {
    const root = tree(FILES)
    const a = await searchCode(root, { pattern: 'startServer', engine: 'rg', context: 1 })
    const b = await searchCode(root, { pattern: 'startServer', engine: 'node', context: 1 })
    expect(a.files.map((f) => f.file)).toEqual(b.files.map((f) => f.file))
    expect(a.matches).toBe(b.matches)
  })
})

describe('symbols', () => {
  test('TS/JS definitions, outline of a file', () => {
    const s = symbolsIn('a.ts', FILES['src/util.ts'] + 'interface Opts { a: 1 }\ntype Id = string\nenum Color { Red }\nexport default async function main() {}\n')
    expect(s.map((x) => `${x.kind} ${x.name}`)).toEqual(['function add', 'class Cache', 'method get', 'interface Opts', 'type Id', 'enum Color', 'function main'])
  })
  test('Python, Go, Rust, Java, Swift', () => {
    expect(symbolsIn('m.py', 'class A:\n    def run(self):\n        pass\ndef main():\n    if x:\n        pass\n').map((x) => `${x.kind} ${x.name}`)).toEqual(['class A', 'method run', 'function main'])
    expect(symbolsIn('m.go', 'type Server struct {}\nfunc (s *Server) Start() error {\nfunc New() *Server {\n').map((x) => `${x.kind} ${x.name}`)).toEqual(['struct Server', 'method Start', 'function New'])
    expect(symbolsIn('m.rs', 'pub struct Robot;\nimpl Drive for Robot {\npub async fn run() {}\n').map((x) => `${x.kind} ${x.name}`)).toEqual(['struct Robot', 'impl Robot', 'function run'])
    expect(symbolsIn('A.java', 'public class Arm extends Sub {\n  public void periodic() {\n    if (x) {\n').map((x) => `${x.kind} ${x.name}`)).toEqual(['class Arm', 'method periodic'])
    expect(symbolsIn('V.swift', 'struct ContentView: View {\n  func load() async {}\n').map((x) => `${x.kind} ${x.name}`)).toEqual(['struct ContentView', 'function load'])
  })
  test('control flow and comments are not definitions', () => {
    expect(symbolsIn('a.ts', '  if (x) {\n  for (const a of b) {\n// function nope() {}\n/*\nfunction hidden() {}\n*/\n')).toEqual([])
  })
  test('findSymbols ranks exact names first', async () => {
    const root = tree({ ...FILES, 'src/more.ts': 'export function startServerLater() {}\n' })
    const r = await findSymbols(root, { name: 'startServer' })
    expect(r.hits.map((h) => `${h.file}:${h.line} ${h.name}`)).toEqual(['src/app.ts:1 startServer', 'src/more.ts:1 startServerLater'])
    expect((await findSymbols(root, { sub: 'src/util.ts' })).hits.map((h) => h.name)).toEqual(['add', 'Cache', 'get'])
  })
})
