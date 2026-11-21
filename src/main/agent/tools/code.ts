import { shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { noteSeen } from './freshness'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { ToolEffect } from '@shared/types'
import { type CommandSpec, type Check, detectProject } from '../../code/project'
import { runCheck } from '../../code/checks'
import { checkBranchName, currentBranch, formatFindings, gh, ghInstalled, git, gitRoot, scanDiffForSecrets, status as gitStatus, upstreamOf } from '../../code/git'
import { applyHunks, clipDiff, parsePatch, patchSummary, replaceExact, unifiedDiff } from '../../code/patch'
import { clip } from '../../code/proc'
import { findSymbols, formatSearch, formatSymbols, isGitRepo, searchCode } from '../../code/search'
import type { ToolContext, ToolDef } from '../types'
import { backup, resolvePath } from './files'
import { classify, cwdFor } from './shell'

// The coding tools: `code` (search, symbols, read with line numbers, exact edits, multi-file patches,
// tests / type checks / lint with parsed failures) and `git` (status, diffs, branches, commits with a
// secret scan, stash, push and pull requests through the GitHub CLI). Paths are relative to the
// project folder (the first attached folder, else the workspace) and never leave the workspace or
// the folders the user attached.

type Ctx = Pick<ToolContext, 'state' | 'workspaceDir' | 'signal' | 'progress'> & { threadId?: string }

/** A path inside the project folder (relative) or inside the workspace/attached folders (absolute). */
function resolveIn(base: string, p: string, ctx: Ctx): string {
  const abs = isAbsolute(p) || p.startsWith('~/') ? p : join(base, p)
  return resolvePath(abs, ctx.workspaceDir, ctx.state.roots ?? [])
}

const relTo = (base: string, full: string): string => {
  const r = relative(base, full)
  return r && !r.startsWith('..') ? r : full
}

function readTextFile(full: string, shown: string): string {
  if (!existsSync(full)) throw new Error(`No such file: ${shown}`)
  if (lstatSync(full).isDirectory()) throw new Error(`${shown} is a folder.`)
  if (statSync(full).size > 4_000_000) throw new Error(`${shown} is too large to edit here (${Math.round(statSync(full).size / 1e6)} MB).`)
  const buf = readFileSync(full)
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${shown} is a binary file.`)
  return buf.toString('utf8')
}

const guessTool = (cmd: string, kind: Check): string =>
  /\bvitest\b/.test(cmd) ? 'vitest' : /\bjest\b/.test(cmd) ? 'jest' : /\bmocha\b/.test(cmd) ? 'mocha' : /pytest/.test(cmd) ? 'pytest'
    : /cargo (test|nextest)/.test(cmd) ? 'cargo' : /\bgo test\b/.test(cmd) ? 'go' : /gradle/.test(cmd) ? 'gradle' : /\bmvn\b/.test(cmd) ? 'maven'
      : /\btsc\b/.test(cmd) ? 'tsc' : /\beslint\b/.test(cmd) ? 'eslint' : /\bruff\b/.test(cmd) ? 'ruff' : /\bmypy\b/.test(cmd) ? 'mypy'
        : kind === 'test' ? 'npm' : 'generic'

const STRICT: ToolEffect[] = ['read', 'write_local', 'write_external', 'destructive']
const stricter = (a: ToolEffect, b: ToolEffect): ToolEffect => (STRICT.indexOf(a) >= STRICT.indexOf(b) ? a : b)

// ------------------------------------------------------------------ code

export type CodeArgs = {
  action: 'search' | 'symbols' | 'read' | 'edit' | 'apply_patch' | 'project' | 'run_tests' | 'typecheck' | 'lint' | 'build'
  dir?: string
  pattern?: string; literal?: boolean; ignore_case?: boolean; glob?: string[]; context?: number; max_results?: number; files_only?: boolean
  name?: string
  path?: string; start?: number; end?: number
  old_string?: string; new_string?: string; replace_all?: boolean
  edits?: Array<{ old_string: string; new_string: string; replace_all?: boolean }>
  patch?: string; dry_run?: boolean
  filter?: string; command?: string; timeout?: number
}

const CHECKS: Record<string, Check> = { run_tests: 'test', typecheck: 'typecheck', lint: 'lint', build: 'build' }

export function codeEffect(a: CodeArgs): ToolEffect {
  switch (a.action) {
    case 'search': case 'symbols': case 'read': case 'project': return 'read'
    case 'edit': return 'write_local'
    case 'apply_patch': {
      if (a.dry_run) return 'read'
      try { return patchSummary(a.patch ?? '').deletes.length ? 'destructive' : 'write_local' } catch { return 'write_local' }
    }
    default: return a.command ? stricter('write_local', classify(a.command).effect) : 'write_local'
  }
}

export function codeTool(o: { getWorkspace: () => string; trash?: (path: string) => Promise<void> }): ToolDef<CodeArgs> {
  const trash = o.trash ?? ((p: string) => shell.trashItem(p))
  return {
    name: 'code',
    label: 'Code',
    core: false,
    group: 'Coding',
    effect: (a) => codeEffect(a),
    hardStop: (a) => {
      if (a.action === 'apply_patch' && !a.dry_run) {
        try { const d = patchSummary(a.patch ?? '').deletes; if (d.length) return `deleting ${d.join(', ')} (moved to the Trash)` } catch { /* run reports it */ }
      }
      if (a.command && CHECKS[a.action] && classify(a.command).effect === 'destructive') return `"${a.command.slice(0, 80)}" ${classify(a.command).why}`
      return null
    },
    describe: (a) => {
      switch (a.action) {
        case 'edit': return `Edit ${a.path}: ${a.edits?.length ? `${a.edits.length} replacements` : `replace "${(a.old_string ?? '').split('\n')[0].slice(0, 80)}"${a.replace_all ? ' (every occurrence)' : ''}`}`
        case 'apply_patch': {
          try {
            const fps = parsePatch(a.patch ?? '')
            return `${a.dry_run ? 'Preview' : 'Apply'} a patch: ${fps.map((f) => `${f.op} ${f.path}${f.moveTo ? ` → ${f.moveTo}` : ''}`).join(', ')}`
          } catch { return 'Apply a patch' }
        }
        case 'run_tests': return `Run the tests${a.filter ? ` matching "${a.filter}"` : ''}${a.command ? `: ${a.command}` : ''}${a.dir ? ` in ${a.dir}` : ''}`
        case 'typecheck': case 'lint': case 'build': return `Run ${a.action}${a.command ? `: ${a.command}` : ''}${a.dir ? ` in ${a.dir}` : ''}`
        default: return `Code ${a.action}${a.pattern ? ` "${a.pattern.slice(0, 80)}"` : a.name ? ` "${a.name}"` : a.path ? ` ${a.path}` : ''}`
      }
    },
    description: `Work on a code project (default folder: the attached/project folder, else the workspace; dir to choose; paths are relative to it).
- project: what the project is (languages, test/typecheck/lint/build commands, git branch and changes, top-level files). Start here.
- search(pattern, literal?, ignore_case?, glob?: ["*.ts","!**/*.test.ts"], path?, context?: 0-10, files_only?): regex search over the files git would track (respects .gitignore).
- symbols(name?, path?): where functions/classes/types are defined (TS/JS, Python, Java, Kotlin, Go, Rust, Swift); with only path: an outline of that file.
- read(path, start?, end?): file with line numbers.
- edit(path, old_string, new_string, replace_all?) or edit(path, edits: [{old_string,new_string}]): exact replacement; old_string must match exactly one place (copy it from read, without the line numbers). Shows the diff; a backup is kept.
- apply_patch(patch, dry_run?): multi-file change as a unified diff or "*** Begin Patch / *** Update File: path / @@ / -old / +new / *** End Patch". Context is matched forgivingly; nothing is written unless every hunk applies. Deleting files asks the user.
- run_tests(filter?: file or test name), typecheck(path?), lint(path?), build: runs the project's own command (or command) with live progress and returns the failures as file:line + message and a suggested next step. timeout in seconds.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['project', 'search', 'symbols', 'read', 'edit', 'apply_patch', 'run_tests', 'typecheck', 'lint', 'build'] },
        dir: { type: 'string', description: 'Project folder (default: the attached/project folder, else the workspace)' },
        pattern: { type: 'string', description: 'search: regex (JavaScript syntax), or plain text with literal: true' },
        literal: { type: 'boolean' },
        ignore_case: { type: 'boolean' },
        glob: { type: 'array', items: { type: 'string' }, description: 'search/symbols: file globs, "!glob" excludes' },
        context: { type: 'integer', minimum: 0, maximum: 10, description: 'search: lines around each match' },
        max_results: { type: 'integer', minimum: 1, maximum: 1000 },
        files_only: { type: 'boolean', description: 'search: list matching files with counts' },
        name: { type: 'string', description: 'symbols: name to find (case-insensitive; exact matches first)' },
        path: { type: 'string', description: 'File or folder, relative to dir' },
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
        edits: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'], additionalProperties: false } },
        patch: { type: 'string' },
        dry_run: { type: 'boolean', description: 'apply_patch: show the diff without writing' },
        filter: { type: 'string', description: 'run_tests: a test file/folder or test name' },
        command: { type: 'string', description: 'run_tests/typecheck/lint/build: use this command instead of the detected one' },
        timeout: { type: 'integer', minimum: 5, maximum: 1800, description: 'Seconds (default: tests and build 600, others 300)' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'search' } } }, then: { required: ['pattern'] } },
        { if: { properties: { action: { const: 'read' } } }, then: { required: ['path'] } },
        { if: { properties: { action: { const: 'edit' } } }, then: { required: ['path'], anyOf: [{ required: ['old_string', 'new_string'] }, { required: ['edits'] }] } },
        { if: { properties: { action: { const: 'apply_patch' } } }, then: { required: ['patch'] } }
      ]
    },
    async run(a, ctx) {
      const base = cwdFor(a.dir, ctx)
      switch (a.action) {
        case 'project': return project(base, ctx)
        case 'search': {
          const sub = a.path ? relTo(base, resolveIn(base, a.path, ctx)) : undefined
          const r = await searchCode(base, { pattern: a.pattern!, literal: a.literal, ignoreCase: a.ignore_case, globs: a.glob, context: a.context, maxResults: a.max_results, filesOnly: a.files_only, sub, signal: ctx.signal })
          return { text: `${formatSearch(r, { pattern: a.pattern!, filesOnly: a.files_only })}\n(searched ${base}${sub ? `/${sub}` : ''})`, display: `${r.matches} match${r.matches === 1 ? '' : 'es'} for ${a.pattern!.slice(0, 40)}` }
        }
        case 'symbols': {
          const sub = a.path ? relTo(base, resolveIn(base, a.path, ctx)) : undefined
          const r = await findSymbols(base, { name: a.name, sub, globs: a.glob, max: a.max_results, signal: ctx.signal })
          return { text: formatSymbols(r, a.name ? `"${a.name}"` : sub ?? base), display: `${r.total} definition${r.total === 1 ? '' : 's'}` }
        }
        case 'read': return readNumbered(base, a, ctx)
        case 'edit': return edit(base, a, ctx, o.getWorkspace())
        case 'apply_patch': return applyPatch(base, a, ctx, o.getWorkspace(), trash)
        default: {
          const kind = CHECKS[a.action]
          if (a.command && classify(a.command).why === 'system-level command') throw new Error('System-level commands are not run by SahilBot.')
          const info = detectProject(base)
          const specs: CommandSpec[] = a.command ? [{ command: a.command, tool: guessTool(a.command, kind), kind }]
            : kind === 'test' ? (info.test ? [info.test] : []) : kind === 'typecheck' ? info.typecheck : kind === 'lint' ? info.lint : info.build ? [info.build] : []
          if (!specs.length) {
            throw new Error(`No ${kind === 'test' ? 'test' : kind} setup found in ${base} (looked at package.json scripts, pyproject/pytest, Cargo, go.mod, Gradle, Maven, Swift${kind === 'typecheck' ? ', tsconfig, mypy, pyright' : kind === 'lint' ? ', ESLint, Ruff, Clippy' : ''}). Pass command explicitly, or check dir.`)
          }
          const timeoutMs = Math.min(a.timeout ?? (kind === 'test' || kind === 'build' ? 600 : 300), 1800) * 1000
          const parts: string[] = []
          let ok = true
          let problems = 0
          for (const spec of specs) {
            const r = await runCheck({ cwd: base, kind, spec, filter: a.filter, path: a.path, timeoutMs, signal: ctx.signal, progress: ctx.progress })
            parts.push(r.text)
            ok &&= r.ok
            problems += r.problems.filter((p) => p.severity === 'error').length
            if (r.stopped) break
          }
          const label = kind === 'test' ? 'tests' : kind
          return { text: parts.join('\n\n'), data: { passed: ok, problems, kind, directory: base }, verification: { passed: ok, criterion: `${label} in ${base}`, detail: parts.join('\n\n').slice(-4000) }, display: ok ? `${label} passed` : `${label} failed${problems ? ` · ${problems} problem${problems > 1 ? 's' : ''}` : ''}` }
        }
      }
    }
  }
}

