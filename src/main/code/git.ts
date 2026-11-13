import { basename } from 'node:path'
import { looksLikeSecret } from '../browser/teach'
import { capture, clip, runProcess, toolEnv, which } from './proc'

// git and GitHub CLI helpers for the coding tools. Every call goes through execFile-style argument
// arrays (no shell), never force-pushes, never rewrites history, and commits only after the staged
// diff passes a secret scan.

export const git = (cwd: string, args: string[], o: { signal?: AbortSignal; timeoutMs?: number; input?: string } = {}): Promise<string> =>
  capture('git', ['-c', 'color.ui=false', '-c', 'core.quotepath=off', ...args], { cwd, ...o })

export async function gitRoot(dir: string, signal?: AbortSignal): Promise<string> {
  if (!which('git')) throw new Error('git is not installed. The user can install the Xcode command line tools: xcode-select --install')
  const r = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000, signal })
  if (r.code !== 0) throw new Error(`${dir} is not inside a git repository. Initialise one with run_command "git init" if the user wants that.`)
  return r.stdout.trim()
}

export async function currentBranch(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const b = (await git(cwd, ['branch', '--show-current'], { signal })).trim()
  return b || null
}

export async function upstreamOf(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const r = await runProcess('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd, timeoutMs: 10_000, signal })
  return r.code === 0 ? r.stdout.trim() : null
}

/** "## main...origin/main [ahead 1]" plus short status lines, and a one-line summary. */
export async function status(cwd: string, signal?: AbortSignal): Promise<{ text: string; clean: boolean; staged: number; unstaged: number; untracked: number }> {
  const out = (await git(cwd, ['status', '--short', '--branch', '--untracked-files=all'], { signal })).trimEnd()
  const lines = out.split('\n').filter(Boolean)
  const files = lines.filter((l) => !l.startsWith('##'))
  const staged = files.filter((l) => /^[MADRCU]/.test(l)).length
  const unstaged = files.filter((l) => /^.[MDU]/.test(l)).length
  const untracked = files.filter((l) => l.startsWith('??')).length
  const clean = !files.length
  const sum = clean ? 'Working tree clean.' : `${staged} staged, ${unstaged} changed but not staged, ${untracked} untracked.`
  return { text: `${clip(out, 8000)}\n${sum}`, clean, staged, unstaged, untracked }
}

// ------------------------------------------------------------------ secret scan

export interface SecretFinding { file: string; line?: number; why: string; preview: string }

const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|Podfile\.lock|uv\.lock|gradle\.lockfile)$/
const NO_SCAN = /\.(min\.js|map|svg|snap|lock)$/i
const SENSITIVE_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|key|p12|pfx|keystore|jks|mobileprovision|p8)|credentials\.json|service[-_]?account[^/]*\.json|\.netrc|\.pypirc|\.npmrc|\.git-credentials|secrets?\.(ya?ml|json|toml))$/i
const PLACEHOLDER = /^(x+|\*+|\.+|changeme|change_me|password|secret|token|example|sample|dummy|placeholder|redacted|null|none|undefined|todo|test|testing|fake|foo|bar|your[_-].*|<.*>|\$\{.*\}|\$\w+|%.*%|\{\{.*\}\})$/i
const ENV_ASSIGN = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|AUTH)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'#]+)/
const LITERAL_ASSIGN = /\b(password|passwd|secret|api_?key|apikey|access_?token|auth_?token|client_?secret|private_?key)["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i
const URL_CREDS = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@'"]+):([^\s@/'"]{3,})@/i
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

const mask = (s: string): string => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`)
const placeholder = (v: string): boolean => PLACEHOLDER.test(v) || /process\.env|os\.environ|getenv|ENV\[|import\.meta\.env/i.test(v)

/** Checks one added line. Returns a reason or null. */
export function lineSecret(line: string): { why: string; value: string } | null {
  if (PEM.test(line)) return { why: 'private key block', value: 'BEGIN PRIVATE KEY' }
  const url = URL_CREDS.exec(line)
  if (url && !placeholder(url[2]) && !/^(user(name)?|pass(word)?)$/i.test(url[2])) return { why: 'password inside a URL', value: url[2] }
  const env = ENV_ASSIGN.exec(line)
  if (env && !placeholder(env[2]) && env[2].length >= 8) return { why: `value for ${env[1]}`, value: env[2] }
  const lit = LITERAL_ASSIGN.exec(line)
  if (lit && !placeholder(lit[2])) return { why: `hard-coded ${lit[1]}`, value: lit[2] }
  // Key- and token-shaped words anywhere (sk-…, ghp_…, AKIA…, JWTs, long random runs).
  for (const tok of line.split(/[\s"'`,;()[\]{}<>=]+/)) {
    if (tok.length < 12) continue
    // The assignment rule in looksLikeSecret reads code like "token:string" as a secret; words only.
    if (/^(password|passwd|passcode|api[_ -]?key|secret|token)\s*[:=]/i.test(tok)) continue
    // Hex digests (commit ids, checksums) and UUIDs are everywhere in code and aren't secrets on their own.
    if (/^[0-9a-f]{7,64}$/i.test(tok) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok)) continue
    if (/^(sha\d+|md5)-/i.test(tok)) continue
    // Long identifiers (readConfigFromEnv2024) are words, not keys: keys mix digits all through.
    if (/^[A-Za-z_$]+\d{0,6}$/.test(tok)) continue
    if (looksLikeSecret(tok)) return { why: 'looks like an API key or token', value: tok }
  }
  return null
}

