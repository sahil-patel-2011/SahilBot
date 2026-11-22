import { execSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detectAddresses, JobManager, jobLine, patternOf, portOpen } from '../../src/main/jobs/manager'
import { jobsTool } from '../../src/main/agent/tools/jobs'
import { shellTool } from '../../src/main/agent/tools/shell'
import { emptyState, type ToolContext } from '../../src/main/agent/types'
import { runFacts, statusLine, summaryText, usageText, fmtTokens } from '../../src/renderer/src/lib/run-summary'
import type { Message } from '../../src/shared/types'

const dir = mkdtempSync(join(tmpdir(), 'sb-jobs-'))
const managers: JobManager[] = []
const mk = (o: ConstructorParameters<typeof JobManager>[0] = {}): JobManager => { const m = new JobManager(o); managers.push(m); return m }
afterEach(async () => { for (const m of managers.splice(0)) await m.stopAll(500) })

const ctx = (threadId: string, rootId?: string): ToolContext => ({
  threadId, signal: new AbortController().signal, workspaceDir: dir, docsDir: dir,
  askUser: async () => '', state: { ...emptyState(), rootId }
} as unknown as ToolContext)

describe('addresses in dev-server output', () => {
  test('Vite, Next, Rails, 0.0.0.0 and "port N"', () => {
    expect(detectAddresses('  ➜  Local:   http://localhost:5173/')).toEqual({ urls: ['http://localhost:5173/'], ports: [5173] })
    expect(detectAddresses('- Local:        http://localhost:3000').urls).toEqual(['http://localhost:3000'])
    expect(detectAddresses('* Listening on http://127.0.0.1:3000').ports).toEqual([3000])
    expect(detectAddresses('Serving on http://0.0.0.0:8000/').urls).toEqual(['http://localhost:8000/'])
    expect(detectAddresses('Server listening on port 4000').ports).toEqual([4000])
    expect(detectAddresses('\x1b[32mhttp://localhost:4321\x1b[0m').urls).toEqual(['http://localhost:4321'])
    expect(detectAddresses('see https://vitejs.dev/config').urls).toEqual([])
  })
  test('patterns: text is literal, regex is a regex, both case-insensitive', () => {
    expect(patternOf({ text: 'ready in (1s)' })!.test('READY IN (1s)')).toBe(true)
    expect(patternOf({ regex: 'ready in \\d+ ms' })!.test('ready in 312 ms')).toBe(true)
    expect(patternOf({ regex: '([' })!.test('x ([ y')).toBe(true)
  })
})