async function project(base: string, ctx: Ctx): Promise<{ text: string; display: string }> {
  const info = detectProject(base)
  const lines = [`Project folder: ${base}`, `Kind: ${info.kinds.join(', ') || 'unknown (no package.json, pyproject, Cargo.toml, go.mod, Gradle, Maven or Package.swift at the top)'}`]
  if (info.packageManager) lines.push(`Package manager: ${info.packageManager}`)
  const scripts = Object.keys(info.scripts)
  if (scripts.length) lines.push(`Scripts: ${scripts.slice(0, 30).join(', ')}`)
  lines.push(`Tests: ${info.test?.command ?? 'none detected'}`)
  lines.push(`Type check: ${info.typecheck.map((c) => c.command).join(' ; ') || 'none detected'}`)
  lines.push(`Lint: ${info.lint.map((c) => c.command).join(' ; ') || 'none detected'}`)
  if (info.build) lines.push(`Build: ${info.build.command}`)
  if (await isGitRepo(base)) {
    try {
      const st = await gitStatus(base, ctx.signal)
      lines.push('', 'Git:', st.text)
      const log = await git(base, ['log', '--oneline', '-n', '5'], { signal: ctx.signal }).catch(() => '')
      if (log.trim()) lines.push('Recent commits:', log.trimEnd())
    } catch (e) { lines.push(`Git: ${(e as Error).message}`) }
  } else lines.push('', 'Git: not a git repository')
  try {
    const top = readdirSync(base, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') || /^\.(github|env\.example)$/.test(e.name)).filter((e) => !['node_modules', 'dist', 'out', 'build', 'target', '__pycache__'].includes(e.name))
    lines.push('', 'Top level:', top.slice(0, 60).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('  '))
  } catch { /* unreadable */ }
  for (const doc of ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md']) {
    if (existsSync(join(base, doc))) lines.push(`Project instructions in ${doc}: read it before changing code.`)
  }
  return { text: lines.join('\n'), display: info.kinds.length ? `${info.kinds.join('/')} project` : 'project info' }
}

function readNumbered(base: string, a: CodeArgs, ctx: Ctx): { text: string; display: string; path: string } {
  const full = resolveIn(base, a.path!, ctx)
  const shown = relTo(base, full)
  if (existsSync(full) && lstatSync(full).isDirectory()) {
    const entries = readdirSync(full, { withFileTypes: true }).filter((e) => e.name !== '.git' && e.name !== 'node_modules').slice(0, 400)
    return { text: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty folder)', display: `listed ${shown}`, path: full }
  }
  const text = readTextFile(full, shown)
  noteSeen(ctx.threadId, full)
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const total = lines.length
  const start = Math.max(1, a.start ?? 1)
  const defaultEnd = a.start || a.end ? total : Math.min(total, 800)
  const end = Math.min(total, a.end ?? (a.start ? start + 399 : defaultEnd))
  const width = String(end).length
  let body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}│ ${l.length > 2000 ? `${l.slice(0, 2000)} …` : l}`).join('\n')
  if (body.length > 80_000) body = `${body.slice(0, 80_000)}\n… [cut: read a smaller range]`
  const note = end < total ? `\n[lines ${start}-${end} of ${total}; read more with start=${end + 1}]` : start > 1 ? `\n[lines ${start}-${end} of ${total}]` : ''
  return { text: `${shown}\n${body || '(empty file)'}${note}`, display: `${basename(full)}${start > 1 || end < total ? ` ${start}-${end}` : ''}`, path: full }
}

function edit(base: string, a: CodeArgs, ctx: Ctx, workspace: string): { text: string; display: string; path: string } {
  const full = resolveIn(base, a.path!, ctx)
  const shown = relTo(base, full)
  if (!existsSync(full)) throw new Error(`No such file: ${shown}. To create a file use file_write (or apply_patch with "*** Add File").`)
  const before = readTextFile(full, shown)
  const edits = a.edits?.length ? a.edits : [{ old_string: a.old_string ?? '', new_string: a.new_string ?? '', replace_all: a.replace_all }]
  let content = before
  const notes: string[] = []
  let count = 0
  edits.forEach((e, i) => {
    try {
      const r = replaceExact(content, e.old_string, e.new_string, !!e.replace_all, shown)
      content = r.content
      count += r.count
      if (r.note) notes.push(`${edits.length > 1 ? `edit ${i + 1}: ` : ''}${r.note}`)
    } catch (err) {
      throw new Error(`${edits.length > 1 ? `Edit ${i + 1} of ${edits.length}: ` : ''}${(err as Error).message}${edits.length > 1 ? '\nNothing was changed.' : ''}`)
    }
  })
  backup(workspace, full)
  writeFileSync(full, content)
  noteSeen(ctx.threadId, full)
  const d = unifiedDiff(shown, before, content)
  return {
    text: `Edited ${full} (${count} replacement${count === 1 ? '' : 's'}, +${d.added} −${d.removed})${notes.length ? `\nNote: ${notes.join('; ')}` : ''}\n${clipDiff(d.text)}`,
    display: `edited ${basename(full)} (+${d.added} −${d.removed})`,
    path: full
  }
}

async function applyPatch(base: string, a: CodeArgs, ctx: Ctx, workspace: string, trash: (p: string) => Promise<void>): Promise<{ text: string; display: string; path?: string }> {
  const fps = parsePatch(a.patch!)
  type Planned = { op: 'add' | 'update' | 'delete'; full: string; shown: string; before: string | null; after: string | null; moveFull?: string; moveShown?: string; notes: string[] }
  const plan: Planned[] = []
  const seen = new Set<string>()
  for (const fp of fps) {
    const full = resolveIn(base, fp.path, ctx)
    const shown = relTo(base, full)
    if (seen.has(full)) throw new Error(`The patch changes ${shown} twice; merge those sections into one.`)
    seen.add(full)
    if (fp.op === 'add') {
      if (existsSync(full)) throw new Error(`${shown} already exists. Use "*** Update File: ${fp.path}" (or edit) to change it.`)
      const lines = fp.hunks.flatMap((h) => h.lines.filter((l) => l.t !== '-').map((l) => l.s))
      plan.push({ op: 'add', full, shown, before: null, after: lines.length ? `${lines.join('\n')}\n` : '', notes: [] })
    } else if (fp.op === 'delete') {
      if (!existsSync(full)) throw new Error(`Can't delete ${shown}: it doesn't exist.`)
      plan.push({ op: 'delete', full, shown, before: lstatSync(full).isDirectory() ? null : readTextFile(full, shown), after: null, notes: [] })
    } else {
      const before = readTextFile(full, shown)
      const r = fp.hunks.length ? applyHunks(before, fp.hunks, shown) : { content: before, notes: [] }
      const moveFull = fp.moveTo ? resolveIn(base, fp.moveTo, ctx) : undefined
      if (moveFull && existsSync(moveFull)) throw new Error(`Can't move ${shown} to ${fp.moveTo}: that file already exists.`)
      plan.push({ op: 'update', full, shown, before, after: r.content, moveFull, moveShown: moveFull ? relTo(base, moveFull) : undefined, notes: r.notes })
    }
  }
  const diffs = plan.map((p) => unifiedDiff(p.shown, p.before, p.after, 3, p.moveShown ?? p.shown))
  const added = diffs.reduce((n, d) => n + d.added, 0)
  const removed = diffs.reduce((n, d) => n + d.removed, 0)
  const notes = plan.flatMap((p) => p.notes)
  const summary = plan.map((p) => `${p.op === 'add' ? 'A' : p.op === 'delete' ? 'D' : p.moveShown ? 'R' : 'M'} ${p.shown}${p.moveShown ? ` → ${p.moveShown}` : ''}`).join('\n')
  const body = clipDiff(diffs.map((d) => d.text).filter(Boolean).join('\n'), 16_000)
  if (a.dry_run) return { text: `Patch preview (nothing written; +${added} −${removed}):\n${summary}${notes.length ? `\nNotes: ${notes.join('; ')}` : ''}\n${body}`, display: `patch preview: ${plan.length} file${plan.length > 1 ? 's' : ''}` }
  for (const p of plan) {
    if (p.op === 'add') {
      mkdirSync(dirname(p.full), { recursive: true })
      writeFileSync(p.full, p.after!)
    } else if (p.op === 'delete') {
      await trash(p.full)
    } else {
      backup(workspace, p.full)
      if (p.moveFull) {
        mkdirSync(dirname(p.moveFull), { recursive: true })
        renameSync(p.full, p.moveFull)
        writeFileSync(p.moveFull, p.after!)
      } else if (p.after !== p.before) writeFileSync(p.full, p.after!)
    }
  }
  return {
    text: `Applied the patch (+${added} −${removed}):\n${summary}${notes.length ? `\nNotes: ${notes.join('; ')}` : ''}${plan.some((p) => p.op === 'delete') ? '\nDeleted files went to the Trash.' : ''}\n${body}`,
    display: `patched ${plan.length} file${plan.length > 1 ? 's' : ''} (+${added} −${removed})`,
    path: plan.length === 1 && plan[0].op !== 'delete' ? (plan[0].moveFull ?? plan[0].full) : undefined
  }
}

