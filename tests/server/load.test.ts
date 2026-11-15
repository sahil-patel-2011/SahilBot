import { mkdtempSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { invoke, addAdapter } from '../../src/main/rpc'
import { runScheduler } from '../../src/main/agent/run-scheduler'
import type { RunningServer } from '../../src/server/boot'

// Load: 20 bots × 5 chats at once on SahilBot Server (in-process, mock model streaming ~1 s replies).
// Every run must finish, at most the run limit may go at once, every bot must get started early (fairness),
// and memory must stay bounded. Results go to test-results/server-load.json (the numbers in docs/server.md).

let llm: MockLlm
let srv: RunningServer
const data = mkdtempSync(join(tmpdir(), 'sb-server-load-'))

beforeAll(async () => {
  llm = await startMockLlm()
  Object.assign(process.env, { FOREMAN_BASE_URL: llm.url, FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', FOREMAN_NO_VERIFY: '1', FOREMAN_RAM_GB: '64', SAHILBOT_KNOWLEDGE: '0', SAHILBOT_LEARNING: '0' })
  const { startServer } = await import('../../src/server/boot')
  // Sized like a Raspberry Pi 5 with 8 GB: 7 runs at once.
  srv = await startServer({ data, port: 0, listen: '127.0.0.1', scryptN: 2 ** 10, maxRuns: 7, log: () => undefined, pairOnStart: false })
})
afterAll(async () => { await srv?.stop(); await llm?.close() })

const ctx = { transport: 'test' as const }
const call = (ch: string, ...args: unknown[]): Promise<any> => invoke(ch, ctx, args)

test('20 bots × 5 concurrent chats', async () => {
  await new Promise((r) => setTimeout(r, 1500))
  const idle = { rssMB: process.memoryUsage().rss / 1048576, heapMB: process.memoryUsage().heapUsed / 1048576 }
  const BOTS = 20, CHATS = 5
  const threads: Array<{ id: string; bot: string }> = []
  for (let b = 0; b < BOTS; b++) {
    const sp = (await call('spaces:create', { name: `Load bot ${b + 1}` })).space
    for (let c = 0; c < CHATS; c++) threads.push({ id: (await call('threads:create', sp.id)).id, bot: sp.id })
  }
  // Every reply: ~40 streamed words, 25 ms apart (about a second, like a fast cloud model).
  llm.script.length = 0
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  for (let i = 0; i < BOTS * CHATS + 20; i++) llm.script.push({ content: `Done: ${words}`, delay: 25 })

  const finished = new Map<string, number>()
  const firstStart = new Map<string, number>()
  let peakRss = 0
  addAdapter({ send: (ev, args) => {
    if (ev !== 'chat:event') return
    const e = args[0] as { type: string; status?: string; threadId: string }
    if (e.type === 'delta') { const bot = threads.find((t) => t.id === e.threadId)?.bot; if (bot && !firstStart.has(bot)) firstStart.set(bot, Date.now()) }
    if (e.type === 'run' && e.status && e.status !== 'started' && threads.some((t) => t.id === e.threadId)) finished.set(e.threadId, Date.now())
  } })
  // When each run got its slot (the scheduler's own fairness, independent of how fast the model is).
  const admittedAt = new Map<string, number>()
  const sched = runScheduler()!
  const admit = sched.admit.bind(sched)
  sched.admit = (t) => admit(t).then((release) => { const bot = threads.find((x) => x.id === t.threadId)?.bot; if (bot && !admittedAt.has(bot)) admittedAt.set(bot, Date.now()); return release })
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss / 1048576) }, 50)
  const cpu0 = process.cpuUsage()
  const t0 = Date.now()
  await Promise.all(threads.map((t) => call('chat:send', { threadId: t.id, text: `Task for ${t.id}` })))
  const end = Date.now() + 90_000
  while (finished.size < threads.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  const wall = Date.now() - t0
  const cpu = process.cpuUsage(cpu0)
  clearInterval(sampler)
  const stats = runScheduler()!.stats()

  if (finished.size < threads.length) {
    const stuck = threads.filter((t) => !finished.has(t.id)).slice(0, 3)
    for (const t of stuck) console.log('[stuck]', t.id, JSON.stringify(await call('chat:pending', t.id)).slice(0, 300), JSON.stringify((await call('threads:messages', t.id)).map((m: any) => [m.role, m.kind, String(m.content).slice(0, 80)])).slice(0, 600))
    console.log('[sched]', JSON.stringify(stats), 'requests', llm.requests.length)
  }
  expect(finished.size).toBe(threads.length)
  expect(stats.maxRunning).toBeLessThanOrEqual(7)
  expect(stats.admitted).toBeGreaterThanOrEqual(threads.length)
  // Fairness: every bot got its first reply going within the first ~quarter of the run, not at the end.
  const lastFirst = Math.max(...[...firstStart.values()]) - t0
  expect(firstStart.size).toBe(BOTS)
  expect(lastFirst).toBeLessThan(wall * 0.4)

  const cpuSec = (cpu.user + cpu.system) / 1e6
  const result = {
    machine: `${cpus()[0]?.model ?? 'cpu'} × ${cpus().length}`, node: process.versions.node,
    bots: BOTS, chatsPerBot: CHATS, runs: threads.length, limit: stats.limit, maxRunning: stats.maxRunning,
    wallSec: Math.round(wall / 100) / 10, lastBotStartSec: Math.round(lastFirst / 100) / 10,
    idleRssMB: Math.round(idle.rssMB), peakRssMB: Math.round(peakRss), cpuSec: Math.round(cpuSec * 10) / 10,
    avgCpuPercentOfOneCore: Math.round((cpuSec / (wall / 1000)) * 100),
    note: 'In-process: the mock model server runs in the same process, so CPU is an over-estimate.'
  }
  writeFileSync(join(process.cwd(), 'test-results', 'server-load.json'), JSON.stringify(result, null, 2))
  console.log('[load]', JSON.stringify(result))
  expect(peakRss).toBeLessThan(1500)
})
