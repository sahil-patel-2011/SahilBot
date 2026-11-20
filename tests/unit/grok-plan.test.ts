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