// ------------------------------------------------------------------ git

export type GitArgs = {
  action: 'status' | 'diff' | 'log' | 'branch' | 'checkout' | 'add' | 'commit' | 'stash' | 'push' | 'pr' | 'pr_view' | 'pr_diff'
  dir?: string
  path?: string; staged?: boolean; ref?: string; stat?: boolean; n?: number
  name?: string; from?: string
  paths?: string[]
  message?: string
  /** Commit even though the secret scan flagged something (always asks the user). */
  allow_flagged?: boolean
  op?: 'push' | 'list' | 'pop' | 'apply'
  include_untracked?: boolean
  remote?: string
  title?: string; body?: string; base?: string; draft?: boolean
  pr?: string
}

const READ_GIT = new Set(['status', 'diff', 'log', 'pr_view', 'pr_diff'])

export function gitEffect(a: GitArgs): ToolEffect {
  if (READ_GIT.has(a.action)) return 'read'
  if (a.action === 'branch' && !a.name) return 'read'
  if (a.action === 'stash' && (a.op ?? 'push') === 'list') return 'read'
  if (a.action === 'push' || a.action === 'pr') return 'write_external'
  return 'write_local'
}

export function gitTool(): ToolDef<GitArgs> {
  // The last folder git ran in, so the approval card for a commit can show what is staged there.
  let lastDir: string | undefined
  const stagedStat = (dir: string | undefined): string => {
    if (!dir) return ''
    try {
      return execFileSync('git', ['diff', '--cached', '--stat', '--no-color'], { cwd: dir, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { return '' }
  }
  return {
    name: 'git',
    label: 'Git',
    core: false,
    group: 'Coding',
    effect: (a) => gitEffect(a),
    // Pushes and pull requests reach GitHub: Auto asks.
    consequential: (a) => a.action === 'push' || a.action === 'pr',
    hardStop: (a) => (a.action === 'commit' && a.allow_flagged ? 'committing changes the secret scan flagged as possible keys or passwords' : null),
    describe: (a) => {
      switch (a.action) {
        case 'commit': {
          const dir = a.dir && isAbsolute(a.dir) ? a.dir : lastDir
          const st = stagedStat(dir)
          return `Commit${a.paths?.length ? ` ${a.paths.join(', ')}` : ' the staged changes'}: "${(a.message ?? '').split('\n')[0].slice(0, 120)}"${st ? `\n${st.split('\n').slice(-12).join('\n')}` : ''}`
        }
        case 'push': return `Push ${a.name ?? 'the current branch'} to ${a.remote ?? 'origin'}`
        case 'pr': return `Open a pull request "${a.title}"${a.base ? ` into ${a.base}` : ''}${a.draft ? ' (draft)' : ''} on GitHub`
        case 'branch': return a.name ? `Create and switch to branch ${a.name}` : 'List branches'
        case 'checkout': return `Switch to branch ${a.name}`
        case 'add': return `Stage ${(a.paths ?? []).join(', ')}`
        case 'stash': return `git stash ${a.op ?? 'push'}`
        default: return `git ${a.action}`
      }
    },
    description: `Git for the project folder (default: the attached/project folder, else the workspace; dir to choose).
- status; diff(staged?, path?, ref?, stat?): unstaged and staged changes by default; log(n?, path?).
- branch(name?, from?): list, or create and switch; checkout(name): switch to an existing branch.
- add(paths: ["."] for everything); commit(message, paths?): stages paths if given, scans the staged diff for keys and passwords (refuses if found) and shows what was committed. Review the diff before committing.
- stash(op: push|list|pop|apply, message?, include_untracked?).
- push(remote?, name?): pushes the current branch and sets upstream; never forces. pr(title, body, base?, draft?): pushes if needed and opens a GitHub pull request (needs the gh CLI). pr_view(pr?) and pr_diff(pr?): read a PR (number or URL), e.g. one a Cursor agent opened.
History rewrites (reset --hard, rebase, force-push, amend) are not offered: if the user explicitly wants one, use run_command, which asks them first.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'diff', 'log', 'branch', 'checkout', 'add', 'commit', 'stash', 'push', 'pr', 'pr_view', 'pr_diff'] },
        dir: { type: 'string' },
        path: { type: 'string', description: 'diff/log: limit to this path' },
        staged: { type: 'boolean', description: 'diff: only staged (true) or only unstaged (false); default both' },
        ref: { type: 'string', description: 'diff: compare against this commit/branch (e.g. main, HEAD~1)' },
        stat: { type: 'boolean', description: 'diff: only the per-file summary' },
        n: { type: 'integer', minimum: 1, maximum: 200 },
        name: { type: 'string', description: 'branch/checkout: branch name; push: branch to push' },
        from: { type: 'string', description: 'branch: start point' },
        paths: { type: 'array', items: { type: 'string' } },
        message: { type: 'string', description: 'commit: summary line, blank line, then why' },
        allow_flagged: { type: 'boolean', description: 'commit: only when the user confirmed the flagged lines are not secrets' },
        op: { type: 'string', enum: ['push', 'list', 'pop', 'apply'] },
        include_untracked: { type: 'boolean' },
        remote: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        base: { type: 'string', description: 'pr: target branch (default: the repo default)' },
        draft: { type: 'boolean' },
        pr: { type: 'string', description: 'pr_view/pr_diff: PR number or URL (default: the current branch\'s PR)' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'checkout' } } }, then: { required: ['name'] } },
        { if: { properties: { action: { const: 'add' } } }, then: { required: ['paths'] } },
        { if: { properties: { action: { const: 'commit' } } }, then: { required: ['message'] } },
        { if: { properties: { action: { const: 'pr' } } }, then: { required: ['title', 'body'] } }
      ]
    },
    async run(a, ctx) {
      const dir = await gitRoot(cwdFor(a.dir, ctx), ctx.signal)
      lastDir = dir
      const sig = { signal: ctx.signal }
      // Paths given to git must stay inside the project's allowed folders.
      const safePaths = (ps: string[]): string[] => ps.map((p) => (p === '.' ? '.' : relTo(dir, resolveIn(dir, p, ctx))))
      switch (a.action) {
        case 'status': {
          const st = await gitStatus(dir, ctx.signal)
          return { text: `${dir}\n${st.text}`, display: st.clean ? 'clean' : `${st.staged + st.unstaged + st.untracked} changed` }
        }
        case 'diff': {
          const scope = a.path ? ['--', ...safePaths([a.path])] : []
          const stat = a.stat ? ['--stat'] : []
          const parts: string[] = []
          if (a.ref) parts.push(await git(dir, ['diff', ...stat, a.ref, ...scope], sig))
          else {
            if (a.staged !== false) { const s = await git(dir, ['diff', '--cached', ...stat, ...scope], sig); if (s.trim()) parts.push(`# Staged\n${s.trimEnd()}`) }
            if (a.staged !== true) { const u = await git(dir, ['diff', ...stat, ...scope], sig); if (u.trim()) parts.push(`# Not staged\n${u.trimEnd()}`) }
            if (a.staged === undefined) {
              const un = (await git(dir, ['ls-files', '--others', '--exclude-standard', ...scope], sig)).trim()
              if (un) parts.push(`# Untracked (not in the diff)\n${un.split('\n').slice(0, 50).join('\n')}`)
            }
          }
          const text = parts.join('\n\n').trim()
          return { text: text ? clip(text, 40_000) : 'No changes.', display: text ? 'diff' : 'no changes' }
        }
        case 'log': {
          const out = await git(dir, ['log', `-n${a.n ?? 15}`, '--date=short', '--format=%h %ad %an%d  %s', ...(a.path ? ['--', ...safePaths([a.path])] : [])], sig)
          return { text: out.trim() || 'No commits yet.', display: `${out.trim().split('\n').filter(Boolean).length} commits` }
        }
        case 'branch': {
          if (!a.name) {
            const out = await git(dir, ['branch', '-vv', '--no-color'], sig)
            return { text: out.trim() || 'No branches yet (no commits).', display: 'branches' }
          }
          const name = checkBranchName(a.name)
          await git(dir, ['switch', '-c', name, ...(a.from ? [a.from] : [])], sig)
          return { text: `Created and switched to ${name}${a.from ? ` (from ${a.from})` : ''}. Uncommitted changes came along.`, display: `on ${name}` }
        }
        case 'checkout': {
          const name = checkBranchName(a.name!)
          try { await git(dir, ['switch', name], sig) } catch (e) {
            throw new Error(`${(e as Error).message}\nGit refused so nothing is lost. Commit or stash (git stash) the changes first, or create a branch with git(action="branch").`)
          }
          return { text: `Switched to ${name}.\n${(await gitStatus(dir, ctx.signal)).text}`, display: `on ${name}` }
        }
        case 'add': {
          const ps = safePaths(a.paths!)
          await git(dir, ['add', '-A', '--', ...ps], sig)
          const st = await git(dir, ['diff', '--cached', '--stat'], sig)
          return { text: `Staged ${ps.join(', ')}.\n${st.trim() || '(nothing staged)'}`, display: `staged ${ps.length} path${ps.length > 1 ? 's' : ''}` }
        }
        case 'commit': {
          const msg = (a.message ?? '').trim()
          if (!msg) throw new Error('A commit message is required: a short summary line, then a blank line and why.')
          if (a.paths?.length) await git(dir, ['add', '-A', '--', ...safePaths(a.paths)], sig)
          const staged = await git(dir, ['diff', '--cached', '--no-ext-diff', '-U0'], { ...sig, timeoutMs: 60_000 })
          if (!staged.trim()) throw new Error('Nothing is staged. Stage files with git(action="add", paths=[…]) or pass paths.')
          const findings = scanDiffForSecrets(staged)
          if (findings.length && !a.allow_flagged) {
            throw new Error(`Not committed: the staged changes look like they contain secrets:\n${formatFindings(findings)}\nRemove them (use environment variables or an ignored config file), unstage with run_command "git restore --staged <file>", and add the file to .gitignore. If the user confirms these are not secrets, retry with allow_flagged: true (it asks them).`)
          }
          const stat = await git(dir, ['diff', '--cached', '--stat'], sig)
          await git(dir, ['commit', '-F', '-'], { ...sig, input: `${msg}\n`, timeoutMs: 120_000 })
          const head = (await git(dir, ['log', '-1', '--format=%h %s'], sig)).trim()
          const branch = await currentBranch(dir, ctx.signal)
          return { text: `Committed ${head}${branch ? ` on ${branch}` : ''}:\n${stat.trimEnd()}${findings.length ? `\n(The user approved committing ${findings.length} flagged line${findings.length > 1 ? 's' : ''}.)` : ''}`, display: `committed ${head.split(' ')[0]}` }
        }
        case 'stash': {
          const op = a.op ?? 'push'
          if (op === 'list') return { text: (await git(dir, ['stash', 'list'], sig)).trim() || 'No stashes.', display: 'stash list' }
          if (op === 'push') {
            const out = await git(dir, ['stash', 'push', ...(a.include_untracked ? ['--include-untracked'] : []), ...(a.message ? ['-m', a.message] : [])], sig)
            return { text: `${out.trim()}\nRestore with git(action="stash", op="pop").`, display: 'stashed' }
          }
          const out = await git(dir, ['stash', op], sig)
          return { text: out.trim() || `stash ${op} done`, display: `stash ${op}` }
        }
        case 'push': {
          const branch = a.name ? checkBranchName(a.name) : await currentBranch(dir, ctx.signal)
          if (!branch) throw new Error('Not on a branch (detached HEAD). Create one with git(action="branch", name).')
          const remote = a.remote ?? 'origin'
          const out = await runPush(dir, remote, branch, ctx)
          return { text: out, display: `pushed ${branch}` }
        }
        case 'pr': {
          if (!ghInstalled()) throw new Error('Opening a pull request needs the GitHub CLI (gh). The user can install it with "brew install gh" and sign in with "gh auth login"; or push and open the PR on github.com.')
          const branch = await currentBranch(dir, ctx.signal)
          if (!branch) throw new Error('Not on a branch (detached HEAD).')
          const pushed = (await upstreamOf(dir, ctx.signal)) ? '' : `${await runPush(dir, 'origin', branch, ctx)}\n`
          const url = (await gh(dir, ['pr', 'create', '--title', a.title!, '--body-file', '-', '--head', branch, ...(a.base ? ['--base', a.base] : []), ...(a.draft ? ['--draft'] : [])], { ...sig, input: a.body ?? '' })).trim()
          return { text: `${pushed}Opened ${a.draft ? 'draft ' : ''}pull request: ${url.split('\n').pop()}`, display: 'opened PR' }
        }
        case 'pr_view': {
          const out = await gh(dir, ['pr', 'view', ...(a.pr ? [a.pr] : []), '--json', 'number,title,state,url,author,headRefName,baseRefName,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,files,body'], sig)
          return { text: formatPr(out), display: 'PR details' }
        }
        case 'pr_diff': {
          const out = await gh(dir, ['pr', 'diff', ...(a.pr ? [a.pr] : []), '--color', 'never'], { ...sig, timeoutMs: 90_000 })
          return { text: clip(out.trim() || 'Empty diff.', 60_000), display: 'PR diff' }
        }
      }
    }
  }
}

