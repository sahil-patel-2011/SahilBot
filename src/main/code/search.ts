import { existsSync, statSync } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { runProcess, which } from './proc'

// Code search for the agent: ripgrep when it is installed, otherwise a pure-Node search over the files
// git would track (tracked + untracked, minus .gitignore), or a walk that honours .gitignore files.
// Output is grouped by file with line numbers and context, and always capped.

/** Folders never searched in the fallback walk (git and rg already skip ignored ones). */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'target', '.gradle', 'DerivedData', 'Pods', '.foreman'])
const MAX_FILE_BYTES = 2_000_000
const MAX_LINE = 300

// ------------------------------------------------------------------ globs

function globSource(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      let depth = 1
      let j = i + 1
      for (; j < glob.length && depth; j++) { if (glob[j] === '{') depth++; else if (glob[j] === '}') depth-- }
      if (depth) { re += '\\{'; continue }
      const inner = glob.slice(i + 1, j - 1)
      const alts: string[] = []
      let d = 0
      let cur = ''
      for (const ch of inner) {
        if (ch === ',' && d === 0) { alts.push(cur); cur = ''; continue }
        if (ch === '{') d++
        if (ch === '}') d--
        cur += ch
      }
      alts.push(cur)
      re += `(?:${alts.map(globSource).join('|')})`
      i = j - 1
    } else if (c === '[') {
      const j = glob.indexOf(']', i + 2)
      if (j < 0) { re += '\\['; continue }
      let cls = glob.slice(i + 1, j)
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`
      re += `[${cls.replace(/\\/g, '\\\\')}]`
      i = j
    } else re += /[.+^${}()|\\]/.test(c) ? `\\${c}` : c
  }
  return re
}

/** A glob as a RegExp over '/'-separated relative paths: *, **, ?, [abc], {a,b}. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob.replace(/^\.\//, '').replace(/^\//, ''))}$`)
}

/** A glob without a slash matches the file name anywhere (like rg -g and .gitignore). */
export function globMatcher(globs: string[] | undefined): (rel: string) => boolean {
  const list = (globs ?? []).map((g) => g.trim()).filter(Boolean)
  if (!list.length) return () => true
  const compile = (g: string): ((rel: string) => boolean) => {
    const body = g.replace(/\/$/, '/**')
    const re = globToRegExp(body)
    if (!body.includes('/')) return (rel) => re.test(basename(rel)) || rel.split('/').slice(0, -1).some((seg) => re.test(seg))
    return (rel) => re.test(rel)
  }
  const inc = list.filter((g) => !g.startsWith('!')).map(compile)
  const exc = list.filter((g) => g.startsWith('!')).map((g) => compile(g.slice(1)))
  return (rel) => (!inc.length || inc.some((m) => m(rel))) && !exc.some((m) => m(rel))
}

// ------------------------------------------------------------------ listing files

type IgnoreRule = { re: RegExp; negate: boolean; dirOnly: boolean; base: string; nameOnly: boolean }

function parseIgnore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    line = line.replace(/\s+$/, '')
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/')
    line = line.replace(/^\//, '')
    rules.push({ re: globToRegExp(line), negate, dirOnly, base, nameOnly: !anchored })
  }
  return rules
}

function ignored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let out = false
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.base && !(rel === r.base || rel.startsWith(`${r.base}/`))) continue
    const sub = r.base ? rel.slice(r.base.length + 1) : rel
    const hit = r.nameOnly ? r.re.test(basename(sub)) : r.re.test(sub)
    if (hit) out = !r.negate
  }
  return out
}

/** True when `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  if (!which('git')) return false
  const r = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, timeoutMs: 10_000 })
  return r.code === 0 && r.stdout.trim() === 'true'
}

/**
 * Files under `root` (relative, '/'-separated) the way git sees them: tracked plus untracked, minus
 * ignored. Outside a repo: a walk that honours .gitignore files and skips dependency/build folders.
 */
