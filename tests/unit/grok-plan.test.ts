import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, vi } from 'vitest'
import { GROK_PLAN_MODEL, GROK_PLAN_URL } from '@shared/grok-plan'
import type { ModelInfo } from '@shared/types'
import type { ChatRequest, StreamPart } from '../../src/main/llm/client'
import { updateXaiCatalog, xaiInfo } from '../../src/main/llm/xai-models'
import { decodeGrok, grokPlan } from '../../src/main/llm/grok/plan'
import { autoRoute, planFallback } from '../../src/main/llm/auto-route'
import { classifyTask } from '../../src/main/llm/task-classifier'
import { routingPrefs } from '../../src/main/llm/router'
import { ModelHealth } from '../../src/main/llm/model-health'
import { priceFor } from '../../src/main/llm/budget'

const tools: NonNullable<ChatRequest['tools']> = [{ type: 'function', function: { name: 'file_write', description: 'Save a file', parameters: { type: 'object' } } }]
const request = (text: string): ChatRequest => ({
  baseUrl: GROK_PLAN_URL, model: GROK_PLAN_MODEL, messages: [{ role: 'user', content: text }], tools, sampling: {} as ChatRequest['sampling'], maxTokens: 1024
})
const collect = async (req: ChatRequest): Promise<StreamPart[]> => {
  const parts: StreamPart[] = []
  for await (const part of grokPlan.stream(req)) parts.push(part)
  return parts
}

test('subscription mode signs in with the CLI, routes approved tool requests through SahilBot, and falls back on quota', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sahilbot-grok-test-'))
  vi.stubEnv('SAHILBOT_GROK_PATH', resolve('tests/fixtures/fake-grok-acp.mjs'))
  vi.stubEnv('XAI_API_KEY', 'test-only-api-key')
  vi.stubEnv('GROK_DEPLOYMENT_KEY', 'test-only-deployment-key')
  let enabled = false
  grokPlan.configure(home, () => ({ enabled, preferSubscriptions: true }))
  try {
    expect(await grokPlan.refresh(true)).toMatchObject({ enabled: false, installed: true, connected: false })
    enabled = true
    expect(await grokPlan.refresh(true)).toMatchObject({ connected: false })
    writeFileSync(join(home, 'signed-in'), '')
    expect(await grokPlan.refresh(true)).toMatchObject({ connected: true })
    const methods = (): string[] => readFileSync(join(home, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).method)
    expect(methods()).not.toContain('session/new')
    const initial = { ...request('Remember the business deadline.'), conversationKey: 'business' }
    await collect(initial)
    await collect({ ...initial, messages: [...initial.messages, { role: 'assistant', content: 'Ready.' }, { role: 'user', content: 'Continue.' }] })
    expect(methods().filter((m) => m === 'session/new')).toHaveLength(1)
    expect(methods().filter((m) => m === 'session/load')).toHaveLength(1)
    const [plan] = grokPlan.models()
    expect(priceFor(plan.id)).toMatchObject({ input: 0, output: 0, known: true })
    const api: ModelInfo = { ...plan, id: 'gpt-6.2-sol', provider: 'openai', vision: true, price: { input: 2, output: 10 } }
    const task = classifyTask('Create a report in my workspace', { codeProject: true })
    routingPrefs.preferSubscriptions = true
    expect(autoRoute({ requested: 'auto', usable: [api, plan], task, preference: 'best' }).model).toBe(plan.id)
    expect(autoRoute({ requested: 'auto', usable: [api, plan], task: { ...task, needsVision: true }, preference: 'best' }).model).toBe(api.id)
    const parts = await collect(request('SAVE_FIXTURE'))
    expect(parts).toContainEqual(expect.objectContaining({ type: 'tool_calls', calls: [expect.objectContaining({ name: 'file_write', arguments: '{"path":"fixture.txt","content":"Subscription fixture"}' })] }))
    expect(parts).toContainEqual({ type: 'usage', promptTokens: 7, completionTokens: 3 })
    expect(await collect(request('saved-result'))).toContainEqual({ type: 'content', text: 'Ready.' })
    await expect(collect(request('NATIVE_TOOL_FIXTURE'))).rejects.toThrow(/native tool/)
    const err = await collect(request('QUOTA_FIXTURE')).catch((error: unknown) => error)
    expect(err).toMatchObject({ planLimit: true })
    expect(grokPlan.available()).toBe(false)
    expect(planFallback({ usable: [plan, api], current: plan, task, err, tried: new Set(), preference: 'best', health: new ModelHealth() }).model?.id).toBe(api.id)
    enabled = false
    expect(grokPlan.models()).toEqual([])
  } finally {
    routingPrefs.preferSubscriptions = false
    vi.unstubAllEnvs()
  }
})

