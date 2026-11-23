import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Grok Bot reviewers: "there's no dry run; test runs do real work". A routine's Dry run reads for real, and every step
// that would change something is listed instead of done.
process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const model = { id: 'm', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'M', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as ModelInfo
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

test('a dry run reads for real and only lists what it would send', async () => {
  const sent: string[] = [], read: string[] = []
  const inbox: ToolDef<{ q: string }> = {
    name: 'read_inbox', label: 'Inbox', effect: 'read', description: 'read email',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    async run({ q }) { read.push(q); return { text: '2 unread: invoice from Acme, lunch invite' } }
  }
  const send: ToolDef<{ to: string; body: string }> = {
    name: 'send_email', label: 'Email', effect: 'send', description: 'send an email', describe: (a) => `Send an email to ${a.to}`,
    parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'], additionalProperties: false },
    async run({ to }) { sent.push(to); return { text: 'sent' } }
  }
  const db = new Db(':memory:')
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), inbox, send)
  const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: {}, workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'm', hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], defaultMode: 'autonomous' } as unknown as Settings
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: () => undefined, secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) })
  })
  llm.script.push(
    { toolCalls: [{ name: 'read_inbox', arguments: '{"q":"unread"}' }] },
    { toolCalls: [{ name: 'send_email', arguments: JSON.stringify({ to: 'ap@acme.example', body: 'Paid, thanks.' }) }] },
    { content: 'Dry run: I would email ap@acme.example that the invoice is paid.' }
  )
  const t = db.createThread(db.createSpace('Inbox bot', '#000').id, 'auto', 'm')
  expect(await (await agent.send({ threadId: t.id, text: '⏰ (Dry run) Morning inbox\n\nReply to invoices', meta: { dryRun: true } } as never, { unattended: true })).done).toBe('finished')
  expect(read).toEqual(['unread'])
  expect(sent).toEqual([])
  const step = db.listMessages(t.id).find((m) => m.role === 'tool' && m.toolName === 'send_email')!
  expect(step.content).toMatch(/DRY RUN: this was not done/)
  expect(step.content).toContain('Send an email to ap@acme.example')
  expect(step.meta?.display).toBe('would send an email to ap@acme.example')
})
