import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ToolEffect } from '@shared/types'
import { runProcess, stripAnsi, throttle, toolEnv, type SandboxSpec } from '../../code/proc'
import { jobLine, jobs as defaultJobs, type JobManager, type WaitFor } from '../../jobs/manager'
import type { ThreadState, ToolContext, ToolDef } from '../types'
import { inForbidden, isSecretName } from '../../knowledge/ignore'

// Run a terminal command. What it can do decides who must approve it:
// - looks only (ls, cat, git status, grep…): runs freely;
// - a KNOWN local build / test / VCS / file tool (make, tsc, vitest, git commit, mkdir…, a script file in
//   your folders, a package.json script that exists): runs in Auto, asks in Ask;
// - anything else (unknown programs, network tools, installs, package runners like npx, inline code like
//   python -c / node -e / sh -c, background processes): asks in Ask and Auto;
// - deletes or rewrites history (rm, git reset --hard…): always asks, even in Bypass;
// - system-level (sudo, launchctl, defaults write, disk tools, chmod outside your folders…): refused.
//
// Every segment of a chained command is classified on its own (most severe wins), after normalizing it:
// the basename of the program (/usr/bin/curl is curl), leading backslashes and quotes stripped, wrappers
// (command, env, exec, xargs, nohup, time, nice, caffeinate, timeout) unwrapped, git's global options
// skipped before its subcommand.
//
// Background jobs (background: true): a dev server, watcher or long build keeps running after the call
// returns, managed by the JobManager (src/main/jobs). Starting one needs the same approval as running
// the command. "&", nohup, setsid, screen -d and tmux new -d ask: background work goes through jobs.
//
// Auto mode: a command made only of `cd` into your folders and project steps (npm ci / npm install
// / pnpm install / yarn install from the project's committed, unmodified lockfile; git fetch / git pull
// from the origin recorded when the folder was first seen) is a "project command": Auto runs it,
// Auto asks. A command that writes to paths outside the workspace and attached folders counts as acting
// outside this Mac's folders (asks in Ask and Auto), and commands run under a macOS sandbox that
// refuses such writes unless the user approved the command (code/proc.ts, advanced.sandboxCommands).

type Args = { command: string; cwd?: string; timeout?: number; background?: boolean; wait_for?: WaitFor }

const SEVERITY: Record<ToolEffect, number> = { read: 0, write_local: 1, write_external: 2, destructive: 3 }
type Verdict = { effect: ToolEffect; why: string }
const READ: Verdict = { effect: 'read', why: 'only looks' }
const LOCAL: Verdict = { effect: 'write_local', why: 'may change files in your folders' }
const ext = (why: string): Verdict => ({ effect: 'write_external', why })
const UNKNOWN = ext('runs a program SahilBot doesn\'t know (it may reach the internet or change things outside your folders)')
const NETWORK = ext('reaches outside this Mac or installs software')
const INLINE = ext('runs inline code (python -c, node -e, sh -c…), which can do anything')
const RUNNER = ext('downloads and runs a package (npx, dlx, bunx, uvx…)')
const BACKGROUND = ext('starts a process that keeps running in the background (use background: true instead)')
const ENV_CHANGE = ext('sets an environment variable that can change what runs')
const worse = (a: Verdict, b: Verdict): Verdict => (SEVERITY[b.effect] > SEVERITY[a.effect] ? b : a)
const atLeastLocal = (v: Verdict): Verdict => worse(v, LOCAL)

const RM = /(^|[\s;&|(/\\"'`])(rm|rmdir|unlink|shred|trash|srm)["']?(\s|$)/
const TRUNCATE = /(^|[;(\n]|&&|\|\||[&|]\s)\s*(:|true|cat\s+\/dev\/null|echo\s+-n|printf\s+(''|""))?\s*>\|?\s*(?!&|\/dev\/null\b)[^\s>]|\bcp\s+\/dev\/null\s|\bmv\s.*\s\/dev\/null\b|\btruncate\s/
const GIT_DISCARD = /git\s+(reset\s+--hard|clean\b[^;&|\n]*\s-(-force|[a-zA-Z]*f)|push\b[^;&|\n]*\s(-f|--force)|branch\s+(-D|--delete\s+--force)|checkout\b[^;&|\n]*(\s--(\s|$)|\s\.(\s|$)|\s-f\b|\s--force\b)|restore\b(?![^;&|\n]*(--staged|\s-S\b))|restore\b[^;&|\n]*(--worktree|\s-W\b)|stash\s+(drop|clear))/
const DELETES = /find\s.*-delete|>\s*\/dev\/(disk|rdisk)/
const SYSTEM = /(^|[\s;&|(])(sudo|su|doas|dd|mkfs|diskutil|fdisk|shutdown|reboot|halt|launchctl|csrutil|spctl|systemsetup|networksetup|pmset|defaults\s+write|chown\s+-R\s+\/|chmod\s+-R\s+[0-7]*\s+\/(\s|$)|nvram|kextload|tccutil)\b|:\(\)\s*\{|rm\s+-rf?\s+(\/|~)\s*$/
/** System-level programs, matched by basename after unwrapping (so /usr/bin/sudo and \sudo count). */
const SYSTEM_NAMES = new Set(['sudo', 'su', 'doas', 'dd', 'diskutil', 'fdisk', 'gpt', 'newfs_apfs', 'newfs_hfs', 'asr', 'shutdown', 'reboot', 'halt', 'launchctl', 'csrutil', 'spctl',
  'systemsetup', 'networksetup', 'pmset', 'nvram', 'kextload', 'kextunload', 'kmutil', 'tccutil', 'security', 'dscl', 'dseditgroup', 'sysadminctl', 'pwpolicy', 'fdesetup', 'profiles',
  'bless', 'softwareupdate', 'installer', 'scutil', 'sfltool', 'tmutil', 'mdutil', 'visudo', 'chsh', 'passwd', 'crontab', 'at', 'periodic', 'pfctl', 'socketfilterfw', 'mount', 'umount'])

/** Read-only uses of otherwise system-level programs. */
const SYSTEM_READS: Record<string, RegExp> = { security: /^(find-identity|find-certificate|list-keychains|show-keychain-info|verify-cert|cms|default-keychain|login-keychain)$/, scutil: /^(--get|--dns|--proxy|--nwi)$/, mount: /^$/, tmutil: /^(status|listbackups|latestbackup|destinationinfo|version)$/ }

const deletes = (c: string): boolean => RM.test(c) || TRUNCATE.test(c) || GIT_DISCARD.test(c) || DELETES.test(c)

// ---------- parsing: segments, words, redirections ----------

/** One simple command and the operator after it ('&&', '||', ';', '|', '&', or '' at the end). */
export interface Segment { text: string; sep: string }

/** The end of a $( … ) or `…` starting at `i` (index after it), skipping quotes inside; -1 when unbalanced. */
function skipSubst(s: string, i: number): number {
  if (s[i] === '`') {
    for (let j = i + 1; j < s.length; j++) { if (s[j] === '\\') j++; else if (s[j] === '`') return j + 1 }
    return -1
  }
  let depth = 0
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j]
    if (ch === '\\') { j++; continue }
    if (ch === "'") { const k = s.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue }
    if (ch === '"') { for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++; continue }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return j + 1 }
  }
  return -1
}

/** Splits a command line on && || ; | & and newlines, outside quotes and substitutions. */
export function splitCommand(cmd: string): Segment[] {
  const out: Segment[] = []
  let cur = ''
  const push = (sep: string): void => { out.push({ text: cur.trim(), sep }); cur = '' }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\') { cur += ch + (cmd[i + 1] ?? ''); i++; continue }
    if (ch === "'") { const k = cmd.indexOf("'", i + 1); const end = k < 0 ? cmd.length : k; cur += cmd.slice(i, end + 1); i = end; continue }
    if (ch === '"') {
      let j = i + 1
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\') j++
        else if ((cmd[j] === '$' && cmd[j + 1] === '(') || cmd[j] === '`') { const e = skipSubst(cmd, cmd[j] === '`' ? j : j + 1); if (e < 0) { j = cmd.length; break } j = e - 1 }
      }
      cur += cmd.slice(i, j + 1); i = j; continue
    }
    if ((ch === '$' || ch === '<' || ch === '>') && cmd[i + 1] === '(') { const e = skipSubst(cmd, i + 1); const end = e < 0 ? cmd.length : e; cur += cmd.slice(i, end); i = end - 1; continue }
    if (ch === '`') { const e = skipSubst(cmd, i); const end = e < 0 ? cmd.length : e; cur += cmd.slice(i, end); i = end - 1; continue }
    if (ch === '\n' || ch === '\r') { push(';'); continue }
    if (ch === ';') { push(cmd[i + 1] === ';' ? ';;' : ';'); if (cmd[i + 1] === ';') i++; continue }
    if (ch === '|') {
      if (cmd[i + 1] === '|') { push('||'); i++; continue }
      if (/>$/.test(cur)) { cur += ch; continue } // >| (clobber) is a redirection
      push('|'); if (cmd[i + 1] === '&') i++
      continue
    }
    if (ch === '&') {
      if (cmd[i + 1] === '&') { push('&&'); i++; continue }
      // &> &>> (redirect both), >& <& (fd duplication) are redirections, not background.
      if (cmd[i + 1] === '>' || /[<>]$/.test(cur)) { cur += ch; continue }
      push('&'); continue
    }
    cur += ch
  }
  if (cur.trim()) push('')
  return out.filter((s) => s.text || s.sep === '&')
}

/** The inner text of every $( … ), `…`, <( … ) and >( … ) in a command (they run code wherever they appear). */
export function substitutions(cmd: string): string[] {
  const out: string[] = []
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\') { i++; continue }
    if (ch === "'") { const k = cmd.indexOf("'", i + 1); if (k < 0) break; i = k; continue }
    if ((ch === '$' || ch === '<' || ch === '>') && cmd[i + 1] === '(') {
      if (cmd[i + 2] === '(') continue // $(( arithmetic ))
      const e = skipSubst(cmd, i + 1)
      if (e < 0) { out.push(cmd.slice(i + 2)); break }
      out.push(cmd.slice(i + 2, e - 1)); i = e - 1; continue
    }
    if (ch === '`') {
      const e = skipSubst(cmd, i)
      if (e < 0) { out.push(cmd.slice(i + 1)); break }
      out.push(cmd.slice(i + 1, e - 1)); i = e - 1
    }
  }
  return out
}