describe('JobManager', () => {
  test('runs a job, keeps its output, finds its URL and waits for text', async () => {
    const m = mk()
    const j = m.start({ threadId: 't1', command: 'echo starting; sleep 0.2; echo "  Local:   http://localhost:5199/"; sleep 30', cwd: dir })
    expect(j.status === 'running' || j.status === 'starting').toBe(true)
    const r = await m.wait(j.id, { text: 'Local:', timeout: 10 })
    expect(r.ok).toBe(true)
    expect(r.reason).toBe('matched')
    expect(m.get(j.id)!.status).toBe('ready')
    expect(m.get(j.id)!.urls).toEqual(['http://localhost:5199/'])
    expect(m.output(j.id).lines).toEqual(['starting', '  Local:   http://localhost:5199/'])
    expect(m.output(j.id, { grep: 'local' }).lines).toHaveLength(1)
    expect(m.output(j.id, { grep: '/^start/' }).lines).toEqual(['starting'])
    // Text printed before the wait started still counts.
    expect((await m.wait(j.id, { text: 'starting', timeout: 1 })).ok).toBe(true)
    expect(jobLine(m.get(j.id)!)).toContain('http://localhost:5199/')
  })

  test('stop reaches the whole process group (children too)', async () => {
    const m = mk()
    const j = m.start({ threadId: 't1', command: 'sleep 60 & sleep 60 & echo up; wait', cwd: dir })
    await m.wait(j.id, { text: 'up', timeout: 10 })
    const pid = m.get(j.id)!.pid!
    const s = await m.stop(j.id, 1000)
    expect(s!.status).toBe('stopped')
    // Killed children can linger as zombies where nothing reaps orphans (a container's PID 1): those are dead.
    const live = execSync('ps -A -o pgid=,stat=').toString().split('\n').map((l) => l.trim().split(/\s+/)).filter(([g, st]) => Number(g) === pid && st && !st.startsWith('Z'))
    expect(live).toHaveLength(0)
  })

  test('wait for exit reports success and failure; restart reruns under the same id', async () => {
    const m = mk()
    const ok = m.start({ threadId: 't1', command: 'echo done', cwd: dir })
    expect((await m.wait(ok.id, { exit: true, timeout: 10 })).ok).toBe(true)
    expect(m.get(ok.id)!.status).toBe('exited')
    expect(m.get(ok.id)!.exitCode).toBe(0)
    const bad = m.start({ threadId: 't1', command: 'echo oops >&2; exit 3', cwd: dir })
    const r = await m.wait(bad.id, { exit: true, timeout: 10 })
    expect(r.ok).toBe(false)
    expect(m.get(bad.id)!.status).toBe('failed')
    expect(m.get(bad.id)!.exitCode).toBe(3)
    expect(m.output(bad.id).lines).toContain('oops')
    // Waiting for text on a job that already ended says so instead of hanging.
    expect((await m.wait(bad.id, { text: 'never', timeout: 5 })).reason).toBe('exited')
    const again = await m.restart(ok.id)
    expect(again!.id).toBe(ok.id)
    expect(again!.restarts).toBe(1)
    await m.wait(ok.id, { exit: true, timeout: 10 })
    expect(m.output(ok.id).lines.filter((l) => l === 'done')).toHaveLength(2)
  })

  test('readiness by port, and a timeout when nothing comes', async () => {
    const srv = createServer().listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const port = (srv.address() as { port: number }).port
    expect(await portOpen(port)).toBe(true)
    const m = mk()
    const j = m.start({ threadId: 't1', command: 'sleep 30', cwd: dir })
    const r = await m.wait(j.id, { port, timeout: 5 })
    expect(r.reason).toBe('port')
    srv.close()
    const t = await m.wait(j.id, { text: 'never printed', timeout: 1 })
    expect(t.ok).toBe(false)
    expect(t.reason).toBe('timeout')
  })

  test('at most N jobs run at once', async () => {
    const m = mk({ maxJobs: 2 })
    m.start({ threadId: 't1', command: 'sleep 30', cwd: dir })
    m.start({ threadId: 't2', command: 'sleep 30', cwd: dir })
    expect(() => m.start({ threadId: 't1', command: 'sleep 30', cwd: dir })).toThrow(/already running/)
    expect(m.running()).toHaveLength(2)
  })

  test('the output buffer keeps the last lines only; long lines are cut', async () => {
    const m = mk({ maxLines: 50 })
    const j = m.start({ threadId: 't1', command: 'for i in $(seq 1 400); do echo line$i; done; printf "%05000d\\n" 7', cwd: dir })
    await m.wait(j.id, { exit: true, timeout: 10 })
    const out = m.output(j.id, { tail: 1000 })
    // A 5000-character line arrives in pieces of at most 2000 characters.
    expect(out.total).toBeGreaterThanOrEqual(401)
    expect(out.lines.length).toBeLessThanOrEqual(50)
    expect(out.lines).toContain('line400')
    expect(out.lines).not.toContain('line1')
    expect(Math.max(...out.lines.map((l) => l.length))).toBe(2000)
  })

  test('deleting a chat stops its jobs and forgets them; other chats keep theirs', async () => {
    const m = mk()
    const a = m.start({ threadId: 'gone', command: 'sleep 30', cwd: dir })
    const b = m.start({ threadId: 'kept', command: 'sleep 30', cwd: dir })
    const events: string[] = []
    m.onEvent((e) => { if (e.kind === 'removed') events.push(e.id) })
    await m.stopThreads(['gone'])
    expect(m.get(a.id)).toBeUndefined()
    expect(events).toEqual([a.id])
    expect(m.get(b.id)!.status).toBe('running')
  })

  test('lines reach listeners in batches', async () => {
    const m = mk()
    const got: string[] = []
    m.onEvent((e) => { if (e.kind === 'lines') got.push(...e.lines) })
    const j = m.start({ threadId: 't1', command: 'echo a; echo b', cwd: dir })
    await m.wait(j.id, { exit: true, timeout: 10 })
    await new Promise((r) => setTimeout(r, 50))
    expect(got).toEqual(['a', 'b'])
  })
})