export async function listFiles(root: string, o: { max?: number; signal?: AbortSignal } = {}): Promise<{ files: string[]; truncated: boolean; via: 'git' | 'walk' }> {
  const max = o.max ?? 50_000
  if (await isGitRepo(root)) {
    const r = await runProcess('git', ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, timeoutMs: 60_000, signal: o.signal, maxChars: 40_000_000 })
    if (r.code === 0) {
      const all = [...new Set(r.stdout.split('\0').filter(Boolean))].filter((f) => !f.split('/').some((s) => s === 'node_modules' || s === '.git'))
      const files = all.filter((f) => { try { return statSync(join(root, f)).isFile() } catch { return false } })
      return { files: files.slice(0, max), truncated: files.length > max, via: 'git' }
    }
  }
  const files: string[] = []
  const walk = async (dir: string, rules: IgnoreRule[]): Promise<void> => {
    if (files.length >= max || o.signal?.aborted) return
    const relDir = relative(root, dir).split(sep).join('/')
    let local = rules
    const gi = join(dir, '.gitignore')
    if (existsSync(gi)) { try { local = [...rules, ...parseIgnore(await readFile(gi, 'utf8'), relDir)] } catch { /* unreadable */ } }
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (files.length >= max) return
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || ignored(local, rel, true)) continue
        await walk(join(dir, e.name), local)
      } else if (e.isFile() && !ignored(local, rel, false)) files.push(rel)
    }
  }
  await walk(root, [])
  return { files, truncated: files.length >= max, via: 'walk' }
}

async function readText(full: string): Promise<string | null> {
  try {
    const st = statSync(full)
    if (st.size > MAX_FILE_BYTES) return null
    const fh = await open(full, 'r')
    try {
      const buf = await fh.readFile()
      if (buf.subarray(0, 8000).includes(0)) return null
      return buf.toString('utf8')
    } finally { await fh.close() }
  } catch {
    return null
  }
}

/** Runs fn over items with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !signal?.aborted) await fn(items[i++])
  }))
}

// ------------------------------------------------------------------ search

export interface SearchOptions {
  /** Regex (default) or plain text with literal: true. */
  pattern: string
  literal?: boolean
  ignoreCase?: boolean
  /** Only files matching these globs; "!glob" excludes. */
  globs?: string[]
  /** Lines of context before and after each match (0-10). */
  context?: number
  /** Most matching lines to show (default 200). */
  maxResults?: number
  /** Only list the files that match, with counts. */
  filesOnly?: boolean
  /** Search under this sub-path of root (file or folder, relative). */
  sub?: string
  /** 'auto' uses ripgrep when installed. */
  engine?: 'auto' | 'rg' | 'node'
  signal?: AbortSignal
}

export interface FileHits { file: string; lines: Array<{ n: number; text: string; match: boolean }>; count: number }
export interface SearchResult { files: FileHits[]; matches: number; truncated: boolean; engine: 'rg' | 'node' }