interface Words { argv: string[]; redirs: Array<{ op: string; target: string }> }

/** Shell-like words of one segment: quotes removed, backslash escapes applied, redirections taken out. */
export function words(seg: string): Words {
  const argv: string[] = []
  const redirs: Words['redirs'] = []
  let cur = ''
  let has = false
  let pendingOp: string | null = null
  const end = (): void => {
    if (!has) return
    if (pendingOp !== null) { redirs.push({ op: pendingOp, target: cur }); pendingOp = null } else argv.push(cur)
    cur = ''; has = false
  }
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]
    if (/\s/.test(ch)) { end(); continue }
    if (ch === '\\') { cur += seg[i + 1] ?? ''; i++; has = true; continue }
    if (ch === "'") { const k = seg.indexOf("'", i + 1); const e = k < 0 ? seg.length : k; cur += seg.slice(i + 1, e); i = e; has = true; continue }
    if (ch === '"') {
      let j = i + 1
      for (; j < seg.length && seg[j] !== '"'; j++) { if (seg[j] === '\\' && /["\\$`]/.test(seg[j + 1] ?? '')) j++; cur += seg[j] }
      i = j; has = true; continue
    }
    if ((ch === '$' || ch === '<' || ch === '>') && seg[i + 1] === '(') {
      const e = skipSubst(seg, i + 1); const stop = e < 0 ? seg.length : e
      cur += seg.slice(i, stop); i = stop - 1; has = true; continue
    }
    if (ch === '`') { const e = skipSubst(seg, i); const stop = e < 0 ? seg.length : e; cur += seg.slice(i, stop); i = stop - 1; has = true; continue }
    if (ch === '>' || ch === '<') {
      // An fd number or & right before it belongs to the operator: 2> &> 2>&1.
      let op = ''
      if (has && /^(\d+|&)$/.test(cur)) { op = cur; cur = ''; has = false }
      end()
      op += ch
      while (/[<>|&]/.test(seg[i + 1] ?? '') && op.length < 4) { op += seg[i + 1]; i++ }
      // >&2, 2>&1: duplicating a file descriptor writes no file.
      if (/[<>]&$/.test(op) && /^\d+$|^-$/.test(seg.slice(i + 1).match(/^\S*/)![0])) {
        const m = seg.slice(i + 1).match(/^\S*/)![0]; i += m.length; continue
      }
      pendingOp = op; continue
    }
    cur += ch; has = true
  }
  end()
  if (pendingOp !== null) redirs.push({ op: pendingOp, target: '' })
  return { argv, redirs }
}

const isOutputRedir = (op: string): boolean => /[>]/.test(op) && !/^<+$/.test(op)

// ---------- normalizing: wrappers, environment, program name ----------

/** Environment variables a command may set inline without changing what code runs. */
const SAFE_ENV = /^(PATH|NODE_ENV|CI|DEBUG|FORCE_COLOR|NO_COLOR|TERM|PORT|HOST|TZ|LANG|LANGUAGE|LC_[A-Z]+|RUST_BACKTRACE|RUST_LOG|CARGO_TERM_COLOR|CGO_ENABLED|GOOS|GOARCH|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|PYTHONPATH|PYTHONHASHSEED|BROWSER|NODE_NO_WARNINGS|NEXT_TELEMETRY_DISABLED|HUSKY|LOG_LEVEL|VERBOSE|COLUMNS|LINES|SOURCE_DATE_EPOCH|(VITE|NEXT_PUBLIC|REACT_APP|EXPO_PUBLIC|VITEST|JEST)_[A-Z0-9_]+)$/
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/

interface Normalized { argv: string[]; bg: boolean; verdict?: Verdict; system?: string }

const progName = (s: string): string => basename(s.replace(/^\\+/, '').replace(/^["']+|["']+$/g, ''))

/** Strips assignments and wrappers (command, env, exec, xargs, nohup, time, nice, caffeinate, timeout, arch). */
export function normalize(argv0: string[]): Normalized {
  let argv = [...argv0]
  let bg = false
  let verdict: Verdict | undefined
  const take = (v: Verdict): void => { verdict = verdict ? worse(verdict, v) : v }
  for (let guard = 0; guard < 12 && argv.length; guard++) {
    while (argv.length && ASSIGN.test(argv[0])) { if (!SAFE_ENV.test(ASSIGN.exec(argv[0])![1])) take(ENV_CHANGE); argv.shift() }
    while (argv.length && ['!', '{', '(', 'then', 'do', 'else', 'if', 'elif', 'while', 'until'].includes(argv[0])) argv.shift()
    if (!argv.length) break
    const name = progName(argv[0])
    if (SYSTEM_NAMES.has(name) && !SYSTEM_READS[name]?.test(argv[1] ?? '')) return { argv, bg, verdict, system: name }
    if (name === 'command' || name === 'builtin') {
      argv.shift()
      while (argv[0]?.startsWith('-')) { if (/^-[a-zA-Z]*[vV]/.test(argv[0])) return { argv: ['type'], bg, verdict }; argv.shift() }
      continue
    }
    if (name === 'exec') { argv.shift(); while (argv[0]?.startsWith('-')) { if (argv[0] === '-a') argv.shift(); argv.shift() } continue }
    if (name === 'env') {
      argv.shift()
      for (;;) {
        const a = argv[0]
        if (a === undefined) break
        if (/^-[i0v]+$|^--(ignore-environment|null|debug)$/.test(a)) argv.shift()
        else if (a === '-u' || a === '--unset') argv.splice(0, 2)
        else if (/^(-S|--split-string|-C|--chdir|-P)/.test(a)) { take(INLINE); argv.shift() }
        else if (ASSIGN.test(a)) { if (!SAFE_ENV.test(ASSIGN.exec(a)![1])) take(ENV_CHANGE); argv.shift() }
        else break
      }
      if (!argv.length) return { argv: ['printenv'], bg, verdict }
      continue
    }
    if (name === 'nohup' || name === 'setsid' || name === 'disown' || name === 'daemonize') { bg = true; argv.shift(); continue }
    if (name === 'time') { argv.shift(); while (argv[0] === '-p' || argv[0] === '-l') argv.shift(); continue }
    if (name === 'nice') { argv.shift(); while (argv[0]?.startsWith('-')) { if (argv[0] === '-n') argv.shift(); argv.shift() } continue }
    if (name === 'caffeinate') { argv.shift(); while (argv[0]?.startsWith('-')) { if (argv[0] === '-t' || argv[0] === '-w') argv.shift(); argv.shift() } continue }
    if (name === 'timeout' || name === 'gtimeout') {
      argv.shift()
      while (argv[0]?.startsWith('-')) { if (argv[0] === '-s' || argv[0] === '-k' || argv[0] === '--signal' || argv[0] === '--kill-after') argv.shift(); argv.shift() }
      argv.shift() // the duration
      continue
    }
    if (name === 'arch') { argv.shift(); while (argv[0]?.startsWith('-')) { if (argv[0] === '-e') argv.shift(); argv.shift() } continue }
    if (name === 'stdbuf') { argv.shift(); while (argv[0]?.startsWith('-')) argv.shift(); continue }
    if (name === 'xargs') {
      argv.shift()
      while (argv[0]?.startsWith('-')) {
        const f = argv.shift()!
        if (/^-[nLIJsPEdR]$/.test(f) || /^--(max-args|max-lines|replace|max-chars|max-procs|eof|delimiter|arg-file)$/.test(f)) argv.shift()
      }
      if (!argv.length) return { argv: ['echo'], bg, verdict }
      continue
    }
    if (name === 'screen' && argv.slice(1).some((a) => /^-[a-zA-Z]*[dD]/.test(a))) bg = true
    if (name === 'tmux' && /^(new|new-session|new-window|neww|split-window|splitw)$/.test(argv[1] ?? '') && argv.slice(2).some((a) => /^-[a-zA-Z]*d/.test(a))) bg = true
    break
  }
  return { argv, bg, verdict }
}

// ---------- classifying one command ----------

export interface ClassifyContext {
  /** Folder the command starts in (the run_command cwd). */
  cwd?: string
  /** The workspace, attached folders and project folder: where files may be run or written. */
  allowed?: string[]
}

interface SegCtx { cwd: string | null; allowed: string[]; known: boolean }

const realish = (p: string): string => {
  let probe = p
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try { return join(realpathSync(probe), relative(probe, p)) } catch { return p }
}
const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
const HOME = homedir()

/** A file argument (a script to run) that resolves inside your folders. */
function insideFile(arg: string | undefined, c: SegCtx): boolean {
  if (!arg || arg === '-' || /[$`]/.test(arg) || /^~/.test(arg) || /^[a-z][a-z0-9+.-]*:/i.test(arg)) return false
  if (!c.known) return !isAbsolute(arg) && !arg.split('/').includes('..')
  if (c.cwd === null && !isAbsolute(arg)) return false
  const full = realish(isAbsolute(arg) ? resolve(arg) : resolve(c.cwd!, arg))
  return c.allowed.some((r) => within(realish(resolve(r)), full))
}

/** The nearest package.json's scripts (walking up from cwd while inside your folders). */
function scriptsAt(c: SegCtx): Record<string, string> | null {
  if (!c.known || c.cwd === null) return null
  const roots = c.allowed.map((r) => realish(resolve(r)))
  for (let d = realish(c.cwd); roots.some((r) => within(r, d)); d = dirname(d)) {
    const p = join(d, 'package.json')
    if (existsSync(p)) {
      try { const s = (JSON.parse(readFileSync(p, 'utf8')) as { scripts?: Record<string, string> }).scripts; return s && typeof s === 'object' ? s : {} } catch { return {} }
    }
    if (dirname(d) === d) break
  }
  return null
}

/** `script` runs a package.json script: local when it exists (it runs project code, the point of autonomy). */
function script(name: string | undefined, c: SegCtx, explicit: boolean): Verdict {
  if (!name) return READ // "npm run" alone lists the scripts
  if (!c.known) return explicit ? { effect: 'write_local', why: `runs the project's "${name}" script` } : UNKNOWN
  const s = scriptsAt(c)
  if (s && typeof s[name] === 'string') return { effect: 'write_local', why: `runs the project's "${name}" script (project code)` }
  return ext(`"${name}" is not a script in this project's package.json`)
}

const READ_NAMES = new Set(['ls', 'll', 'pwd', 'cat', 'head', 'tail', 'more', 'wc', 'file', 'stat', 'du', 'df', 'which', 'whereis', 'type', 'echo', 'printf', 'date', 'cal', 'uname',
  'whoami', 'id', 'printenv', 'grep', 'egrep', 'fgrep', 'ag', 'cut', 'tr', 'diff', 'cmp', 'comm', 'jq', 'sw_vers', 'system_profiler', 'ps', 'lsof', 'md5', 'shasum', 'sha1sum', 'sha256sum',
  'md5sum', 'cksum', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'column', 'fold', 'paste', 'join', 'expand', 'unexpand', 'rev', 'tac', 'seq', 'true', 'false', 'test', '[', '[[', ']]',
  'sleep', 'pushd', 'popd', 'dirs', 'exit', 'return', 'wait', 'hash', 'mdfind', 'mdls', 'hexdump', 'od', 'strings', 'otool', 'nm', 'pbpaste', 'fi', 'done', 'esac', '}', ')', ':', 'for',
  'unset', 'shift', 'getopts', 'read', 'tput', 'uptime', 'hostname', 'locale', 'groups', 'w', 'who', 'last', 'vm_stat', 'iostat', 'xxd', 'man', 'apropos', 'whatis'])
/** Known local tools: builds, compilers, linters, test runners, file utilities. They change files in your folders. */
const LOCAL_NAMES = new Set(['mkdir', 'cp', 'mv', 'touch', 'ln', 'chmod', 'chown', 'chgrp', 'chflags', 'tee', 'patch', 'install', 'ditto', 'make', 'gmake', 'cmake', 'ninja', 'meson', 'ctest',
  'swiftc', 'clang', 'clang++', 'gcc', 'g++', 'cc', 'c++', 'ld', 'ar', 'ranlib', 'rustc', 'javac', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'pytest', 'py.test', 'mocha', 'ruff', 'black',
  'isort', 'mypy', 'pyright', 'flake8', 'pylint', 'gofmt', 'rustfmt', 'clang-format', 'shellcheck', 'stylelint', 'biome', 'oxlint', 'electron-vite', 'vite', 'webpack', 'rollup', 'esbuild',
  'pbcopy', 'say', 'afplay', 'sips', 'screencapture', 'xattr', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', 'zstd', 'unzstd', 'textutil', 'iconv', 'split', 'csplit', 'mktemp',
  'electron-builder', 'playwright-test', 'tsc-watch', 'vue-tsc', 'svelte-check', 'astro', 'next', 'nuxt', 'remix', 'storybook', 'lint-staged', 'tailwindcss', 'postcss', 'sass', 'lessc'])
const NET_NAMES = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'tftp', 'telnet', 'nslookup', 'dig', 'host', 'ping', 'ping6', 'traceroute',
  'whois', 'gh', 'vercel', 'netlify', 'heroku', 'fly', 'flyctl', 'aws', 'gcloud', 'az', 'docker', 'podman', 'kubectl', 'helm', 'terraform', 'pip', 'pip3', 'pipx', 'uv', 'uvx', 'brew',
  'gem', 'bundle', 'port', 'conda', 'mamba', 'open', 'osascript', 'mail', 'sendmail', 'nmap', 'httpie', 'http', 'https', 'aria2c', 'lynx', 'links', 'w3m', 'networkQuality', 'npx', 'bunx'])
const INLINE_FLAGS: Record<string, RegExp> = {
  ruby: /^-[a-zA-Z]*e/, perl: /^-[a-zA-Z]*[eE]/, php: /^-[a-zA-Z]*r/, tsx: /^(-e|--eval|-p|--print)$/, 'ts-node': /^(-e|--eval|-p|--print)$/, esno: /^(-e|--eval)$/, lua: /^-e/, Rscript: /^-e/
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh'])
const PY_MODULES = new Set(['pytest', 'unittest', 'mypy', 'black', 'ruff', 'isort', 'flake8', 'pylint', 'pyright', 'compileall', 'py_compile', 'venv', 'doctest', 'coverage', 'json.tool', 'tabnanny', 'pyclbr', 'timeit', 'cProfile', 'pdb'])

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'describe', 'shortlog', 'grep', 'help', 'version', '--version', 'count-objects',
  'rev-list', 'name-rev', 'merge-base', 'for-each-ref', 'show-ref', 'whatchanged', 'check-ignore', 'check-attr', 'show-branch', 'range-diff', 'annotate', 'cherry', 'var'])
const GIT_LOCAL = new Set(['add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'tag', 'branch', 'init', 'mv', 'rm', 'apply', 'am',
  'format-patch', 'bisect', 'clean', 'gc', 'fsck', 'prune', 'repack', 'worktree', 'notes', 'commit-tree', 'update-index', 'symbolic-ref', 'checkout-index', 'read-tree', 'write-tree', 'archive',
  'bundle', 'sparse-checkout', 'mktree', 'hash-object', 'pack-refs', 'reflog', 'maintenance'])

function classifyGit(args: string[], c: SegCtx): Verdict {
  let i = 0
  // Global options before the subcommand: -C <path>, --git-dir / --work-tree (their paths are checked
  // like any other path), --no-pager… -c and --exec-path can make git run any program: they ask.
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i]
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--super-prefix') { i++; continue }
    if (/^--(git-dir|work-tree|namespace)=/.test(a) || /^(--no-pager|-P|--paginate|-p|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-lazy-fetch)$/.test(a)) continue
    if (a === '--version' || a === '--help') return READ
    return ext('changes git\'s configuration for this command (git -c / --exec-path can run any program)')
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub) return READ
  if (rest.some((a) => /^--(upload-pack|receive-pack|exec)\b/.test(a) || /^--ext-diff$/.test(a))) return ext('git option that runs another program')
  if (rest.some((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^[\w.-]+@[\w.-]+:/.test(a))) return NETWORK
  if (GIT_READ.has(sub)) return rest.some((a) => /^--output(=|$)/.test(a)) ? LOCAL : READ
  switch (sub) {
    case 'branch': return rest.some((a) => /^(-[dDmMcCfu]|--(delete|move|copy|force|set-upstream|set-upstream-to|unset-upstream|edit-description|track))/.test(a) || !a.startsWith('-')) ? LOCAL : READ
    case 'tag': return rest.length === 0 || rest.every((a) => /^(-l|--list|-n\d*|--sort=.*|--contains|--merged|--no-merged|--points-at|--format=.*)$/.test(a)) ? READ : LOCAL
    case 'stash': return rest[0] === 'list' || rest[0] === 'show' ? READ : LOCAL
    case 'remote':
      if (rest.length === 0 || rest.every((a) => a === '-v' || a === '--verbose')) return READ
      if (rest[0] === 'get-url') return READ
      return ext('changes or contacts the repository\'s remotes')
    case 'config':
      if (rest.length && rest.every((a) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--global|--local|--system|--name-only|-z|--null|--type=.*|--default=.*|--includes|--no-includes)$/.test(a) || !a.startsWith('-')) && rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a))) return READ
      return ext('changes git\'s configuration (it can make later git commands run other programs)')
    case 'worktree': return rest[0] === 'list' ? READ : LOCAL
    case 'notes': return rest[0] === 'list' || rest[0] === 'show' ? READ : LOCAL
    case 'archive': return rest.some((a) => /^--(remote|exec)/.test(a)) ? NETWORK : LOCAL
    case 'reflog': return rest[0] === 'expire' || rest[0] === 'delete' ? LOCAL : READ
  }
  if (GIT_LOCAL.has(sub)) return { effect: 'write_local', why: `git ${sub} (local)` }
  if (/^(push|pull|fetch|clone|ls-remote|submodule|send-email|request-pull|lfs|credential.*|daemon|svn|p4|cvs.*|http-.*|upload-pack|receive-pack|fetch-pack|send-pack|instaweb|imap-send|remote-.*)$/.test(sub)) return NETWORK
  return ext(`"git ${sub}" is not a git command SahilBot knows (it may be an alias that runs anything)`)
}

