import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { ToolEffect } from '@shared/types'
import type { ToolContext, ToolDef } from '../types'

// Run a terminal command. What it can do decides who must approve it:
// - looks only (ls, cat, git status, grep…): runs freely;
// - changes files in the workspace (build, test, git commit…): runs in Auto, asks in Ask;
// - reaches outside this Mac or installs things (npm install, curl, git push…): asks in Auto;
// - deletes or rewrites history (rm, git reset --hard…): always asks, even in Bypass;
// - system-level (sudo, disk tools, shutdown…): refused.

type Args = { command: string; cwd?: string; timeout?: number }

const READ_ONLY = /^\s*(ls|ll|pwd|cat|head|tail|less|wc|file|stat|du|df|which|whereis|type|echo|printf|date|cal|uname|whoami|id|env|printenv|grep|egrep|rg|ag|find|fd|tree|sort|uniq|cut|tr|diff|cmp|jq|yq|sw_vers|sysctl -n|system_profiler|ps|top -l 1|lsof|node -v|node --version|python3? -V|python3? --version|npm (ls|view|outdated|-v|--version)|pnpm (ls|-v)|yarn (list|-v)|git (status|log|diff|show|branch|remote -v|rev-parse|ls-files|blame|describe|tag$|stash list)|swift --version|xcodebuild -version|brew (list|info|search|outdated|--version)|mdfind|mdls|open -R)\b/
const DELETES = /(^|[\s;&|(])(rm|rmdir|unlink|shred|trash)\s|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f|--force)|branch\s+-D|checkout\s+--\s)|>\s*\/dev\/(disk|rdisk)|find\s.*-delete|truncate\s/
const SYSTEM = /(^|[\s;&|(])(sudo|su|doas|dd|mkfs|diskutil|fdisk|shutdown|reboot|halt|launchctl|csrutil|spctl|systemsetup|networksetup|pmset|defaults\s+write|chown\s+-R\s+\/|chmod\s+-R\s+[0-7]*\s+\/(\s|$)|nvram|kextload|tccutil)\b|:\(\)\s*\{|rm\s+-rf?\s+(\/|~)\s*$/
const OUTSIDE = /(^|[\s;&|(])(curl|wget|ssh|scp|rsync|ftp|nc|telnet|gh|vercel|netlify|heroku|fly|aws|gcloud|az|docker\s+push|npm\s+(publish|install|i|add|ci|update)|pnpm\s+(add|install|i|publish)|yarn\s+(add|install|publish)|pip3?\s+install|uv\s+(add|pip\s+install)|brew\s+(install|upgrade|uninstall|tap)|gem\s+install|cargo\s+(install|publish)|git\s+(push|pull|fetch|clone)|open\s+https?:|osascript)\b|\|\s*(ba|z)?sh\b/

export function classify(cmd: string): { effect: ToolEffect; why: string } {
  const c = cmd.trim()
  if (SYSTEM.test(c)) return { effect: 'destructive', why: 'system-level command' }
  if (DELETES.test(c)) return { effect: 'destructive', why: 'deletes files or rewrites history' }
  if (OUTSIDE.test(c)) return { effect: 'write_external', why: 'reaches outside this Mac or installs software' }
  // Each part of a pipeline/sequence must be read-only for the whole to be.
  const parts = c.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)
  if (parts.length && parts.every((p) => READ_ONLY.test(p)) && !/[^>]>[^>&]|>>/.test(` ${c}`)) return { effect: 'read', why: 'only looks' }
  return { effect: 'write_local', why: 'may change files in your folders' }
}

/** Commands run in the workspace, the project folder or a folder attached to this chat. */
function cwdFor(p: string | undefined, ctx: ToolContext): string {
  const base = ctx.state.roots?.find((r) => existsSync(r) && statSync(r).isDirectory()) ?? ctx.workspaceDir
  if (!p) return base
  const abs = isAbsolute(p) ? p : resolve(ctx.workspaceDir, p)
  const real = existsSync(abs) ? realpathSync(abs) : abs
  const roots = [ctx.workspaceDir, ...(ctx.state.roots ?? [])].map((r) => (existsSync(r) ? realpathSync(r) : r))
  if (!roots.some((r) => real === r || real.startsWith(r + sep))) throw new Error(`${p} is outside the workspace and the folders attached to this chat. Attach the folder first.`)
  return real
}

export function shellTool(): ToolDef<Args> {
  return {
    name: 'run_command',
    label: 'Terminal',
    core: true,
    untrusted: true,
    effect: (a) => classify(a.command).effect,
    // Installs, pushes and network commands are never routine: Auto asks.
    consequential: () => true,
    // Deleting always asks, even in Bypass (same rule as deleting a file).
    hardStop: (a) => (SYSTEM.test(a.command) ? `"${a.command.slice(0, 80)}" is a system-level command` : DELETES.test(a.command) ? `"${a.command.slice(0, 80)}" deletes files or rewrites history` : null),
    describe: (a) => `Run in Terminal: ${a.command.slice(0, 200)}${a.cwd ? ` (in ${a.cwd})` : ''} · ${classify(a.command).why}`,
    description: 'Run a shell command (zsh) on this Mac in the workspace or an attached/project folder, and get its output and exit code. Use it for builds, tests, git, scripts, file conversions and anything a terminal does. Prefer one clear command per call; check the exit code. Long-running servers: add a timeout or run them in the background with "&" and a log file. Deleting files always asks the user.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command, e.g. "npm test" or "git status"' },
        cwd: { type: 'string', description: 'Folder to run in (default: the attached/project folder, else the workspace)' },
        timeout: { type: 'integer', minimum: 1, maximum: 1800, description: 'Seconds before it is stopped (default 120)' }
      },
      required: ['command'],
      additionalProperties: false
    },
    async run(a, ctx) {
      if (SYSTEM.test(a.command)) throw new Error('System-level commands (sudo, disk tools, shutdown, security settings) are not run by SahilBot. Ask the user to run it themselves in Terminal.')
      const cwd = cwdFor(a.cwd, ctx)
      const limit = Math.min(a.timeout ?? 120, 1800) * 1000
      const out = await new Promise<{ code: number | null; text: string; timedOut: boolean }>((done) => {
        const child = spawn('/bin/zsh', ['-lc', a.command], {
          cwd,
          env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:${join(homedir(), '.local/bin')}`, CI: '1', TERM: 'dumb', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let text = ''
        const add = (b: Buffer): void => { if (text.length < 400_000) text += b.toString() }
        child.stdout.on('data', add)
        child.stderr.on('data', add)
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000) }, limit)
        const stop = (): void => { child.kill('SIGTERM') }
        ctx.signal.addEventListener('abort', stop, { once: true })
        child.on('close', (code) => { clearTimeout(timer); ctx.signal.removeEventListener('abort', stop); done({ code, text, timedOut }) })
        child.on('error', (e) => { clearTimeout(timer); done({ code: -1, text: e.message, timedOut: false }) })
      })
      // eslint-disable-next-line no-control-regex
      const clean = out.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd()
      const status = out.timedOut ? `stopped after ${limit / 1000}s` : `exit code ${out.code}`
      return { text: `$ ${a.command}\n(in ${cwd}; ${status})\n${clean || '(no output)'}`, display: `${a.command.slice(0, 60)} · ${status}` }
    }
  }
}