const cut = (s: string): string => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)} …` : s)

export function compilePattern(o: Pick<SearchOptions, 'pattern' | 'literal' | 'ignoreCase'>): RegExp {
  const src = o.literal ? o.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : o.pattern
  try {
    return new RegExp(src, o.ignoreCase ? 'i' : '')
  } catch (e) {
    throw new Error(`Invalid regex ${JSON.stringify(o.pattern)}: ${(e as Error).message}. Pass literal: true to search for the exact text.`)
  }
}

async function nodeSearch(root: string, o: SearchOptions): Promise<SearchResult> {
  const re = compilePattern(o)
  const max = o.maxResults ?? 200
  const ctxN = Math.max(0, Math.min(o.context ?? 0, 10))
  const match = globMatcher(o.globs)
  const prefix = o.sub ? o.sub.replace(/^\.\/?/, '').replace(/\/$/, '') : ''
  const { files } = await listFiles(root, { signal: o.signal })
  const cands = files.filter((f) => (!prefix || f === prefix || f.startsWith(`${prefix}/`)) && match(f))
  const out = new Map<string, FileHits>()
  let matches = 0
  let truncated = false
  await pool(cands, 24, async (f) => {
    if (truncated && !o.filesOnly) return
    const text = await readText(join(root, f))
    if (text === null) return
    const lines = text.split(/\r?\n/)
    const hitIdx: number[] = []
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hitIdx.push(i)
    if (!hitIdx.length) return
    const fh: FileHits = { file: f, lines: [], count: hitIdx.length }
    out.set(f, fh)
    if (o.filesOnly) { matches += hitIdx.length; return }
    const keep = new Map<number, boolean>()
    for (const i of hitIdx) {
      if (matches >= max) { truncated = true; break }
      matches++
      for (let k = Math.max(0, i - ctxN); k <= Math.min(lines.length - 1, i + ctxN); k++) if (!keep.has(k)) keep.set(k, false)
      keep.set(i, true)
    }
    fh.lines = [...keep.entries()].sort((a, b) => a[0] - b[0]).map(([k, m]) => ({ n: k + 1, text: cut(lines[k]), match: m }))
  }, o.signal)
  const sorted = [...out.values()].filter((f) => o.filesOnly || f.lines.length).sort((a, b) => a.file.localeCompare(b.file))
  return { files: sorted, matches, truncated, engine: 'node' }
}

async function rgSearch(rg: string, root: string, o: SearchOptions): Promise<SearchResult> {
  const max = o.maxResults ?? 200
  const ctxN = Math.max(0, Math.min(o.context ?? 0, 10))
  // Attached folders need not be Git repositories; still honor their .gitignore files.
  const args = ['--json', '--hidden', '--no-require-git', '-g', '!.git', '--max-filesize', '2M', '--max-columns', '1000']
  if (o.literal) args.push('-F')
  if (o.ignoreCase) args.push('-i')
  if (ctxN) args.push('-C', String(ctxN))
  for (const g of o.globs ?? []) args.push('-g', g)
  for (const dir of SKIP_DIRS) args.push('-g', `!${dir}`)
  args.push('-e', o.pattern, '--', o.sub ? o.sub : '.')
  const r = await runProcess(rg, args, { cwd: root, timeoutMs: 60_000, signal: o.signal, maxChars: 20_000_000 })
  if (r.code !== 0 && r.code !== 1) throw new Error(`ripgrep: ${r.stderr.trim().slice(0, 500) || `exit ${r.code}`}`)
  const out = new Map<string, FileHits>()
  let matches = 0
  let truncated = false
  for (const line of r.stdout.split('\n')) {
    if (!line) continue
    let ev: { type: string; data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } }
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'match' && ev.type !== 'context') continue
    const file = (ev.data.path?.text ?? '').replace(/^\.\//, '')
    if (!file) continue
    const fh = out.get(file) ?? { file, lines: [], count: 0 }
    out.set(file, fh)
    if (ev.type === 'match') {
      fh.count++
      if (matches >= max) { truncated = true; continue }
      matches++
    } else if (truncated) continue
    if (!o.filesOnly) fh.lines.push({ n: ev.data.line_number ?? 0, text: cut((ev.data.lines?.text ?? '').replace(/\r?\n$/, '')), match: ev.type === 'match' })
  }
  if (o.filesOnly) matches = [...out.values()].reduce((n, f) => n + f.count, 0)
  // Context lines past the cap belong to no shown match.
  const files = [...out.values()].map((f) => ({ ...f, lines: trimTrailingContext(f.lines) })).filter((f) => o.filesOnly || f.lines.some((l) => l.match)).sort((a, b) => a.file.localeCompare(b.file))
  return { files, matches, truncated, engine: 'rg' }
}

function trimTrailingContext(lines: FileHits['lines']): FileHits['lines'] {
  const seen = new Set<number>()
  return lines.filter((l) => (seen.has(l.n) ? false : (seen.add(l.n), true)))
}

export async function searchCode(root: string, o: SearchOptions): Promise<SearchResult> {
  const engine = o.engine ?? 'auto'
  const rg = engine === 'node' ? null : which('rg')
  if (engine === 'rg' && !rg) throw new Error('ripgrep (rg) is not installed.')
  // A bad regex gets the same clear message whichever engine runs.
  compilePattern(o)
  if (!rg) return nodeSearch(root, o)
  try {
    return await rgSearch(rg, root, o)
  } catch (e) {
    // ripgrep's regex dialect lacks a few JavaScript features (look-behind, back-references): use ours.
    if (engine === 'rg') throw e
    return nodeSearch(root, o)
  }
}

/** Compact text for the model: grouped by file, "12:" for matches and "13-" for context, "…" between gaps. */
export function formatSearch(r: SearchResult, o: { filesOnly?: boolean; maxChars?: number; pattern: string }): string {
  if (!r.files.length) return `No matches for ${JSON.stringify(o.pattern)}.`
  const head = `${r.matches} match${r.matches === 1 ? '' : 'es'} in ${r.files.length} file${r.files.length === 1 ? '' : 's'}${r.truncated ? ' (stopped at the cap: narrow the search with path or glob)' : ''}:`
  const parts: string[] = [head]
  if (o.filesOnly) parts.push(...r.files.map((f) => `${f.file}  (${f.count})`))
  else {
    for (const f of r.files) {
      parts.push(`\n${f.file}`)
      let prev = 0
      for (const l of f.lines) {
        if (prev && l.n > prev + 1) parts.push('  …')
        parts.push(`  ${l.n}${l.match ? ':' : '-'} ${l.text}`)
        prev = l.n
      }
    }
  }
  const text = parts.join('\n')
  const max = o.maxChars ?? 30_000
  return text.length > max ? `${text.slice(0, max)}\n… [output cut at ${max} characters: narrow the search with path or glob]` : text
}

// ------------------------------------------------------------------ symbols

export interface SymbolHit { file: string; line: number; kind: string; name: string; text: string }

type Rule = { re: RegExp; kind: string | ((m: RegExpExecArray) => string); name?: number }
const ID = '[A-Za-z_$][\\w$]*'
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'new', 'with', 'await', 'typeof', 'delete', 'super', 'this', 'constructor'])

const TS_RULES: Rule[] = [
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`), kind: 'function' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})`), kind: 'class' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+(${ID})`), kind: 'interface' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${ID})\\s*(?:<[^=]*>)?\\s*=`), kind: 'type' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${ID})`), kind: 'enum' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:namespace|module)\\s+(${ID})`), kind: 'namespace' },
  { re: new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(.*)$`), kind: (m) => (/^(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|async\s*\()/.test(m[2] ?? '') ? 'function' : 'const') },
  { re: new RegExp(`^\\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*\\*?(#?${ID})\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*(?::\\s*[^={;]+)?\\s*\\{\\s*$`), kind: 'method' }
]
const PY_RULES: Rule[] = [
  { re: /^(\s*)(?:async\s+)?def\s+(\w+)/, kind: (m) => (m[1] ? 'method' : 'function'), name: 2 },
  { re: /^\s*class\s+(\w+)/, kind: 'class' },
  { re: /^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/, kind: 'const' }
]
const JAVA_RULES: Rule[] = [
  { re: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+(\w+)/, kind: (m) => (m[1] === '@interface' ? 'annotation' : m[1]), name: 2 },
  { re: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+(?:<[^>]+>\s+)?[\w<>[\],.? ]+?\s+(\w+)\s*\([^;=]*$/, kind: 'method' }
]
const KT_RULES: Rule[] = [
  { re: /^\s*(?:(?:public|private|protected|internal|override|open|abstract|suspend|inline|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)/, kind: 'function' },
  { re: /^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|inner|value)\s+)*(class|interface|object)\s+(\w+)/, kind: (m) => m[1], name: 2 }
]
const GO_RULES: Rule[] = [
  { re: /^func\s+(\([^)]*\)\s*)?(\w+)/, kind: (m) => (m[1] ? 'method' : 'function'), name: 2 },
  { re: /^type\s+(\w+)\s+(struct|interface)\b/, kind: (m) => m[2] },
  { re: /^type\s+(\w+)\b/, kind: 'type' }
]
const RS_RULES: Rule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, kind: 'function' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod|union)\s+(\w+)/, kind: (m) => m[1], name: 2 },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([\w:]+)/, kind: 'impl' },
  { re: /^\s*macro_rules!\s*(\w+)/, kind: 'macro' }
]
const SWIFT_RULES: Rule[] = [
  { re: /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|static|class|final|override|mutating|async)\s+)*func\s+(\w+)/, kind: 'function' },
  { re: /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|final|indirect)\s+)*(class|struct|enum|protocol|extension|actor)\s+(\w+)/, kind: (m) => m[1], name: 2 }
]

