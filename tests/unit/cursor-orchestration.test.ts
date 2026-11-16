import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cursorTool } from '../../src/main/agent/tools/apps'
import { backoff, cloudRunning, composeCursorPrompt, describeCloud, newRunState, prUrlsOf, readCursorEvent } from '../../src/main/code/cursor'

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cur-')))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node ok.js' } }))
  writeFileSync(join(root, 'ok.js'), 'process.exit(0)\n')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  g(root, 'init', '-q', '-b', 'main')
  g(root, 'config', 'user.email', 't@example.com')
  g(root, 'config', 'user.name', 'T')
  g(root, 'add', '-A')
  g(root, 'commit', '-q', '-m', 'init')
  return root
}
const ctxFor = (root: string, progress?: (t: string) => void, signal = new AbortController().signal) => ({ state: { roots: [root], loaded: [], alwaysAllow: [], todos: [] }, workspaceDir: root, signal, progress }) as never

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete process.env.CURSOR_AGENT_PATH })

describe('composeCursorPrompt', () => {
  test('a complete brief with repo facts, constraints, acceptance and checks', () => {
    const p = composeCursorPrompt({
      goal: 'Add a --json flag to export.', context: 'export lives in src/cli/export.ts and writes CSV via writeRows().', files: ['src/cli/export.ts', 'src/cli/json.ts'],
      errors: 'TypeError: rows.map is not a function', constraints: ['Keep Node 18 support'], dontChange: ['the CSV output'], acceptance: ['`export --json` prints one JSON object per line'], mode: 'local'
    }, { name: 'demo', branch: 'main', project: { kinds: ['node'], test: { command: 'npm test', tool: 'vitest', kind: 'test' }, typecheck: [{ command: 'npx --no-install tsc --noEmit --pretty false', tool: 'tsc', kind: 'typecheck' }], lint: [] }, existing: { 'src/cli/export.ts': true, 'src/cli/json.ts': false } })
    expect(p).toMatch(/^# Goal\nAdd a --json flag to export\.\n\n# Context\nRepository: demo \(node\), on branch main\.\nexport lives in/)
    expect(p).toContain('- src/cli/json.ts (new file)')
    expect(p).toContain('```\nTypeError: rows.map is not a function\n```')
    expect(p).toContain('- Keep Node 18 support\n- Do not change the CSV output.')
    expect(p).toContain('Do not commit, push, reset, or delete files')
    expect(p).toContain('# Verify (all must pass before you finish)\n- `npx --no-install tsc --noEmit --pretty false`\n- `npm test`')
    expect(p).toMatch(/# Definition of done\n- Every acceptance criterion is met and every command under Verify passes\./)
  })
  test('cloud briefs ask for a PR; explicit tests win', () => {
    const p = composeCursorPrompt({ goal: 'Fix flaky test', tests: ['pytest -k login'], mode: 'cloud' })
    expect(p).toContain('open a pull request; never force-push')
    expect(p).toContain('- `pytest -k login`')
    expect(p).not.toContain('Do not commit')
  })
})

describe('cursor-agent stream-json', () => {
  test('turns events into progress and collects the result', () => {
    const st = newRunState()
    const lines = [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'gpt-5' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the export command.' }] } },
      { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'src/cli/export.ts' } } } },
      { type: 'tool_call', subtype: 'started', tool_call: { editToolCall: { args: { path: 'src/cli/export.ts' } } } },
      { type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'npm test' } } } },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 42000, result: 'Added --json.', session_id: 's1' }
    ].map((e) => readCursorEvent(JSON.stringify(e), st))
    expect(lines).toEqual(['Cursor agent started (gpt-5)', 'Cursor: Looking at the export command.', 'Reading src/cli/export.ts', 'Editing src/cli/export.ts', 'Running npm test', 'Cursor agent finished in 42s'])
    expect(st.sessionId).toBe('s1')
    expect(st.result).toBe('Added --json.')
    expect([...st.filesTouched]).toEqual(['src/cli/export.ts'])
    expect(st.commands).toEqual(['npm test'])
    expect(readCursorEvent('not json', st)).toBeNull()
  })
})

describe('cloud helpers', () => {
  test('backoff grows to a ceiling; run states', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoff(n))).toEqual([10, 15, 23, 34, 51, 60, 60])
    expect(cloudRunning('RUNNING')).toBe(true)
    expect(cloudRunning('FINISHED')).toBe(false)
    const run = { status: 'FINISHED', result: 'Done', durationMs: 90_000, git: { branches: [{ repoUrl: 'https://github.com/me/app', branch: 'cursor/x', prUrl: 'https://github.com/me/app/pull/7' }] } }
    expect(prUrlsOf(run)).toEqual(['https://github.com/me/app/pull/7'])
    expect(describeCloud({ id: 'bc-1', status: 'FINISHED', url: 'https://cursor.com/agents/bc-1' }, run)).toMatch(/Agent bc-1: FINISHED\nLatest run: FINISHED · 90s\nBranch cursor\/x on https:\/\/github\.com\/me\/app · PR https:\/\/github\.com\/me\/app\/pull\/7\nResult:\nDone/)
  })
})