/** Scans the added lines of a unified diff (e.g. `git diff --cached`) for secrets and secret files. */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const out: SecretFinding[] = []
  let file = ''
  let line = 0
  let skip = false
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { file = ''; continue }
    if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '').trim()
      skip = file === '/dev/null' || LOCKFILES.test(file) || NO_SCAN.test(file)
      if (file !== '/dev/null' && SENSITIVE_FILE.test(file)) out.push({ file, why: `${basename(file)} usually holds credentials and shouldn't be committed (add it to .gitignore)`, preview: basename(file) })
      continue
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
    if (h) { line = Number(h[1]); continue }
    if (!file || l.startsWith('---')) continue
    if (l.startsWith('+')) {
      if (!skip) {
        const hit = lineSecret(l.slice(1))
        if (hit) out.push({ file, line, why: hit.why, preview: mask(hit.value) })
      }
      line++
    } else if (l.startsWith(' ')) line++
  }
  // One finding per file and line.
  const seen = new Set<string>()
  return out.filter((f) => { const k = `${f.file}:${f.line ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true })
}

export const formatFindings = (fs: SecretFinding[]): string => fs.slice(0, 20).map((f) => `- ${f.file}${f.line ? `:${f.line}` : ''}: ${f.why} [${f.preview}]`).join('\n') + (fs.length > 20 ? `\n- … ${fs.length - 20} more` : '')

// ------------------------------------------------------------------ GitHub CLI

export const ghInstalled = (): boolean => !!which('gh')

export async function gh(cwd: string, args: string[], o: { signal?: AbortSignal; timeoutMs?: number; input?: string } = {}): Promise<string> {
  if (!ghInstalled()) throw new Error('The GitHub CLI (gh) is not installed. The user can install it with "brew install gh" and sign in with "gh auth login".')
  try {
    return await capture('gh', args, { cwd, timeoutMs: o.timeoutMs ?? 60_000, signal: o.signal, input: o.input, env: toolEnv({ GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }) })
  } catch (e) {
    const m = (e as Error).message
    if (/auth login|not logged in|authentication/i.test(m)) throw new Error('The GitHub CLI is not signed in. Ask the user to run "gh auth login" in Terminal.')
    throw e
  }
}

/** Valid branch names only (git check-ref-format rules, simplified). */
export function checkBranchName(name: string): string {
  const n = name.trim()
  if (!n || n.length > 200 || /^-|\.\.|[\s~^:?*[\\]|@\{|\/\/|\/$|\.lock$|^\/|\.$/.test(n)) throw new Error(`"${name}" is not a valid branch name. Use something like "fix/login-timeout".`)
  return n
}