const LANGS: Record<string, Rule[]> = {
  '.ts': TS_RULES, '.tsx': TS_RULES, '.mts': TS_RULES, '.cts': TS_RULES, '.js': TS_RULES, '.jsx': TS_RULES, '.mjs': TS_RULES, '.cjs': TS_RULES,
  '.py': PY_RULES, '.pyi': PY_RULES, '.java': JAVA_RULES, '.kt': KT_RULES, '.kts': KT_RULES, '.go': GO_RULES, '.rs': RS_RULES, '.swift': SWIFT_RULES
}

export const symbolLanguages = (): string[] => Object.keys(LANGS)

/** Definitions in one file's text (heuristic, line-based). */
export function symbolsIn(file: string, text: string): SymbolHit[] {
  const rules = LANGS[extname(file).toLowerCase()]
  if (!rules) return []
  const out: SymbolHit[] = []
  const lines = text.split(/\r?\n/)
  let inBlockComment = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (inBlockComment) { if (t.includes('*/')) inBlockComment = false; continue }
    if (t.startsWith('/*') && !t.includes('*/')) { inBlockComment = true; continue }
    if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) continue
    for (const r of rules) {
      const m = r.re.exec(line)
      if (!m) continue
      const name = m[r.name ?? 1]
      if (!name || CONTROL.has(name)) continue
      out.push({ file, line: i + 1, kind: typeof r.kind === 'string' ? r.kind : r.kind(m), name, text: cut(t) })
      break
    }
  }
  return out
}