/** npm / pnpm / yarn / bun: scripts that exist run locally; installs, runners and everything else ask. */
function classifyPackageManager(name: string, args: string[], c: SegCtx): Verdict {
  const quiet = /^(-s|--silent|-q|--quiet|--if-present|--loglevel=\w+|--color=\w+|--no-color)$/
  const opts: string[] = []
  let i = 0
  for (; i < args.length && args[i].startsWith('-'); i++) opts.push(args[i])
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (opts.some((o) => /^(-v|--version|-h|--help)$/.test(o)) && !sub) return READ
  if (opts.some((o) => !quiet.test(o))) return ext(`${name} with options that change where it runs or what it installs`)
  const runFlagsOk = rest.every((a, k) => !a.startsWith('-') || quiet.test(a) || a === '--' || rest.slice(0, k).includes('--'))
  if (name === 'npm') {
    if (!sub) return READ
    if (/^(run|run-script|rum|urn)$/.test(sub)) {
      const s = rest.find((a) => !a.startsWith('-'))
      return runFlagsOk ? script(s, c, true) : ext('npm run with options (--script-shell, --workspace…) that change what runs')
    }
    if (/^(test|tst|t|start|stop|restart)$/.test(sub)) return runFlagsOk ? script(sub === 't' || sub === 'tst' ? 'test' : sub, c, true) : ext('npm with options that change what runs')
    if (/^(ls|list|la|ll|help|prefix|root|bin|explain|why|config|get)$/.test(sub) && !rest.some((a) => /^(set|delete|edit|fix)$/.test(a))) return sub === 'config' && rest[0] !== 'get' && rest[0] !== 'list' ? ext('changes npm configuration') : READ
    return NETWORK
  }
  if (name === 'pnpm') {
    if (!sub) return READ
    if (sub === 'run' || sub === 'run-script') return runFlagsOk ? script(rest.find((a) => !a.startsWith('-')), c, true) : ext('pnpm run with options that change what runs')
    if (/^(ls|list|ll|la|root|bin|why)$/.test(sub)) return READ
    if (/^(test|t|tst|start|stop|restart)$/.test(sub)) return runFlagsOk ? script(sub.startsWith('t') ? 'test' : sub, c, true) : ext('pnpm with options that change what runs')
    if (/^(dlx|exec|x|create)$/.test(sub)) return RUNNER
    if (/^(add|install|i|update|up|upgrade|remove|rm|uninstall|un|link|ln|unlink|import|rebuild|rb|prune|fetch|patch|patch-commit|audit|outdated|publish|pack|store|server|env|setup|init|config|deploy|licenses|approve-builds|self-update|cat-file|cat-index|find-hash)$/.test(sub)) return NETWORK
    // `pnpm <name>`: a script when one exists; otherwise pnpm runs it as a command.
    return runFlagsOk ? script(sub, c, false) : UNKNOWN
  }
  if (name === 'yarn') {
    if (!sub) return NETWORK // plain `yarn` installs
    if (sub === 'run') return runFlagsOk ? script(rest.find((a) => !a.startsWith('-')), c, true) : ext('yarn run with options that change what runs')
    if (/^(list|why|bin)$/.test(sub)) return READ
    if (/^(test|start)$/.test(sub)) return runFlagsOk ? script(sub, c, true) : ext('yarn with options that change what runs')
    if (/^(dlx|exec|node|npm|create|workspace|workspaces)$/.test(sub)) return RUNNER
    if (/^(add|install|remove|upgrade|up|upgrade-interactive|info|cache|config|global|link|unlink|pack|publish|set|plugin|init|import|patch|patch-commit|rebuild|audit|outdated|why|version|login|logout|owner|tag|team|policies|self-update|constraints)$/.test(sub)) return NETWORK
    return runFlagsOk ? script(sub, c, false) : UNKNOWN
  }
  // bun
  if (!sub) return UNKNOWN
  if (sub === 'run') {
    const target = rest.find((a) => !a.startsWith('-'))
    if (!runFlagsOk) return UNKNOWN
    const v = script(target, c, false)
    return v.effect === 'write_local' || !target ? v : insideFile(target, c) ? LOCAL : v
  }
  if (sub === 'test' || sub === 'build') return LOCAL
  if (/^(x|add|install|i|remove|rm|update|upgrade|create|init|pm|link|unlink|publish|outdated|patch)$/.test(sub)) return sub === 'x' ? RUNNER : NETWORK
  if (insideFile(sub, c)) return LOCAL
  return runFlagsOk ? script(sub, c, false) : UNKNOWN
}