describe('cursor tool', () => {
  test('effects: local agent is local, cloud asks; prompt shows in the approval', () => {
    const root = repo()
    const t = cursorTool(() => 'key', () => root, () => true)
    const eff = t.effect as (a: unknown) => string
    expect(eff({ action: 'prompt', goal: 'x' })).toBe('read')
    expect(eff({ action: 'agent', folder: root, goal: 'x' })).toBe('write_local')
    expect(eff({ action: 'cloud_launch', repo: 'r', goal: 'x' })).toBe('write_external')
    expect(eff({ action: 'cloud_wait', id: 'bc-1' })).toBe('read')
    expect(t.consequential!({ action: 'cloud_launch', repo: 'r', goal: 'x' }, { threadId: 't' })).toBe(true)
    const d = t.describe!({ action: 'agent', folder: root, goal: 'Make a.txt say two', acceptance: ['a.txt is "two"'] })
    expect(d).toMatch(/Cursor's agent will work in .* with this prompt:\n\n# Goal\nMake a\.txt say two[\s\S]*on branch main[\s\S]*- `npm test`/)
  })
  test('local agent: live progress, exact diff against a restore point, verification', async () => {
    const root = repo()
    writeFileSync(join(root, 'mine.txt'), 'user work in progress\n') // pre-existing untracked work isn't attributed to Cursor
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'bin-')))
    const fake = join(bin, 'cursor-agent')
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs')
const say = (o) => console.log(JSON.stringify(o))
say({ type: 'system', subtype: 'init', session_id: 'sess-9', model: 'fake' })
say({ type: 'tool_call', subtype: 'started', tool_call: { editToolCall: { args: { path: 'a.txt' } } } })
fs.writeFileSync('a.txt', 'two\\n')
fs.writeFileSync('b.txt', 'new file\\n')
say({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, result: 'Changed a.txt. Prompt had: ' + (process.argv[process.argv.length - 1].includes('# Definition of done') ? 'brief' : 'raw'), session_id: 'sess-9' })
`)
    chmodSync(fake, 0o755)
    process.env.CURSOR_AGENT_PATH = fake
    const progress: string[] = []
    const t = cursorTool(() => undefined, () => root, () => true)
    const r = await t.run({ action: 'agent', folder: root, goal: 'Make a.txt say two' }, ctxFor(root, (p) => progress.push(p)))
    expect(progress).toEqual(expect.arrayContaining(['Cursor agent started (fake)', 'Editing a.txt']))
    expect(r.text).toMatch(/Changed a\.txt\. Prompt had: brief/)
    expect(r.text).toMatch(/a\.txt \| 2 \+-/)
    expect(r.text).toContain('New files: b.txt')
    expect(r.text).not.toContain('mine.txt')
    expect(r.text).toMatch(/-one\n\+two/)
    expect(r.text).toMatch(/Verification:[\s\S]*PASSED/)
    expect(r.display).toBe('Cursor agent made changes · checks passed')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two\n')
  })
  test('cloud_wait polls with backoff until the run ends, then points at review', async () => {
    vi.useFakeTimers()
    const statuses = ['RUNNING', 'RUNNING', 'FINISHED']
    let runCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      const body = u.endsWith('/v1/agents/bc-1') ? { id: 'bc-1', status: 'ACTIVE', latestRunId: 'run-1' }
        : { id: 'run-1', status: statuses[Math.min(runCalls++, statuses.length - 1)], result: 'Done', git: { branches: [{ branch: 'cursor/x', prUrl: 'https://github.com/me/app/pull/7' }] } }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const progress: string[] = []
    const t = cursorTool(() => 'key', () => tmpdir())
    const p = t.run({ action: 'cloud_wait', id: 'bc-1', minutes: 5 }, ctxFor(tmpdir(), (x) => progress.push(x)))
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(15_000)
    const r = await p
    expect(runCalls).toBe(3)
    expect(progress).toEqual(['Cursor cloud agent bc-1: RUNNING', 'Cursor cloud agent bc-1: FINISHED'])
    expect(r.text).toMatch(/PR https:\/\/github\.com\/me\/app\/pull\/7[\s\S]*cloud_review/)
    expect(r.display).toBe('bc-1 · FINISHED')
  })
  test('cloud_wait stops at its time limit instead of looping', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith('bc-2') ? { id: 'bc-2', status: 'ACTIVE', latestRunId: 'r' } : { id: 'r', status: 'RUNNING' }), { status: 200 })))
    const t = cursorTool(() => 'key', () => tmpdir())
    const p = t.run({ action: 'cloud_wait', id: 'bc-2', minutes: 1 }, ctxFor(tmpdir()))
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(15_000)
    const r = await p
    expect(r.text).toMatch(/Still RUNNING after waiting[\s\S]*don't loop/)
  })
  test('cloud launch sends the composed brief and asks for a PR', async () => {
    let sent: any
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ agent: { id: 'bc-3', url: 'https://cursor.com/agents/bc-3' }, run: { status: 'CREATING' } }), { status: 200 }) }))
    const t = cursorTool(() => 'key', () => tmpdir())
    const r = await t.run({ action: 'cloud_launch', repo: 'https://github.com/me/app', ref: 'dev', goal: 'Add dark mode', acceptance: ['toggle persists'] }, ctxFor(tmpdir()))
    expect(sent.repos).toEqual([{ url: 'https://github.com/me/app', startingRef: 'dev' }])
    expect(sent.autoCreatePR).toBe(true)
    expect(sent.prompt.text).toMatch(/# Goal\nAdd dark mode[\s\S]*Repository: me\/app[\s\S]*open a pull request[\s\S]*- toggle persists/)
    expect(r.text).toMatch(/Started Cursor cloud agent bc-3/)
  })
  test('cloud actions need a key', async () => {
    await expect(cursorTool(() => undefined).run({ action: 'cloud_list' }, ctxFor(tmpdir()))).rejects.toThrow(/API key/)
  })
})
