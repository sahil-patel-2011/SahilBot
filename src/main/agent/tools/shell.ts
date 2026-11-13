import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type { ToolEffect } from '@shared/types'
import { runProcess, stripAnsi, throttle } from '../../code/proc'
import type { ToolContext, ToolDef } from '../types'

// Run a terminal command. What it can do decides who must approve it:
// - looks only (ls, cat, git status, grep…): runs freely;
// - changes files in the workspace (build, test, git commit…): runs in Auto, asks in Ask;
// - reaches outside this Mac or installs things (npm install, curl, git push…): asks in Auto;
// - deletes or rewrites history (rm, git reset --hard…): always asks, even in Bypass;
// - system-level (sudo, disk tools, shutdown…): refused.

type Args = { command: string; cwd?: string; timeout?: number }

const READ_ONLY = /^\s*(ls|ll|pwd|cat|head|tail|less|wc|file|stat|du|df|which|whereis|type|echo|printf|date|cal|uname|whoami|id|printenv|grep|egrep|rg|ag|find|fd|tree|sort|uniq|cut|tr|diff|cmp|jq|yq|sw_vers|sysctl -n|system_profiler|ps|top -l 1|lsof|node -v|node --version|python3? -V|python3? --version|npm (ls|view|outdated|-v|--version)|pnpm (ls|-v)|yarn (list|-v)|git (status|log|diff|show|branch|remote -v|rev-parse|ls-files|blame|describe|tag$|stash list)|swift --version|xcodebuild -version|brew (list|info|search|outdated|--version)|mdfind|mdls|open -R)(\s|$)/
// Read-only commands that write files or run other programs when given these options.
const ACTS = /^\s*(find\s.*\s-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)\b|sort\s(.*\s)?(-[a-zA-Z]*o|--output)|yq\s(.*\s)?(-[a-zA-Z]*i|--inplace)\b|git\s.*--output\b|git\s+branch\s+(.*\s)?(-[dDmMcCfu]|--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)|[^-\s])|tree\s(.*\s)?-o\b|less\s(.*\s)?-[a-zA-Z]*[oO]|rg\s(.*\s)?--pre\b|fd\s(.*\s)?(-[xX]|--exec))/
const RM = /(^|[\s;&|(/\\"'`])(rm|rmdir|unlink|shred|trash|srm)["']?(\s|$)/
const TRUNCATE = /(^|[;(\n]|&&|\|\||[&|]\s)\s*(:|true|cat\s+\/dev\/null|echo\s+-n|printf\s+(''|""))?\s*>\|?\s*(?!&|\/dev\/null\b)[^\s>]|\bcp\s+\/dev\/null\s|\bmv\s.*\s\/dev\/null\b|\btruncate\s/
const GIT_DISCARD = /git\s+(reset\s+--hard|clean\b[^;&|\n]*\s-(-force|[a-zA-Z]*f)|push\b[^;&|\n]*\s(-f|--force)|branch\s+(-D|--delete\s+--force)|checkout\b[^;&|\n]*(\s--(\s|$)|\s\.(\s|$)|\s-f\b|\s--force\b)|restore\b(?![^;&|\n]*(--staged|\s-S\b))|restore\b[^;&|\n]*(--worktree|\s-W\b)|stash\s+(drop|clear))/
const DELETES = /find\s.*-delete|>\s*\/dev\/(disk|rdisk)/
const SYSTEM = /(^|[\s;&|(])(sudo|su|doas|dd|mkfs|diskutil|fdisk|shutdown|reboot|halt|launchctl|csrutil|spctl|systemsetup|networksetup|pmset|defaults\s+write|chown\s+-R\s+\/|chmod\s+-R\s+[0-7]*\s+\/(\s|$)|nvram|kextload|tccutil)\b|:\(\)\s*\{|rm\s+-rf?\s+(\/|~)\s*$/
const OUTSIDE = /(^|[\s;&|(])(curl|wget|ssh|scp|rsync|ftp|nc|telnet|gh|vercel|netlify|heroku|fly|aws|gcloud|az|docker\s+push|npm\s+(publish|install|i|add|ci|update)|pnpm\s+(add|install|i|publish)|yarn\s+(add|install|publish)|pip3?\s+install|uv\s+(add|pip\s+install)|brew\s+(install|upgrade|uninstall|tap)|gem\s+install|cargo\s+(install|publish)|git\s+(push|pull|fetch|clone)|open\s+https?:|osascript)\b|\|\s*(ba|z)?sh\b/

const deletes = (c: string): boolean => RM.test(c) || TRUNCATE.test(c) || GIT_DISCARD.test(c) || DELETES.test(c)

/** uniq IN OUT writes OUT. */
function uniqWrites(seg: string): boolean {
  const m = /^\s*uniq\s+(.*)$/.exec(seg)
  if (!m) return false
  const t = m[1].split(/\s+/).filter(Boolean)
  let files = 0
  for (let i = 0; i < t.length; i++) {
    if (/^-[fs]$/.test(t[i])) i++
    else if (t[i] !== '-' && !t[i].startsWith('-')) files++
  }
  return files >= 2
}

function readOnly(c: string): boolean {
  // Command substitution and process substitution run code wherever they appear.
  if (/[`]|\$\(|[<>]\(/.test(c)) return false
  // Quoted text is inert once substitutions are ruled out.
  const s = c.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
  if (/[\n\r]/.test(s) || /(^|[^&>|])&(?![&>])/.test(s)) return false
  // Redirection into a file writes it (not /dev/null, not fd duplication like 2>&1).
  const t = s.replace(/(\d*|&)>>?\s*\/dev\/null\b|\d*>&\d+/g, '')
  if (/>/.test(t)) return false
  const parts = t.split(/\s*(?:&&|\|\||;|\||&)\s*/).filter(Boolean)
  return parts.length > 0 && parts.every((p) => READ_ONLY.test(p) && !ACTS.test(p) && !uniqWrites(p))
}

export function classify(cmd: string): { effect: ToolEffect; why: string } {
  const c = cmd.trim()
  if (SYSTEM.test(c)) return { effect: 'destructive', why: 'system-level command' }
  if (deletes(c)) return { effect: 'destructive', why: 'deletes files or rewrites history' }
  if (OUTSIDE.test(c)) return { effect: 'write_external', why: 'reaches outside this Mac or installs software' }
  // Each part of a pipeline/sequence must be read-only for the whole to be.
  if (readOnly(c)) return { effect: 'read', why: 'only looks' }
  return { effect: 'write_local', why: 'may change files in your folders' }
}

/** Commands run in the workspace, the project folder or a folder attached to this chat. */
export function cwdFor(p: string | undefined, ctx: Pick<ToolContext, 'state' | 'workspaceDir'>): string {
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
    hardStop: (a) => (SYSTEM.test(a.command) ? `"${a.command.slice(0, 80)}" is a system-level command` : deletes(a.command) ? `"${a.command.slice(0, 80)}" deletes files or rewrites history` : null),
    describe: (a) => `Run in Terminal: ${a.command.slice(0, 200)}${a.cwd ? ` (in ${a.cwd})` : ''} · ${classify(a.command).why}`,
    description: 'Run a shell command (zsh) on this Mac in the workspace or an attached/project folder, and get its output and exit code. Use it for builds, tests, git, scripts, file conversions and anything a terminal does. Prefer one clear command per call; check the exit code. Long-running servers: add a timeout or run them in the background with "&" and a log file. Deleting files always asks the user. In code projects prefer the code tool (search, edit, apply_patch, run_tests, typecheck, lint) and the git tool: they return parsed, compact results.',
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
      // Its own process group, so Stop and timeouts reach everything it started.
      const tick = throttle<string>((l) => ctx.progress?.(l), 700)
      const out = await runProcess('/bin/zsh', ['-lc', a.command], {
        cwd,
        timeoutMs: limit,
        signal: ctx.signal,
        onLine: (l) => { if (l.trim()) tick.push(l.trim().slice(0, 160)) }
      })
      tick.flush()
      const clean = stripAnsi(out.output).trimEnd()
      const status = out.timedOut ? `stopped after ${limit / 1000}s` : out.stopped ? 'stopped' : `exit code ${out.code}`
      return { text: `$ ${a.command}\n(in ${cwd}; ${status})\n${clean || '(no output)'}`, display: `${a.command.slice(0, 60)} · ${status}` }
    }
  }
}