/** node / python / ruby / perl / php / a shell: running a script FILE in your folders is local; inline code asks. */
function classifyInterpreter(name: string, args: string[], c: SegCtx): Verdict | null {
  const py = /^python(\d+(\.\d+)?)?$|^pypy3?$/.test(name)
  if (py) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '-V' || a === '--version' || a === '-h' || a === '--help') return READ
      if (a === '-c' || a.startsWith('-c') || a === '-') return INLINE
      if (a === '-m') return PY_MODULES.has(args[i + 1] ?? '') ? { effect: 'write_local', why: `runs python -m ${args[i + 1]}` } : ext(`python -m ${args[i + 1] ?? ''} is not a module SahilBot knows`)
      if (a === '-W' || a === '-X' || a === '-Q') { i++; continue }
      if (a.startsWith('-')) { if (/c/.test(a.slice(1)) && !a.startsWith('--')) return INLINE; continue }
      return insideFile(a, c) ? { effect: 'write_local', why: `runs ${a} (a script in your folders)` } : ext(`runs ${a}, which is outside your folders`)
    }
    return INLINE // the REPL / stdin
  }
  if (name === 'node' || name === 'nodejs') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '-v' || a === '--version' || a === '-h' || a === '--help') return READ
      if (/^(-e|--eval|-p|--print|-i|--interactive|-)$/.test(a) || /^--(eval|print)=/.test(a) || /^-[a-zA-Z]*[ep]$/.test(a)) return INLINE
      if (/^(-r|--require|--import|--loader|--experimental-loader|--env-file|-C|--conditions|--input-type|--watch-path|--test-reporter|--test-reporter-destination|--title|--inspect-port|--max-old-space-size|--stack-size)$/.test(a)) {
        const v = args[++i] ?? ''
        if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return INLINE
        continue
      }
      if (/^--(require|import|loader|experimental-loader)=/.test(a) && /=[a-z][a-z0-9+.-]*:/i.test(a)) return INLINE
      if (a === '--test') { if (!args.slice(i + 1).some((x) => !x.startsWith('-'))) return LOCAL; continue }
      if (a.startsWith('-')) continue
      return insideFile(a, c) ? { effect: 'write_local', why: `runs ${a} (a script in your folders)` } : ext(`runs ${a}, which is outside your folders`)
    }
    return INLINE
  }
  if (SHELLS.has(name)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '--version') return READ
      if (a === '-c' || /^-[a-zA-Z]*c/.test(a) || a === '-s' || /^-[a-zA-Z]*s/.test(a) || a === '-i' || a === '-') return INLINE
      if (a === '-o' || a === '+o') { i++; continue }
      if (a.startsWith('-') || a.startsWith('+')) continue
      return insideFile(a, c) ? { effect: 'write_local', why: `runs ${a} (a script in your folders)` } : ext(`runs ${a}, which is outside your folders`)
    }
    return INLINE // reads commands from stdin (… | sh)
  }
  if (name === 'source' || name === '.') return insideFile(args[0], c) ? LOCAL : ext(`runs ${args[0] ?? 'a file'}, which is outside your folders`)
  if (INLINE_FLAGS[name] || name === 'deno' || name === 'swift') {
    if (name === 'deno') {
      const sub = args[0]
      if (/^(test|fmt|lint|check|task|bench|doc|info|--version|-V)$/.test(sub ?? '')) return /^(--version|-V)$/.test(sub!) ? READ : LOCAL
      if (sub === 'run') { const f = args.slice(1).find((a) => !a.startsWith('-')); return insideFile(f, c) ? LOCAL : ext(`runs ${f ?? 'a script'}, which is outside your folders`) }
      return sub === 'eval' || sub === 'repl' || !sub ? INLINE : NETWORK
    }
    if (name === 'swift') {
      const sub = args[0]
      if (!sub || sub === 'repl' || sub === '-e') return INLINE
      if (sub === '--version') return READ
      if (/^(build|test|run)$/.test(sub)) return LOCAL
      if (sub === 'package') return /^(resolve|update|reset|edit)$/.test(args[1] ?? '') ? NETWORK : LOCAL
      return insideFile(sub, c) ? LOCAL : UNKNOWN
    }
    const flag = INLINE_FLAGS[name]
    for (const a of args) {
      if (/^(-v|--version|-V)$/.test(a)) return READ
      if (flag.test(a)) return INLINE
      if (a.startsWith('-')) continue
      return insideFile(a, c) ? { effect: 'write_local', why: `runs ${a} (a script in your folders)` } : ext(`runs ${a}, which is outside your folders`)
    }
    return INLINE
  }
  return null
}

/** One simple command (already split and unwrapped). */
function classifyArgv(argv0: string[], redirs: Words['redirs'], c: SegCtx, depth: number): Verdict {
  const n = normalize(argv0)
  if (n.system) return { effect: 'destructive', why: 'system-level command' }
  let v: Verdict = n.verdict ?? READ
  if (n.bg) v = worse(v, BACKGROUND)
  const writes = redirs.some((r) => isOutputRedir(r.op) && !/^\/dev\/(null|stdout|stderr|tty)$/.test(r.target))
  if (writes) v = worse(v, LOCAL)
  if (!n.argv.length) return v
  return worse(v, classifyProgram(n.argv, c, depth))
}