/**
 * Finds definitions by name (case-insensitive; exact names first, then prefixes, then substrings),
 * or lists every definition in a file or folder when no name is given.
 */
export async function findSymbols(root: string, o: { name?: string; sub?: string; globs?: string[]; max?: number; signal?: AbortSignal }): Promise<{ hits: SymbolHit[]; total: number }> {
  const prefix = o.sub ? o.sub.replace(/^\.\/?/, '').replace(/\/$/, '') : ''
  const match = globMatcher(o.globs)
  let files: string[]
  if (prefix && existsSync(join(root, prefix)) && statSync(join(root, prefix)).isFile()) files = [prefix]
  else files = (await listFiles(root, { signal: o.signal })).files.filter((f) => (!prefix || f.startsWith(`${prefix}/`)) && match(f) && LANGS[extname(f).toLowerCase()])
  const want = o.name?.trim().toLowerCase()
  const hits: SymbolHit[] = []
  await pool(files, 24, async (f) => {
    const text = await readText(join(root, f))
    if (text === null || (want && !text.toLowerCase().includes(want))) return
    for (const s of symbolsIn(f, text)) if (!want || s.name.toLowerCase().includes(want)) hits.push(s)
  }, o.signal)
  const rank = (s: SymbolHit): number => {
    if (!want) return 0
    const n = s.name.toLowerCase()
    return n === want ? (s.name === o.name ? 0 : 1) : n.startsWith(want) ? 2 : 3
  }
  hits.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.line - b.line)
  return { hits: hits.slice(0, o.max ?? 200), total: hits.length }
}

export function formatSymbols(r: { hits: SymbolHit[]; total: number }, what: string): string {
  if (!r.hits.length) return `No definitions found for ${what}. Try search with a regex, or check the spelling.`
  const lines = r.hits.map((s) => `${s.file}:${s.line}  ${s.kind} ${s.name}  │ ${s.text}`)
  return `${r.total} definition${r.total === 1 ? '' : 's'} for ${what}${r.total > r.hits.length ? ` (showing ${r.hits.length})` : ''}:\n${lines.join('\n')}`
}
