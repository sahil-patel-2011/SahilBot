import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

// Finding the user's own Codex install and asking it, through its documented commands, whether it is
// signed in. SahilBot never opens Codex's credential store (~/.codex/auth.json or the Keychain item):
// `codex login status` is the only way it learns the sign-in state.

/** Where the official installers put `codex` (npm -g, Homebrew, the standalone installer, the Codex app). */
export function candidatePaths(home = homedir()): string[] {
  return [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.local/bin/codex'),
    join(home, '.npm-global/bin/codex'),
    join(home, '.bun/bin/codex'),
    join(home, '.volta/bin/codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
    join(home, 'Applications/Codex.app/Contents/Resources/codex')
  ]
}

const executable = (p: string): boolean => {
  try { accessSync(p, constants.X_OK); return true } catch { return false }
}

/** PATH for running codex: its own folder first (an npm install needs the node next to it), then the usual ones. */
export function codexPath(bin: string, base = process.env.PATH ?? ''): string {
  const extra = [dirname(bin), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), '/usr/bin', '/bin']
  const have = base.split(delimiter).filter(Boolean)
  return [...new Set([...extra, ...have])].join(delimiter)
}

export const codexEnv = (bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env, PATH: codexPath(bin), NO_COLOR: '1', TERM: 'dumb', ...extra
})

export function run(bin: string, args: string[], o: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    execFile(bin, args, { timeout: o.timeoutMs ?? 10_000, env: o.env ?? codexEnv(bin), maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      ok({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) })
    })
  })
}

/** The login shell's `command -v codex` (nvm, asdf and custom PATHs live in the user's zsh profile). */
async function fromShell(): Promise<string | undefined> {
  const r = await run('/bin/zsh', ['-lc', 'command -v codex'], { timeoutMs: 4000, env: { ...process.env } }).catch(() => undefined)
  const p = r?.code === 0 ? r.stdout.trim().split('\n').pop()?.trim() : undefined
  return p && p.startsWith('/') && executable(p) ? p : undefined
}

/**
 * The codex executable: SAHILBOT_CODEX_PATH (tests), the path the user chose, the usual install
 * folders, then the login shell. undefined: not installed.
 */
export async function findCodex(chosen?: string): Promise<string | undefined> {
  const env = process.env.SAHILBOT_CODEX_PATH
  if (env) return existsSync(env) ? env : undefined
  for (const p of [chosen, ...candidatePaths()]) if (p && existsSync(p) && executable(p)) return p
  if (process.platform === 'win32') return undefined
  return fromShell()
}

export async function codexVersion(bin: string): Promise<string | undefined> {
  const r = await run(bin, ['--version'], { timeoutMs: 8000 })
  if (r.code !== 0) return undefined
  return (r.stdout.trim().match(/\d+\.\d+[\w.+-]*/)?.[0]) ?? (r.stdout.trim() || undefined)
}

export type LoginMode = 'chatgpt' | 'apikey' | 'accesstoken' | 'none'

/**
 * `codex login status` (documented: prints the active auth mode, exit 0 when logged in). Reads the
 * words it prints ("Logged in using ChatGPT", "Logged in using an API key"), not any credential.
 */
export function parseLoginStatus(code: number, out: string): { mode: LoginMode; text: string } {
  const text = out.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)
  if (code !== 0 || /not logged in|no credentials|logged out/i.test(text)) return { mode: 'none', text }
  if (/chatgpt/i.test(text)) return { mode: 'chatgpt', text }
  if (/access token/i.test(text)) return { mode: 'accesstoken', text }
  if (/api key/i.test(text)) return { mode: 'apikey', text }
  // Logged in, method not named: Codex's default sign-in is ChatGPT, but say we don't know.
  return { mode: 'chatgpt', text }
}

export async function loginStatus(bin: string): Promise<{ mode: LoginMode; text: string }> {
  const r = await run(bin, ['login', 'status'], { timeoutMs: 10_000 })
  return parseLoginStatus(r.code, `${r.stdout}\n${r.stderr}`)
}

/** A server of the user's to switch off, with its transport: `mcp_servers.<name>.enabled=false` alone makes Codex reject the config ("invalid transport"). */
export interface McpServerOff { name: string; command?: string; url?: string }

/**
 * MCP servers that are on in the user's own Codex config or plugins (`codex mcp list --json`), so a SahilBot run
 * can switch them off: tools that run outside SahilBot's approvals have no place in its runs.
 */
export async function userMcpServers(bin: string): Promise<McpServerOff[]> {
  const r = await run(bin, ['mcp', 'list', '--json'], { timeoutMs: 8000 }).catch(() => undefined)
  if (!r || r.code !== 0) return []
  return parseMcpServers(r.stdout)
}

export function parseMcpServers(out: string): McpServerOff[] {
  let j: unknown
  try { j = JSON.parse(out.trim() || '[]') } catch { return [] }
  const list: unknown[] = Array.isArray(j) ? j : j && typeof j === 'object' ? (Array.isArray((j as { servers?: unknown }).servers) ? (j as { servers: unknown[] }).servers : Object.entries(j as object).map(([name, v]) => ({ ...(v && typeof v === 'object' ? v : {}), name }))) : []
  const seen = new Map<string, McpServerOff>()
  for (const x of list) {
    const o = (typeof x === 'string' ? { name: x } : x && typeof x === 'object' ? x : {}) as { name?: unknown; enabled?: unknown; transport?: { command?: unknown; url?: unknown } }
    if (typeof o.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.name) || o.enabled === false) continue
    const command = typeof o.transport?.command === 'string' ? o.transport.command : undefined
    const url = typeof o.transport?.url === 'string' ? o.transport.url : undefined
    seen.set(o.name, { name: o.name, ...(command ? { command } : url ? { url } : {}) })
  }
  return [...seen.values()]
}

/** Names only (the servers that are on). */
export const parseMcpList = (out: string): string[] => parseMcpServers(out).map((x) => x.name)