function classifyProgram(argv: string[], c: SegCtx, depth: number): Verdict {
  const raw = argv[0].replace(/^\\+/, '')
  const name = progName(raw)
  const args = argv.slice(1)
  const sub = (from: number): Verdict => (depth > 4 ? UNKNOWN : atLeastLocal(classifyArgv(args.slice(from), [], c, depth + 1)))
  // A program given by path: one inside your folders is project code (like a script); elsewhere it asks.
  if (raw.includes('/') && !/^\/(usr|bin|sbin|opt\/homebrew|opt\/local|System|Library\/Developer|Applications)\//.test(raw) && !raw.startsWith(join(HOME, '.nvm') + '/') && !raw.startsWith(join(HOME, '.cargo/bin') + '/')) {
    return insideFile(raw, c) ? { effect: 'write_local', why: `runs ${raw} (a program in your folders)` } : ext(`runs ${raw}, which is outside your folders`)
  }
  if (NET_NAMES.has(name)) {
    if (name === 'open' && args[0] === '-R') return READ
    if (name === 'brew' && /^(list|ls|--version|--prefix|--cellar|--repository|config|leaves|deps|uses)$/.test(args[0] ?? '')) return READ
    if ((name === 'pip' || name === 'pip3') && /^(list|show|freeze|--version|-V|check)$/.test(args[0] ?? '')) return READ
    // npx/bunx running a tool this project already installed (node_modules/.bin) is project code, like
    // `npm test`; anything that would download a package asks.
    if ((name === 'npx' || name === 'bunx') && c.cwd && insideFile(c.cwd, c)) {
      const at = args.findIndex((a) => !a.startsWith('-'))
      const bin = at >= 0 ? args[at] : undefined
      // Only npx's own flags (before the tool name) matter; what follows is the tool's arguments.
      const opts = at >= 0 ? args.slice(0, at) : args
      if (bin && /^[\w@./-]+$/.test(bin) && !bin.includes('..') && opts.every((o) => o === '--no-install' || o === '--no') && existsSync(join(c.cwd, 'node_modules', '.bin', bin.replace(/^@[^/]+\//, '')))) {
        return { effect: 'write_local', why: `runs ${bin}, installed in this project` }
      }
    }
    if (name === 'npx' || name === 'bunx' || name === 'uvx' || name === 'pipx' || (name === 'uv' && /^(run|tool)$/.test(args[0] ?? ''))) return RUNNER
    if (name === 'osascript') return INLINE
    return NETWORK
  }
  if (name === 'cd' || name === 'pushd' || name === 'popd') return READ
  if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'local' || name === 'readonly') {
    return args.every((a) => !ASSIGN.test(a) || SAFE_ENV.test(ASSIGN.exec(a)![1])) ? READ : ENV_CHANGE
  }
  if (name === 'set') return args.every((a) => /^[-+][a-zA-Z]+$|^(errexit|pipefail|nounset|xtrace|-o|\+o)$/.test(a)) ? READ : UNKNOWN
  if (name === 'eval' || name === 'trap' || name === 'alias' || name === 'function' || name === 'coproc' || name === 'watch' || name === 'parallel') return args.length || name !== 'alias' ? INLINE : READ
  if (name === 'git') return classifyGit(args, c)
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return classifyPackageManager(name, args, c)
  const interp = classifyInterpreter(name, args, c)
  if (interp) return interp
  switch (name) {
    case 'defaults': return /^(read|read-type|domains|find)$/.test(args[0] ?? '') ? READ : { effect: 'destructive', why: 'system-level command' }
    case 'sysctl': return args.some((a) => a === '-w' || a.includes('=')) ? { effect: 'destructive', why: 'system-level command' } : READ
    case 'top': return args.includes('-l') ? READ : UNKNOWN
    case 'less': return args.some((a) => /^-[a-zA-Z]*[oO]/.test(a) || /^--(log-file|LOG-FILE)/.test(a)) ? LOCAL : READ
    case 'tree': return args.some((a) => a === '-o') ? LOCAL : READ
    case 'sort': return args.some((a) => /^-[a-zA-Z]*o/.test(a) || /^--output/.test(a)) ? LOCAL : READ
    case 'yq': return args.some((a) => /^-[a-zA-Z]*i$/.test(a) || a === '--inplace') ? LOCAL : READ
    case 'uniq': {
      let files = 0
      for (let i = 0; i < args.length; i++) { if (/^-[fs]$/.test(args[i])) i++; else if (args[i] !== '-' && !args[i].startsWith('-')) files++ }
      return files >= 2 ? LOCAL : READ
    }
    case 'sed': return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) || args.some((a) => /(^|[;/}\s])[wW]\s+\S/.test(a)) ? LOCAL : READ
    case 'awk': case 'gawk': case 'nawk': case 'mawk': {
      if (args.some((a) => a === '-f' || a.startsWith('--file'))) return LOCAL
      const prog = args.find((a) => !a.startsWith('-')) ?? ''
      if (/\bsystem\s*\(|\|\s*(getline|")|"\s*\|\s*getline|\/inet\/|\bclose\s*\(/.test(prog) || /print[^;}]*\|/.test(prog)) return INLINE
      return />/.test(prog) ? LOCAL : READ
    }
    case 'find': {
      let v: Verdict = READ
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
          let j = i + 1
          while (j < args.length && args[j] !== ';' && args[j] !== '+' && args[j] !== '\\;') j++
          v = worse(v, depth > 4 ? UNKNOWN : atLeastLocal(classifyArgv(args.slice(i + 1, j).filter((x) => x !== '{}'), [], c, depth + 1)))
          i = j
        } else if (/^-(fprint0?|fprintf|fls)$/.test(a)) v = worse(v, LOCAL)
        else if (a === '-delete') v = worse(v, { effect: 'destructive', why: 'deletes files or rewrites history' })
      }
      return v
    }
    case 'fd': case 'fdfind': {
      const k = args.findIndex((a) => /^(-x|--exec|-X|--exec-batch)$/.test(a))
      return k < 0 ? READ : sub(k + 1)
    }
    case 'rg': {
      const k = args.findIndex((a) => a === '--pre' || a.startsWith('--pre='))
      if (k < 0) return READ
      const prog = args[k].includes('=') ? args[k].split('=')[1] : args[k + 1]
      return insideFile(prog, c) ? LOCAL : ext(`rg --pre runs ${prog ?? 'a program'}, which is outside your folders`)
    }
    case 'tar': case 'bsdtar': case 'gtar':
      if (args.some((a) => /^--(to-command|use-compress-program|checkpoint-action|rsh-command|rmt-command|info-script|new-volume-script)/.test(a) || /^-[a-zA-Z]*I$/.test(a) || a === '-I')) return INLINE
      if (args.some((a, k) => /f$/.test(args[k - 1] ?? '') && /^[^/]*:/.test(a))) return NETWORK
      return LOCAL
    case 'zip': return args.some((a) => /^(-TT|--unzip-command)/.test(a)) ? INLINE : LOCAL
    case 'unzip': return /^-[a-zA-Z]*[lvtZ]/.test(args[0] ?? '') ? READ : LOCAL
    case 'cargo': {
      const s = args.find((a) => !a.startsWith('-'))
      if (/^(build|b|test|t|check|c|run|r|fmt|clippy|doc|d|bench|clean|tree|metadata|locate-project|verify-project|version|help)$/.test(s ?? '')) return LOCAL
      if (args.includes('--version') || args.includes('-V')) return READ
      return NETWORK
    }
    case 'go': {
      const s = args[0]
      if (/^(build|test|vet|fmt|run|generate|list|env|version|doc|tool|clean)$/.test(s ?? '')) return s === 'version' ? READ : s === 'env' && args.includes('-w') ? ENV_CHANGE : LOCAL
      return NETWORK // get, install, mod download…
    }
    case 'xcodebuild': return args.includes('-version') || args.includes('-showsdks') || args.includes('-list') ? READ : args.some((a) => /^-(resolvePackageDependencies|exportArchive)$/.test(a)) ? NETWORK : LOCAL
    case 'codesign': return args.some((a) => /^(-d|-dv+|--display|-v+|--verify)$/.test(a)) && !args.some((a) => /^(-s|--sign|-f|--force|--remove-signature)$/.test(a)) ? READ : LOCAL
    case 'plutil': return args.some((a) => /^-(p|lint|help|type|extract)$/.test(a)) && !args.some((a) => /^-(convert|insert|replace|remove|o)$/.test(a)) ? READ : LOCAL
    case 'lipo': return args.some((a) => /^-(info|detailed_info|archs|verify_arch)$/.test(a)) ? READ : LOCAL
    case 'kill': case 'pkill': case 'killall': return ext('stops other processes on this Mac')
    case 'xcrun':
      if (/^(--find|-f|--show-sdk-path|--show-sdk-version|--version)$/.test(args[0] ?? '')) return READ
      return /^(swift|swiftc|clang|clang\+\+|ld|lipo|otool|nm|strip|xcodebuild|actool|ibtool|metal|metallib)$/.test(args[0] ?? '') ? LOCAL : UNKNOWN
  }
  if (READ_NAMES.has(name)) return READ
  if (LOCAL_NAMES.has(name)) return { effect: 'write_local', why: `${name} (a local build, test or file tool)` }
  return UNKNOWN
}

