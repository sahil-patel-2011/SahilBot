import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { isolatedWorktree } from '../../src/main/agent/runtime/graph'
import type { ToolDef } from '../../src/main/agent/types'
import type { ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
beforeEach(() => { llm.script.length = 0; llm.requests.length = 0 })
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
function harness(tools: ToolDef[] = [], approval = 'deny') {
  const db = new Db(':memory:'), registry = new ToolRegistry(), workspaceDir = mkdtempSync(join(tmpdir(), 'runtime-integration-'))
  const results = new ResultStore(workspaceDir), model = { id: 'fixture', label: 'Fixture', provider: 'ollama', providerName: 'Local', enabled: true, installed: true, fits: true, tier: 2, maxFittingWindow: 65536, requiredGB: 1 } as ModelInfo
  const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true }, workspaceDir, userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
  registry.register(...coreTools(results), ...tools)
  let agent: Agent
  agent = new Agent({ db, results, registry, docsDir: tmpdir(), settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last: { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never, memory: new MemoryStore(db), secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) }),
    emit: (e) => { if (e.type === 'pending') queueMicrotask(() => agent.respond(e.threadId, e.request.id, e.request.kind === 'plan' ? 'approve' : approval)) }
  })
  const space = db.createSpace('Test', '#000'), thread = db.createThread(space.id, 'auto', model.id)
  const run = async (text: string) => (await agent.send({ threadId: thread.id, text })).done
  const final = () => db.listMessages(thread.id).filter((m) => m.role === 'assistant' && m.kind === 'normal' && !m.meta?.superseded).at(-1)!
  return { db, agent, registry, thread, run, final, workspaceDir }
}
const tool = (name: string, effect: ToolDef['effect'], run: ToolDef['run']): ToolDef => ({ name, label: name, effect, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false }, run })

test('nested workflows honor denial and never add orphan tool messages to provider history', async () => {
  let writes = 0
  const h = harness([tool('send_fixture', 'write_external', async () => { writes++; return { text: 'sent' } })])
  llm.script.push({ toolCalls: [call('workflow', { nodes: [{ id: 'send', op: 'call', tool: 'send_fixture', args: {} }] })], delay: 0 }, { content: 'The send was declined.', delay: 0 })
  await h.run('Run this workflow to send the fixture report')
  expect(writes).toBe(0)
  expect(JSON.stringify(llm.requests.at(-1)!.messages)).toContain('failed')
  for (const req of llm.requests) {
    const callIds = new Set(req.messages.flatMap((m: any) => m.tool_calls?.map((c: any) => c.id) ?? []))
    for (const m of req.messages) if (m.role === 'tool') expect(callIds.has(m.tool_call_id)).toBe(true)
  }
})

test('a plan inferred from user text blocks writes until approval, including nested calls', async () => {
  let writes = 0
  const h = harness([tool('edit_fixture', 'write_local', async () => { writes++; return { text: 'edited' } }), tool('inspect_fixture', 'read', async () => ({ text: 'inspected' }))])
  llm.script.push(
    { toolCalls: [call('workflow', { nodes: [{ id: 'edit', op: 'call', tool: 'edit_fixture' }] })], delay: 0 },
    { toolCalls: [call('inspect_fixture', {})], delay: 0 },
    { toolCalls: [call('propose_plan', { goal: 'Fix fixture', steps: ['Edit fixture', 'Check fixture'] })], delay: 0 },
    { toolCalls: [call('edit_fixture', {}), call('todo', { items: [{ text: 'Edit fixture', status: 'done' }, { text: 'Check fixture', status: 'done' }] })], delay: 0 },
    { content: 'Edited after approval.', delay: 0 }
  )
  await h.run('Plan first before implementing the fixture fix')
  expect(writes).toBe(1)
  expect(JSON.stringify(llm.requests[1].messages)).toContain('Plan first: investigate')
  expect(h.db.listMessages(h.thread.id).find((m) => m.role === 'user' && !m.meta?.hidden)?.meta?.planApproved).toBe(true)
})

test('the final completion gate runs configured checks and exposes failure despite a success claim', async () => {
  let checks = 0
  const h = harness([tool('check_fixture', 'read', async () => { checks++; return { text: 'fixture still failing', data: { passed: false } } })])
  llm.script.push({ toolCalls: [call('agent_control', { action: 'configure', checks: [{ criterion: 'fixture works', tool: 'check_fixture', args: {}, pointer: '/passed', equals: true }] })], delay: 0 }, ...Array.from({ length: 4 }, () => ({ content: 'Everything passed.', delay: 0 })))
  expect(await h.run('Implement the fixture and verify the result')).toBe('error')
  expect(checks).toBe(1)
  expect(h.final().meta?.verification).toMatchObject({ status: 'blocked' })
  expect(h.final().content).toContain('Verification is incomplete')
})

test('recorded-tool replay cannot execute a live write', async () => {
  let writes = 0
  const h = harness([tool('edit_fixture', 'write_local', async () => { writes++; return { text: 'fixture receipt', data: { id: '123' } } })])
  llm.script.push({ toolCalls: [call('edit_fixture', {})], delay: 0 }, { content: 'Fixture saved.', delay: 0 })
  await h.run('Edit fixture for me')
  const runId = h.agent.runtime.latest(h.thread.id)!.id
  llm.script.push(
    { toolCalls: [call('agent_evaluate', { action: 'replay', run_id: runId, models: ['fixture'], contains: ['Fixture saved'], required_tools: ['edit_fixture'] })], delay: 0 },
    { toolCalls: [call('edit_fixture', {})], delay: 0 },
    { content: 'Fixture saved.', delay: 0 },
    { content: 'Replay checked.', delay: 0 }
  )
  await h.run('Evaluate the recorded fixture run')
  expect(writes).toBe(1)
  const row = h.db.sql.prepare('SELECT result FROM agent_evaluations').get() as { result: string }
  expect(JSON.parse(row.result).results[0]).toMatchObject({ passed: true, tools: ['edit_fixture'] })
})

test('already connected connector tools are reused without a sign-in tile', async () => {
  const h = harness(), connect = h.registry.get('connect_app')!
  let offers = 0
  const state = h.db.getState(h.thread.id)
  const out = await connect.run({ app: 'Fixture', reason: 'Read task status' }, { threadId: h.thread.id, signal: new AbortController().signal, state, workspaceDir: h.workspaceDir, docsDir: tmpdir(), searchTools: () => [{ name: 'fixture_tasks', description: 'Fixture tasks', loaded: true, connector: true }], loadTools: () => [], readResult: () => undefined, askUser: async () => '', offerConnect: async () => { offers++; return [] } })
  expect(out.data).toMatchObject({ connected: true }); expect(offers).toBe(0)
})

test('isolated coding workers start from committed HEAD and cannot overwrite parent edits', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'worker-parent-')), workspace = mkdtempSync(join(tmpdir(), 'worker-workspace-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test')
  writeFileSync(join(folder, 'fixture.txt'), 'committed'); git('add', '.'); git('commit', '-qm', 'fixture')
  writeFileSync(join(folder, 'fixture.txt'), 'parent edits')
  const worker = await isolatedWorktree(folder, workspace)
  expect(worker.dirty).toBe(true); expect(worker.baseline).toBe(git('rev-parse', 'HEAD'))
  expect(readFileSync(join(worker.path, 'fixture.txt'), 'utf8')).toBe('committed')
  writeFileSync(join(worker.path, 'fixture.txt'), 'worker edits')
  expect(readFileSync(join(folder, 'fixture.txt'), 'utf8')).toBe('parent edits')
  git('worktree', 'remove', '--force', worker.path)
})