describe('run_command background and the jobs tool', () => {
  test('starts a job, waits for readiness and reports the URL', async () => {
    const m = mk()
    const sh = shellTool({ jobs: m })
    const out = await sh.run({ command: 'sleep 0.2; echo "ready: http://localhost:5299"; sleep 30', background: true, wait_for: { text: 'ready', timeout: 10 } }, ctx('chat1'))
    expect(out.text).toMatch(/Background job j1: ready/)
    expect(out.text).toContain('URL: http://localhost:5299')
    expect(out.meta).toMatchObject({ job: { id: 'j1', url: 'http://localhost:5299' } })
    expect(m.get('j1')!.threadId).toBe('chat1')
  })
  test('a job that fails right away says so', async () => {
    const m = mk()
    const out = await shellTool({ jobs: m }).run({ command: 'echo "boom" >&2; exit 2', background: true }, ctx('chat1'))
    expect(out.text).toMatch(/stopped with exit code 2/)
    expect(out.text).toContain('boom')
  })
  test('a helper agent\'s jobs belong to the chat that started it', async () => {
    const m = mk()
    await shellTool({ jobs: m }).run({ command: 'sleep 30', background: true, wait_for: { text: 'x', timeout: 1 } }, ctx('helper', 'root'))
    expect(m.list('root')).toHaveLength(1)
  })
  test('jobs tool: list, output, wait, stop; only this chat\'s jobs', async () => {
    const m = mk()
    const tool = jobsTool({ jobs: m })
    const j = m.start({ threadId: 'c1', command: 'echo hello; sleep 30', cwd: dir })
    const other = m.start({ threadId: 'c2', command: 'sleep 30', cwd: dir })
    expect((await tool.run({ action: 'wait', id: j.id, text: 'hello', timeout: 10 }, ctx('c1'))).text).toMatch(/^Done: matched/)
    expect((await tool.run({ action: 'list' }, ctx('c1'))).text).toContain(j.id)
    expect((await tool.run({ action: 'list' }, ctx('c1'))).text).not.toContain(other.id)
    expect((await tool.run({ action: 'output', id: j.id }, ctx('c1'))).text).toContain('hello')
    await expect(tool.run({ action: 'stop', id: other.id }, ctx('c1'))).rejects.toThrow(/No job/)
    expect((await tool.run({ action: 'stop', id: j.id }, ctx('c1'))).text).toMatch(/Stopped/)
    expect(m.get(j.id)!.status).toBe('stopped')
  })
  test('effects: looking is a read, stop is a local change, restart is what the command is', () => {
    const m = mk()
    const tool = jobsTool({ jobs: m })
    const eff = tool.effect as (a: Record<string, unknown>) => string
    const j = m.start({ threadId: 'c1', command: 'npm install left-pad && sleep 5', cwd: dir })
    expect(eff({ action: 'list' })).toBe('read')
    expect(eff({ action: 'output', id: j.id })).toBe('read')
    expect(eff({ action: 'wait', id: j.id })).toBe('read')
    expect(eff({ action: 'stop', id: j.id })).toBe('write_local')
    expect(eff({ action: 'restart', id: j.id })).toBe('write_external')
  })
})

describe('end-of-run summary', () => {
  let n = 0
  const msg = (p: Partial<Message>): Message => ({ id: `m${++n}`, threadId: 't', role: 'tool', kind: 'normal', status: 'done', content: '', createdAt: 1000 + n, ...p } as Message)
  const tool = (name: string, args: Record<string, unknown>, meta: Record<string, unknown> = {}) => msg({ role: 'tool', toolName: name, meta: { status: 'ok', args: JSON.stringify(args), ...meta } })
  test('counts commands, edited files and jobs of the last run only', () => {
    const ms = [
      msg({ role: 'user', content: 'old' }), tool('run_command', { command: 'ls' }), msg({ role: 'assistant', content: 'ok' }),
      msg({ role: 'user', content: 'build it' }),
      tool('run_command', { command: 'npm ci' }), tool('run_command', { command: 'npm test' }), tool('code', { action: 'run_tests' }),
      tool('file_write', { path: 'a.ts' }, { path: '/w/a.ts' }), tool('code', { action: 'edit', path: 'b.ts' }), tool('code', { action: 'edit', path: 'b.ts' }),
      tool('code', { action: 'apply_patch', patch: '*** Update File: c.ts\n*** Add File: d.ts\n' }),
      tool('run_command', { command: 'npm run dev', background: true }),
      tool('run_command', { command: 'git push' }, { status: 'denied' }),
      msg({ role: 'user', content: 'steer', meta: { steer: true } }),
      msg({ role: 'assistant', content: 'done' })
    ]
    const f = runFacts(ms)!
    expect(f).toMatchObject({ commands: 3, files: 4, jobs: 1 })
    expect(summaryText(f, { autonomous: true, asked: 0 })).toBe('Ran 3 commands, edited 4 files, started 1 job — 0 needed you')
    expect(summaryText(f, { autonomous: false })).toBe('Ran 3 commands, edited 4 files, started 1 job')
    // The line under the reply: plain words; tokens live in the hover card.
    const u = { input: 300, output: 60, usd: 0.0004, cloud: true, calls: 1, models: [] }
    expect(statusLine(f, u)).toBe('Done · 8 actions · 4 files changed · 1 background job started · <$0.01')
    expect(statusLine(f, u, { asked: 1 })).toContain('asked you once')
    expect(statusLine({ ...f, actions: 1, files: 0, jobs: 0, commands: 0 }, u)).toBe('Done · 1 action · <$0.01')
    expect(statusLine({ ...f, actions: 0, files: 0, jobs: 0, commands: 0 }, null)).toBe('')
    expect(statusLine({ ...f, actions: 1, files: 0, jobs: 0, commands: 0 }, { ...u, cloud: false })).toBe('Done · 1 action · free (local)')
  })
  test('tokens and cost', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(48_200)).toBe('48k')
    expect(fmtTokens(1234)).toBe('1.2k')
    const cloud = { input: 41_000, output: 7200, usd: 0.0612, cloud: true, calls: 3, models: [] }
    expect(usageText(cloud, true)).toBe('48k tokens (41k in / 7.2k out) · $0.06')
    expect(usageText({ ...cloud, usd: 0, cloud: false }, false)).toBe('48k tokens · free (local)')
    expect(usageText({ ...cloud, input: 0, output: 0 }, true)).toBe('')
  })
  test('a run still waiting for its first reply has no summary', () => {
    expect(runFacts([msg({ role: 'user', content: 'hi' })])).toBeNull()
  })
})