test('a model switch hands Grok everything it missed, and a changed history starts a new Grok session instead of appending', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sahilbot-grok-switch-'))
  vi.stubEnv('SAHILBOT_GROK_PATH', resolve('tests/fixtures/fake-grok-acp.mjs'))
  writeFileSync(join(home, 'signed-in'), '')
  grokPlan.configure(home, () => ({ enabled: true, preferSubscriptions: true }))
  try {
    expect(await grokPlan.refresh(true)).toMatchObject({ connected: true })
    const log = (): Array<{ method: string; sessionId?: string; prompt?: string }> => readFileSync(join(home, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const ask = (messages: ChatRequest['messages']): Promise<StreamPart[]> => collect({ ...request(''), tools: [], messages, conversationKey: 'switch' })
    const system = { role: 'system' as const, content: 'You are SahilBot.' }
    const first = [system, { role: 'user' as const, content: 'Plan the launch for Acme.' }]
    await ask(first)
    // Grok answered ("Ready."), then the user switched to another model for one turn, then back to Grok.
    const switched = [...first, { role: 'assistant' as const, content: 'Ready.' }, { role: 'user' as const, content: 'What budget fits?' },
      { role: 'assistant' as const, content: 'A budget of 5000 dollars fits (from another model).' }, { role: 'user' as const, content: 'What is the next step?' }]
    await ask(switched)
    const resumed = log().filter((entry) => entry.method === 'session/prompt').at(-1)!.prompt!
    expect(log().filter((entry) => entry.method === 'session/load')).toHaveLength(1)
    expect(resumed).toContain('What budget fits?')
    expect(resumed).toContain('A budget of 5000 dollars fits (from another model).')
    expect(resumed).toContain('What is the next step?')
    // Only the part Grok missed: not the first turn again, and not Grok's own reply.
    expect(resumed).not.toContain('Plan the launch for Acme.')
    expect(resumed).not.toContain('Ready.')
    // SahilBot compacted the chat: Grok's old session no longer matches, so a new one starts from the full record.
    const compacted = [system, { role: 'user' as const, content: 'Summary of the earlier chat: Acme launch, 5000 dollar budget.' }, { role: 'user' as const, content: 'Draft the announcement.' }]
    await ask(compacted)
    const sessions = log().filter((entry) => entry.method === 'session/new').map((entry) => entry.method)
    expect(sessions).toHaveLength(2)
    expect(log().filter((entry) => entry.method === 'session/load')).toHaveLength(1)
    const fresh = log().filter((entry) => entry.method === 'session/prompt').at(-1)!
    expect(fresh.sessionId).toBe('isolated-2')
    expect(fresh.prompt).toContain('Summary of the earlier chat')
    expect(fresh.prompt).toContain('Draft the announcement.')
  } finally { vi.unstubAllEnvs() }
})

test('only valid declared tool envelopes become calls', () => {
  const text = '{"ok":true}'
  expect(decodeGrok(JSON.stringify({ sahilbot_action: 'answer', text }), tools)).toEqual({ text })
  expect(decodeGrok('{"tools":["something"]}', tools)).toEqual({ text: '{"tools":["something"]}' })
  expect(() => decodeGrok('{"sahilbot_action":"tools","calls":[{"name":"send","arguments":{}}]}', tools)).toThrow()
})

test('an account-listed Grok chat model can launch with its published window and pricing before it is in the bundled table', () => {
  try {
    updateXaiCatalog([{ id: 'grok-new-family', context_length: 512000, prompt_text_token_price: 20000, completion_text_token_price: 70000,
      long_context_threshold: 200000, prompt_text_token_price_long_context: 30000 }])
    expect(xaiInfo('grok-new-family')).toMatchObject({ contextTokens: 512000, price: { input: 2, output: 7 }, longContext: { atLeast: 200000, input: 3, output: 7 } })
  } finally { updateXaiCatalog([]) }
})