function cdTarget(args: string[], c: SegCtx): string | null {
  const t = args.filter((a) => a !== '-P' && a !== '-L' && a !== '--')[0]
  if (t === undefined || t === '~' || t === '-' || /^~[^/]/.test(t) || /[$`*?]/.test(t)) return t === undefined || t === '~' ? HOME : null
  const expanded = t.startsWith('~/') ? join(HOME, t.slice(2)) : t
  if (isAbsolute(expanded)) return resolve(expanded)
  return c.cwd === null ? null : resolve(c.cwd, expanded)
}

/** Programs every system-level check refuses: by text (old patterns) and by basename after unwrapping. */
export function systemReason(cmd: string): string | null {
  if (SYSTEM.test(cmd)) return 'system-level command'
  for (const s of splitCommand(cmd)) {
    const n = normalize(words(s.text).argv)
    if (n.system) return `system-level command (${n.system})`
    const name = n.argv[0] ? progName(n.argv[0]) : ''
    if (name === 'defaults' && !/^(read|read-type|domains|find)$/.test(n.argv[1] ?? '')) return 'system-level command (defaults)'
    if (name === 'sysctl' && n.argv.slice(1).some((a) => a === '-w' || a.includes('='))) return 'system-level command (sysctl)'
  }
  for (const inner of substitutions(cmd)) { const r = inner !== cmd ? systemReason(inner) : null; if (r) return r }
  return null
}

/**
 * What a command can do. Every segment of a chain is classified (most severe wins) against an allowlist
 * of known local tools; unknown programs reach outside. With `ctx` (the run's folder and your folders),
 * script files and package.json scripts are checked against them and `cd` is followed.
 */
export function classify(cmd: string, ctx: ClassifyContext = {}): { effect: ToolEffect; why: string } {
  return classifyIn(cmd, ctx, 0)
}

function classifyIn(cmd: string, ctx: ClassifyContext, depth: number): Verdict {
  const text = cmd.trim()
  if (!text) return READ
  if (systemReason(text)) return { effect: 'destructive', why: 'system-level command' }
  if (deletes(text)) return { effect: 'destructive', why: 'deletes files or rewrites history' }
  const known = ctx.cwd !== undefined || ctx.allowed !== undefined
  const allowed = (ctx.allowed ?? []).filter(Boolean)
  const c: SegCtx = { cwd: ctx.cwd ?? (allowed[0] ?? null), allowed: ctx.cwd && !allowed.length ? [ctx.cwd] : allowed, known }
  let v: Verdict = READ
  // Substitutions run code wherever they appear: never a plain read.
  for (const inner of substitutions(text)) v = worse(v, depth > 4 ? UNKNOWN : atLeastLocal(classifyIn(inner, { cwd: c.cwd ?? undefined, allowed: known ? c.allowed : undefined }, depth + 1)))
  for (const s of splitCommand(text)) {
    if (s.sep === '&') v = worse(v, BACKGROUND)
    if (!s.text) continue
    // ( … ) and { … } groups: classify what's inside.
    const body = s.text.replace(/^[({\s!]+/, '').replace(/[)}\s]+$/, '')
    if (!body) continue
    const w = words(body)
    const n = normalize(w.argv)
    if (n.argv[0] && /^(cd|pushd)$/.test(progName(n.argv[0])) && !n.system) {
      const next = cdTarget(n.argv.slice(1), c)
      c.cwd = next === null ? null : realish(next)
    }
    v = worse(v, classifyArgv(w.argv, w.redirs, c, depth))
  }
  return v
}

// ---------- paths outside your folders ----------

/** Locations any argument may name: root-owned system folders, temp folders and caches. */
const SAFE_PREFIXES = ['/dev/', '/usr/', '/bin/', '/sbin/', '/etc/', '/System/', '/Library/Developer/', '/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/', '/private/etc/',
  ...['.npm', '.cache', 'Library/Caches'].map((d) => join(HOME, d) + '/')]
/**
 * Toolchain folders you can write to (Homebrew, version managers, ~/.local/bin, /Applications): fine as the
 * program to run or in PATH=, but a file copied there lands on your PATH, so as an argument they're outside.
 */
const TOOL_PREFIXES = ['/opt/homebrew/', '/opt/local/', '/Applications/', ...['.nvm', '.bun', '.cargo', '.local/bin', '.pyenv', '.rbenv', '.deno', 'go/bin', '.volta'].map((d) => join(HOME, d) + '/')]
/** $VARIABLES that hold search paths, not a place a command writes. */
const PATHISH_VAR = /^\$\{?([A-Z_]*PATH|[0-9@*#?$!-]|PWD|HOME)\}?$/

/**
 * Paths a command names that are outside `allowed` (the workspace and attached folders). Relative names
 * resolve against the folder the command runs in (`cwd`, default the first allowed folder), following
 * `cd` (a bare `cd`, `cd ~`, `cd -` or `cd $VAR` leaves your folders: everything after it counts as outside).
 */
export function outsidePaths(cmd: string, allowed: string[], cwd?: string): string[] {
  const roots = allowed.filter(Boolean).map((r) => realish(resolve(r)))
  const tmp = realish(tmpdir())
  const out: string[] = []
  let dir: string | null = cwd ? realish(resolve(cwd)) : roots[0] ?? null
  const under = (list: string[], full: string): boolean => list.some((p) => full === p.replace(/\/$/, '') || full.startsWith(p))
  const home = realish(HOME)
  const specific = roots.filter((r) => r !== home)
  const inside = (full: string, program = false): boolean => {
    if (under(SAFE_PREFIXES, full) || (program && under(TOOL_PREFIXES, full))) return true
    const real = realish(full)
    if (within(tmp, real) || specific.some((r) => within(r, real))) return true
    // The home folder as a root ("files anywhere"): never its system, private or secret places.
    return roots.includes(home) && within(home, real) && !inForbidden(real) && !isSecretName(basename(real))
  }
  const check = (raw0: string, relativeOk: boolean, program = false): void => {
    for (const raw of raw0.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').split(/[\s=:,]+/)) {
      if (!raw || raw.startsWith('-')) continue
      if (PATHISH_VAR.test(raw) && !/^\$\{?(PWD|HOME)\}?$/.test(raw)) continue
      let t = raw.replace(/^\$\{?HOME\}?(?=\/|$)/, '~')
      if (/^\$\{?PWD\}?(?=\/|$)/.test(t)) { if (dir === null) { out.push(raw); continue } t = dir + t.replace(/^\$\{?PWD\}?/, '') }
      if (t === '~' || t.startsWith('~/')) t = HOME + t.slice(1)
      if (/^~[^/]/.test(t) || /^\$/.test(t)) { out.push(raw); continue } // ~user/…, $OTHER/…: somewhere unknown
      if (t.startsWith('/')) {
        if (t.length < 2 || /^\/+$/.test(t)) continue
        if (!inside(resolve(t), program)) out.push(resolve(t))
        continue
      }
      if (!relativeOk) continue
      if (dir === null) { out.push(raw); continue }
      if (!inside(resolve(dir, t))) out.push(resolve(dir, t))
    }
  }
  for (const s of splitCommand(cmd)) {
    const body = s.text.replace(/^[({\s!]+/, '').replace(/[)}\s]+$/, '')
    if (!body) continue
    const w = words(body)
    const n = normalize(w.argv)
    const name = n.argv[0] ? progName(n.argv[0]) : ''
    if (name === 'cd' || name === 'pushd') {
      const t = cdTarget(n.argv.slice(1), { cwd: dir, allowed: roots, known: true })
      dir = t === null ? null : realish(t)
      continue
    }
    for (const a of w.argv) if (ASSIGN.test(a)) check(a.replace(ASSIGN, ''), false, true)
    // The program itself and its arguments; relative names resolve against the current folder.
    n.argv.forEach((a, k) => check(a, k > 0, k === 0))
    for (const r of w.redirs) if (isOutputRedir(r.op)) check(r.target, true)
  }
  for (const inner of substitutions(cmd)) if (inner !== cmd) out.push(...outsidePaths(inner, allowed, dir ?? undefined))
  return [...new Set(out)].slice(0, 8)
}

// ---------- project commands (Auto) ----------

/** Files that decide what an install runs and where packages come from: committed and unmodified, or no auto. */
const NPM_FILES = { required: ['package.json'], optional: ['.npmrc'] }
const LOCKS: Array<{ re: RegExp; lock: string[]; files: string[]; flags: RegExp }> = [
  { re: /^npm\s+(ci|install|i)((?:\s+-\S+)*)$/, lock: ['package-lock.json', 'npm-shrinkwrap.json'], files: ['.npmrc'], flags: /^(--no-audit|--no-fund|--prefer-offline|--offline|--silent|-s|--quiet|-q|--no-progress|--ignore-scripts|--ignore-scripts=true|--production|--omit=(dev|optional|peer)|--include=(dev|optional|peer|prod)|--legacy-peer-deps|--strict-peer-deps|--no-optional|--foreground-scripts|--loglevel=(silent|error|warn|notice|http|info|verbose|silly)|--color=(true|false|always)|--no-color)$/ },
  { re: /^pnpm\s+(install|i)((?:\s+-\S+)*)$/, lock: ['pnpm-lock.yaml'], files: ['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs'], flags: /^(--frozen-lockfile|--prefer-frozen-lockfile|--prefer-offline|--offline|--silent|-s|--reporter=(silent|default|append-only|ndjson)|--ignore-scripts|--prod|-P|--dev|-D|--no-optional|--strict-peer-dependencies)$/ },
  { re: /^yarn(?:\s+(install))?((?:\s+-\S+)*)$/, lock: ['yarn.lock'], files: ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', '.yarn/releases', '.yarn/plugins'], flags: /^(--frozen-lockfile|--immutable|--immutable-cache|--prefer-offline|--offline|--silent|-s|--ignore-scripts|--production|--check-cache|--inline-builds|--mode=skip-build)$/ }
]
const PULL_FLAGS = /^(--ff-only|--ff|--no-rebase|--rebase|--prune|-p|-q|--quiet|-v|--verbose|--tags|--no-tags|--autostash|--no-autostash)$/

/** What a folder looked like the first time this chat saw it: the commit, origin URL and git config. */
export interface ProjectBaseline { head: string; origin: string; config: string; at: number }
type TrustState = Pick<ThreadState, 'projectTrust' | 'written'>
/** Baselines when no chat state is at hand (tests, one-off checks): per process. */
const looseTrust: TrustState = {}

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, { cwd: dir, timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: toolEnv({ GIT_OPTIONAL_LOCKS: '0' }) })
    return { ok: true, out: String(out).trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

function gitTop(dir: string): string | null {
  if (!existsSync(dir)) return null
  const r = git(dir, ['rev-parse', '--show-toplevel'])
  return r.ok && r.out ? realish(r.out) : null
}

const configHash = (top: string): string => {
  const p = git(top, ['rev-parse', '--git-path', 'config'])
  const file = p.ok ? resolve(top, p.out) : join(top, '.git', 'config')
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return '' }
}

/** The folder's baseline, recorded the first time it's seen (in the chat's state when given). */
export function projectBaseline(dir: string, state?: TrustState): ProjectBaseline | null {
  const top = gitTop(dir)
  if (!top) return null
  const st = state ?? looseTrust
  st.projectTrust ??= {}
  if (!st.projectTrust[top]) {
    const head = git(top, ['rev-parse', '--verify', 'HEAD'])
    if (!head.ok) return null
    st.projectTrust[top] = { head: head.out, origin: git(top, ['remote', 'get-url', 'origin']).out, config: configHash(top), at: Date.now() }
  }
  return st.projectTrust[top]
}

/** Names that, when a tool or command mentions them, mean this chat may have changed install config. */
const TRUST_FILE = /(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.pnpmfile\.cjs|yarn\.lock|\.npmrc|\.yarnrc|\.yarn\/|\.pnp\.cjs|\.git(\/|\b)|\.gitmodules)/

/**
 * Records that this chat wrote (or may have written) install config or git internals: the project's
 * lockfile is no longer the user's, so installs and pulls ask again. `text` is a command or a tool's args.
 */
export function noteTrustWrites(state: TrustState | undefined, text: string): void {
  if (!state || !TRUST_FILE.test(text)) return
  state.written = [...new Set([...(state.written ?? []), '*'])].slice(-200)
}

/** Whether the files that steer an install are committed, unmodified since HEAD and since the folder was first seen. */
function trustedFiles(dir: string, required: string[], optional: string[], state?: TrustState): boolean {
  const top = gitTop(dir)
  if (!top) return false
  const st = state ?? looseTrust
  if (st.written?.length) return false
  const base = projectBaseline(dir, st)
  if (!base) return false
  if (configHash(top) !== base.config) return false
  const rel = (f: string): string => relative(top, join(realish(dir), f)) || f
  const req = required.map(rel)
  const all = [...req, ...optional.map(rel)]
  if (!git(top, ['ls-files', '--error-unmatch', '--', ...req]).ok) return false
  const status = git(top, ['status', '--porcelain', '--ignored=matching', '--untracked-files=all', '--', ...all])
  if (!status.ok || status.out) return false
  if (!git(top, ['diff', '--quiet', base.head, 'HEAD', '--', ...all]).ok) return false
  return true
}

/** One segment that reaches outside only to set up the project in `dir`. */
function projectStep(seg: string, dir: string, state?: TrustState): boolean {
  for (const { re, lock, files, flags } of LOCKS) {
    const m = re.exec(seg)
    if (!m) continue
    const fl = (m[2] ?? '').trim().split(/\s+/).filter(Boolean)
    if (!fl.every((f) => flags.test(f))) return false
    const found = lock.filter((l) => existsSync(join(dir, l)))
    if (!found.length || !existsSync(join(dir, 'package.json'))) return false
    return trustedFiles(dir, [...NPM_FILES.required, found[0]], [...NPM_FILES.optional, ...files], state)
  }
  const g = /^git\s+(fetch|pull)((?:\s+\S+)*)$/.exec(seg)
  if (g) {
    const rest = (g[2] ?? '').trim().split(/\s+/).filter(Boolean)
    const names = rest.filter((x) => !x.startsWith('-'))
    if (!rest.filter((x) => x.startsWith('-')).every((x) => PULL_FLAGS.test(x))) return false
    if (names.length > 1 || (names.length === 1 && names[0] !== 'origin')) return false
    const top = gitTop(dir)
    if (!top) return false
    const st = state ?? looseTrust
    if (st.written?.length) return false
    const base = projectBaseline(dir, st)
    if (!base || !base.origin) return false
    const now = git(top, ['remote', 'get-url', 'origin'])
    return now.ok && now.out === base.origin && configHash(top) === base.config
  }
  return false
}

/**
 * A command made only of `cd` (into a subfolder of `allowed`) and project steps: installs from the
 * project's committed lockfile (npm ci, npm/pnpm/yarn install with no package names and safe flags) and
 * git fetch / pull from the recorded origin. Steps are joined with && or ;. Anything else chained in,
 * pipes, substitutions and redirects never qualify (the command is then classified normally).
 */
export function isProjectCommand(cmd: string, cwd: string, allowed: string[], o: { state?: TrustState } = {}): boolean {
  const c = cmd.trim()
  if (!c || /[`|<>\n\r(){}]|\$|&(?!&)/.test(c.replace(/&&/g, ''))) return false
  let dir = realish(resolve(cwd))
  const roots = allowed.map((r) => realish(resolve(r)))
  if (!roots.some((r) => within(r, dir))) return false
  let steps = 0
  for (const raw of c.split(/\s*(?:&&|;)\s*/)) {
    const seg = raw.trim().replace(/\s+/g, ' ')
    if (!seg) continue
    const cd = /^cd\s+(\S+)$/.exec(seg)
    if (cd) {
      if (/^[$~-]/.test(cd[1]) || /[$*?'"\\]/.test(cd[1])) return false
      const next = realish(resolve(dir, cd[1]))
      if (!roots.some((r) => within(r, next))) return false
      dir = next
      continue
    }
    if (!projectStep(seg, dir, o.state)) return false
    steps++
  }
  return steps > 0
}

/**
 * Commands run in the chat's working folder (when it has one), else the first folder attached to it (the
 * project folder), else the workspace. A relative cwd starts in that same folder.
 */
export function cwdFor(p: string | undefined, ctx: Pick<ToolContext, 'state' | 'workspaceDir'>): string {
  const folder = ctx.state.folder && existsSync(ctx.state.folder) && statSync(ctx.state.folder).isDirectory() ? ctx.state.folder : undefined
  const base = folder ?? ctx.state.roots?.find((r) => existsSync(r) && statSync(r).isDirectory()) ?? ctx.workspaceDir
  if (!p) return base
  const abs = isAbsolute(p) ? p : resolve(folder ?? ctx.workspaceDir, p)
  const real = existsSync(abs) ? realpathSync(abs) : abs
  const roots = [ctx.workspaceDir, ...(ctx.state.roots ?? [])].map((r) => (existsSync(r) ? realpathSync(r) : r))
  if (!roots.some((r) => real === r || real.startsWith(r + sep))) throw new Error(`${p} is outside the workspace and the folders attached to this chat. Attach the folder first.`)
  return real
}

/** chmod / chown / chgrp / chflags naming paths outside `allowed` (the command is refused: system-level). */
export function permissionChangeOutside(cmd: string, allowed: string[], cwd?: string): string[] {
  const out: string[] = []
  for (const s of splitCommand(cmd)) {
    const n = normalize(words(s.text.replace(/^[({\s!]+/, '')).argv)
    if (!n.argv.length || !/^(chmod|chown|chgrp|chflags)$/.test(progName(n.argv[0]))) continue
    out.push(...outsidePaths(n.argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' '), allowed, cwd).filter((p) => !/^[+=,ugoa-]*[rwxXstugo]*$|^\d+$|^[\w-]+(:[\w-]*)?$/.test(p)))
  }
  return out
}

export interface ShellDeps {
  /** The chat's attached folders (for project commands; the loop's state has them too). */
  rootsOf?: (threadId: string) => string[]
  /** The workspace folder (outside-path checks need it; without it they're skipped). */
  workspace?: () => string
  jobs?: JobManager
}

/** The full effect of a command run in `cwd`: its classification, with writes outside your folders counted as acting outside. */
export function commandEffect(command: string, o: { cwd?: string; allowed: string[] }): { effect: ToolEffect; why: string } {
  const c = classify(command, { cwd: o.cwd, allowed: o.allowed })
  if (c.effect !== 'write_local') return c
  const far = outsidePaths(command, o.allowed, o.cwd)
  return far.length ? { effect: 'write_external', why: `changes things outside your folders (${far.slice(0, 2).join(', ')})` } : c
}

/** Folders a sandboxed command may write: the workspace, the chat's folders and where it runs. */
const writableFor = (ws: string, roots: string[], cwd: string): string[] => [...new Set([ws, ...roots, cwd].filter(Boolean))]

const DEFAULT_URL_WAIT: WaitFor = { regex: 'https?://(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::)', timeout: 6 }

export function shellTool(deps: ShellDeps = {}): ToolDef<Args> {
  const jobs = deps.jobs ?? defaultJobs
  const where = (a: Args, roots: string[], folder?: string): { cwd?: string; allowed: string[] } | null => {
    if (!deps.workspace) return null
    const ws = deps.workspace()
    let cwd: string | undefined
    try { cwd = cwdFor(a.cwd, { state: { roots, folder } as ToolContext['state'], workspaceDir: ws }) } catch { cwd = undefined }
    return { cwd, allowed: [ws, ...roots] }
  }
  /** The effect, with writes outside your folders counted as acting outside. */
  const effectOf = (a: Args, roots: string[], folder?: string): { effect: ToolEffect; why: string } => {
    const w = where(a, roots, folder)
    if (!w) return classify(a.command)
    if (!w.cwd) return { effect: 'write_external', why: `runs in ${a.cwd}, outside your folders` }
    return commandEffect(a.command, w)
  }
  /** For the approval card (no chat at hand: attached folders aren't known here). */
  const whyOf = (a: Args): string => {
    const w = where(a, [])
    return w?.cwd ? commandEffect(a.command, w).why : classify(a.command).why
  }
  return {
    name: 'run_command',
    label: 'Terminal',
    core: true,
    untrusted: true,
    effect: (a, c) => effectOf(a, c.roots, c.folder).effect,
    // Installs, pushes and network commands are never routine: Auto asks. Setting up the project from its
    // own lockfile (or git fetch / pull) is a project command: Auto runs it (never unattended).
    consequential: (a, call) => {
      if (call.unattended || !deps.workspace) return true
      try {
        const roots = deps.rootsOf?.(call.threadId) ?? call.state?.roots ?? []
        const ws = deps.workspace()
        const cwd = cwdFor(a.cwd, { state: { roots, folder: call.state?.folder } as ToolContext['state'], workspaceDir: ws })
        return isProjectCommand(a.command, cwd, [ws, ...roots], { state: call.state }) ? 'project' : true
      } catch {
        return true
      }
    },
    // Deleting always asks, even in Bypass (same rule as deleting a file).
    hardStop: (a) => {
      const sys = systemReason(a.command)
      if (sys) return `"${a.command.slice(0, 80)}" is a ${sys}`
      if (deletes(a.command) || classify(a.command).effect === 'destructive') return `"${a.command.slice(0, 80)}" deletes files or rewrites history`
      if (deps.workspace) {
        const far = permissionChangeOutside(a.command, [deps.workspace()])
        if (far.length) return `"${a.command.slice(0, 80)}" changes permissions outside your folders (${far.slice(0, 2).join(', ')})`
      }
      return null
    },
    describe: (a) => `${a.background ? 'Start in the background' : 'Run in Terminal'}: ${a.command.slice(0, 200)}${a.cwd ? ` (in ${a.cwd})` : ''} · ${whyOf(a)}`,
    description: 'Run a shell command (zsh) on this Mac in the workspace or an attached/project folder, and get its output and exit code. Use it for builds, tests, git, scripts, file conversions and anything a terminal does. Prefer one clear command per call; check the exit code. Long-running processes (dev servers, watchers, long builds): set background: true, optionally with wait_for ({"text": "ready"}, {"regex": "Local:.*http"}, {"port": 5173}) to wait until it is up; you get a job id, the URL it prints and its first output, then use the jobs tool to read output, wait, stop or restart it (never use "&" or nohup). Deleting files always asks the user. Writing outside the workspace and attached folders is blocked unless the user approves the command. In code projects prefer the code tool (search, edit, apply_patch, run_tests, typecheck, lint) and the git tool: they return parsed, compact results.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command, e.g. "npm test" or "git status"' },
        cwd: { type: 'string', description: 'Folder to run in (default: the attached/project folder, else the workspace)' },
        timeout: { type: 'integer', minimum: 1, maximum: 1800, description: 'Seconds before it is stopped (default 120). Not used with background.' },
        background: { type: 'boolean', description: 'Keep it running as a background job (dev server, watcher, long build) and return right away' },
        wait_for: {
          type: 'object',
          description: 'With background: wait until the job is ready before returning',
          properties: {
            text: { type: 'string', description: 'Text a line contains when it is ready, e.g. "ready in"' },
            regex: { type: 'string', description: 'Or a regular expression for that line' },
            port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Or a local port that starts accepting connections' },
            timeout: { type: 'integer', minimum: 1, maximum: 900, description: 'Seconds to wait (default 60)' }
          },
          additionalProperties: false
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    async run(a, ctx) {
      if (systemReason(a.command)) throw new Error('System-level commands (sudo, launchctl, defaults write, disk tools, shutdown, security settings) are not run by SahilBot. Ask the user to run it themselves in Terminal.')
      const cwd = cwdFor(a.cwd, ctx)
      const roots = ctx.state.roots ?? []
      const far = permissionChangeOutside(a.command, [ctx.workspaceDir, ...roots], cwd)
      if (far.length) throw new Error(`Changing permissions or owners outside your folders (${far.slice(0, 2).join(', ')}) is system-level: SahilBot doesn't run it. Ask the user to run it themselves in Terminal.`)
      // The folder's baseline (commit, origin, git config) is taken before this chat changes anything in it,
      // and a command that touches install config or git internals makes later installs ask.
      try { projectBaseline(cwd, ctx.state) } catch { /* not a repo */ }
      if (classify(a.command, { cwd, allowed: [ctx.workspaceDir, ...roots] }).effect !== 'read') noteTrustWrites(ctx.state, a.command)
      // Defense in depth: unless the user approved this exact call, writes outside your folders are refused
      // by a macOS sandbox (code/proc.ts). Reads and the network are unaffected.
      const sandbox: SandboxSpec | undefined = ctx.sandbox !== false && !ctx.approved ? { writable: writableFor(ctx.workspaceDir, roots, cwd) } : undefined
      if (a.background) return startJob(jobs, a, cwd, ctx, sandbox)
      const limit = Math.min(a.timeout ?? 120, 1800) * 1000
      // Its own process group, so Stop and timeouts reach everything it started.
      const tick = throttle<string>((l) => ctx.progress?.(l), 700)
      const out = await runProcess('/bin/zsh', ['-lc', a.command], {
        cwd,
        timeoutMs: limit,
        signal: ctx.signal,
        sandbox,
        onLine: (l) => { if (l.trim()) tick.push(l.trim().slice(0, 160)) }
      })
      tick.flush()
      const clean = stripAnsi(out.output).trimEnd()
      const status = out.timedOut ? `stopped after ${limit / 1000}s` : out.stopped ? 'stopped' : `exit code ${out.code}`
      const hint = out.timedOut ? '\n(It was still running. If it is a server or watcher, start it with background: true instead.)' : ''
      return { text: `$ ${a.command}\n(in ${cwd}; ${status})\n${clean || '(no output)'}${hint}`, data: { exitCode: out.code, timedOut: out.timedOut, stopped: out.stopped, stdout: out.stdout, stderr: out.stderr, cwd }, display: `${a.command.slice(0, 60)} · ${status}` }
    }
  }
}

/** Starts a background job, waits for it to be ready (or a moment for its URL), and reports. */
async function startJob(jobs: JobManager, a: Args, cwd: string, ctx: ToolContext, sandbox?: SandboxSpec) {
  // A helper agent's jobs belong to the chat that started the team, so they show in its Jobs tab.
  const owner = ctx.state.rootId ?? ctx.threadId
  const job = jobs.start({ threadId: owner, command: a.command, cwd, sandbox })
  ctx.progress?.(`Started job ${job.id}`)
  const w = a.wait_for && (a.wait_for.text || a.wait_for.regex || a.wait_for.port) ? a.wait_for : DEFAULT_URL_WAIT
  const r = await jobs.wait(job.id, w, ctx.signal)
  const now = jobs.get(job.id) ?? r.job
  const tail = jobs.output(job.id, { tail: 30 }).lines.join('\n').trimEnd()
  const what = w === DEFAULT_URL_WAIT ? null : w.text ? `"${w.text}"` : w.regex ? `/${w.regex}/` : `port ${w.port}`
  let status: string
  if (r.reason === 'exited') status = now.status === 'exited' ? 'it finished already (exit code 0)' : `it stopped with exit code ${now.exitCode ?? '?'}`
  else if (r.reason === 'matched' || r.reason === 'port') status = what ? `ready: ${what} after ${(r.ms / 1000).toFixed(1)}s` : 'running'
  else if (r.reason === 'aborted') status = 'running (stopped waiting)'
  else status = what ? `still running, but ${what} did not show up within ${w.timeout ?? 60}s` : 'running'
  const url = now.urls[0]
  const text = [
    `Background job ${job.id}: ${status}.`,
    `$ ${a.command}`,
    `(in ${cwd})`,
    url ? `URL: ${now.urls.join(', ')}` : now.ports.length ? `Port: ${now.ports.join(', ')}` : '',
    `Output so far:\n${tail || '(none yet)'}`,
    '',
    `Use the jobs tool: output (id "${job.id}", tail or grep), wait (text / regex / port / exit), stop, restart. It keeps running until stopped, and stops when SahilBot quits.`,
    jobLine(now)
  ].filter((x) => x !== '').join('\n')
  return {
    text,
    display: `${a.command.slice(0, 48)} · job ${job.id}${url ? ` · ${url}` : ''} · ${r.reason === 'exited' ? now.status : now.status === 'ready' ? 'ready' : 'running'}`,
    meta: { job: { id: job.id, url: url ?? null, status: now.status } }
  }
}