async function runPush(dir: string, remote: string, branch: string, ctx: Ctx): Promise<string> {
  const remotes = (await git(dir, ['remote'], { signal: ctx.signal })).split('\n').map((r) => r.trim()).filter(Boolean)
  if (!remotes.includes(remote)) throw new Error(`No remote named "${remote}"${remotes.length ? ` (remotes: ${remotes.join(', ')})` : ' (this repo has no remotes)'}.`)
  // Never --force: a rejected push means the remote has commits we don't; pull/rebase is the user's call.
  try {
    await git(dir, ['push', '-u', remote, `${branch}:${branch}`], { signal: ctx.signal, timeoutMs: 120_000 })
  } catch (e) {
    const m = (e as Error).message
    if (/rejected|non-fast-forward|fetch first/i.test(m)) throw new Error(`The push was rejected: ${remote}/${branch} has commits this branch doesn't. Ask the user whether to pull (merge or rebase) first. Never force-push without their explicit say-so.`)
    throw e
  }
  return `Pushed ${branch} to ${remote} (upstream set).`
}

function formatPr(json: string): string {
  try {
    const p = JSON.parse(json)
    const checks = (p.statusCheckRollup ?? []) as Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string }>
    const files = (p.files ?? []) as Array<{ path: string; additions: number; deletions: number }>
    return [
      `#${p.number} ${p.title} (${p.state}) by ${p.author?.login ?? '?'}: ${p.headRefName} → ${p.baseRefName}`,
      p.url,
      `+${p.additions} −${p.deletions} in ${p.changedFiles} files${p.reviewDecision ? ` · review: ${p.reviewDecision}` : ''}`,
      ...(checks.length ? ['Checks:', ...checks.map((c) => `- ${c.name ?? c.context}: ${c.conclusion || c.state || c.status}`)] : []),
      ...(files.length ? ['Files:', ...files.slice(0, 60).map((f) => `- ${f.path} (+${f.additions} −${f.deletions})`)] : []),
      ...(p.body ? ['', clip(String(p.body), 4000)] : [])
    ].join('\n')
  } catch {
    return clip(json, 20_000)
  }
}
