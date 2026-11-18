import { afterEach, describe, expect, test } from 'vitest'
import type { ModelInfo, Settings } from '@shared/types'
import { billedInput, claudeMaxTokens, refusalNote } from '../../src/main/llm/anthropic'
import { cost, priceFor } from '../../src/main/llm/budget'
import { prettyName, rankOf, tierOf } from '../../src/main/llm/catalog'
import { cacheReadFactor, claudeEffort, claudeSpec, claudeThinking, formatTokens, isPremiumClaude } from '../../src/main/llm/claude-models'
import { Endpoints, olderClaude } from '../../src/main/llm/endpoints'
import { pick, routingPrefs } from '../../src/main/llm/router'

// Facts checked against the bundled Claude API reference (claude-api skill SKILL.md + shared/models.md,
// shared/prompt-caching.md). If a test here fails after a catalog change, re-check the reference.

describe('Claude model facts', () => {
  test('ids, dated snapshots and labels', () => {
    expect(claudeSpec('claude-opus-5-5')?.id).toBe('claude-opus-5-5')
    expect(claudeSpec('claude-opus-5')?.id).toBe('claude-opus-5')
    expect(claudeSpec('claude-opus-5-20260101')?.id).toBe('claude-opus-5')
    expect(claudeSpec('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5')
    expect(claudeSpec('claude-opus-4-20250514')?.id).toBe('claude-opus-4')
    expect(claudeSpec('claude-sonnet-4-20250514')?.id).toBe('claude-sonnet-4')
    expect(claudeSpec('gpt-5')).toBeUndefined()
    expect(prettyName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5')
    expect(prettyName('claude-fable-5-1')).toBe('Claude Fable 5.1')
  })
  test('context windows and output caps', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
      expect(claudeSpec(id)?.contextTokens, id).toBe(1_000_000)
      expect(claudeSpec(id)?.maxOutput, id).toBe(128_000)
    }
    expect(claudeSpec('claude-haiku-4-5')).toMatchObject({ contextTokens: 200_000, maxOutput: 64_000 })
    // Not in the reference: left unknown rather than guessed.
    expect(claudeSpec('claude-sonnet-4-5')?.contextTokens).toBeUndefined()
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(200_000)).toBe('200K')
  })
  test('output ceiling follows effort and never passes the model cap', () => {
    expect(claudeMaxTokens(4096, 'medium', 'claude-opus-5-5')).toBe(16000)
    expect(claudeMaxTokens(4096, 'max', 'claude-opus-5-5')).toBe(64000)
    expect(claudeMaxTokens(200_000, 'max', 'claude-opus-5-5')).toBe(128_000)
    expect(claudeMaxTokens(100_000, 'high', 'claude-haiku-4-5')).toBe(64_000)
    expect(claudeMaxTokens(4096, 'high')).toBe(32000)
  })
})

describe('thinking and effort', () => {
  test('the app levels map onto what each model accepts', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-8']) {
      for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) expect(claudeEffort(id, e), `${id} ${e}`).toBe(e)
    }
    // Opus/Sonnet 4.6: no xhigh ("Extra" steps down to high).
    expect(claudeEffort('claude-opus-4-6', 'xhigh')).toBe('high')
    expect(claudeEffort('claude-sonnet-4-6', 'max')).toBe('max')
    // Opus 4.5: low/medium/high only.
    expect(claudeEffort('claude-opus-4-5', 'max')).toBe('high')
    // No effort parameter at all.
    expect(claudeEffort('claude-haiku-4-5', 'high')).toBeUndefined()
    expect(claudeEffort('claude-sonnet-4-5', 'high')).toBeUndefined()
    // A Claude model newer than the table works like the current generation.
    expect(claudeEffort('claude-opus-6', 'xhigh')).toBe('xhigh')
  })
  test('request parameters', () => {
    expect(claudeThinking('claude-sonnet-5-5', 'high')).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } })
    // Opus 5.5 defaults to medium on the API: the app's level is always sent explicitly.
    expect(claudeThinking('claude-opus-5-5')).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'medium' } })
    expect(claudeThinking('claude-opus-4-6', 'xhigh').output_config).toEqual({ effort: 'high' })
    expect(claudeThinking('claude-opus-4-5', 'high')).toEqual({ output_config: { effort: 'high' } })
    expect(claudeThinking('claude-haiku-4-5', 'max')).toEqual({})
    expect(claudeThinking('qwen3.5:9b', 'high')).toEqual({})
  })
})

describe('prices and the budget estimator', () => {
  test('per-model rates ($ per 1M tokens)', () => {
    expect(priceFor('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, known: true })
    expect(priceFor('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 })
    expect(priceFor('claude-haiku-5-5')).toMatchObject({ input: 0.1, output: 0.5 })
    expect(priceFor('claude-haiku-5-5', 150_000)).toMatchObject({ input: 0.5, output: 2.5 })
    expect(priceFor('claude-fable-5-1')).toMatchObject({ input: 10, output: 50, cacheRead: 0.25 })
    expect(priceFor('claude-opus-5')).toMatchObject({ input: 5, output: 25 })
    expect(priceFor('claude-sonnet-4-6')).toMatchObject({ input: 3, output: 15 })
    expect(priceFor('claude-haiku-4-5')).toMatchObject({ input: 1, output: 5 })
    // Unknown price: priced at the most expensive tier so the cap still holds.
    expect(priceFor('claude-sonnet-4-5')).toMatchObject({ input: 10, output: 50, known: false })
    expect(cost('claude-sonnet-5-5', 1_000_000, 1_000_000)).toBe(12)
  })
  test('cached input is billed at the model\'s cache-read rate', () => {
    expect(cacheReadFactor('claude-opus-5-5')).toBeCloseTo(0.05)
    expect(cacheReadFactor('claude-fable-5-1')).toBeCloseTo(0.025)
    // Anthropic's pricing page: cache hits on Opus 5.5 and Sonnet 5.5 are 0.05x, on Fable / Mythos 5.x 0.025x.
    expect(cacheReadFactor('claude-sonnet-5-5')).toBeCloseTo(0.05)
    expect(cacheReadFactor('claude-fable-5-2')).toBeCloseTo(0.025)
    expect(cacheReadFactor('claude-mythos-5-2')).toBeCloseTo(0.025)
    expect(cacheReadFactor('claude-haiku-5-5')).toBeCloseTo(0.1)
    const u = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 100_000 }
    expect(billedInput('claude-opus-5-5', u)).toBe(1000 + 2500 + 5000)
    expect(billedInput('claude-fable-5-1', u)).toBe(1000 + 2500 + 2500)
    expect(billedInput('claude-sonnet-5-5', u)).toBe(1000 + 2500 + 5000)
  })
  test('refusals say why when the API gives a category', () => {
    expect(refusalNote({ category: 'cyber', explanation: null })).toMatch(/declined this request \(cyber\)/)
    expect(refusalNote(null)).toMatch(/^_Claude declined this request\._/)
  })
})

const m = (id: string, tier: 0 | 1 | 2 | 3, o: Partial<ModelInfo> = {}): ModelInfo => ({
  id, tier, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, vision: true, requiredGB: 1, maxFittingWindow: 32768, fits: true, ...o
})
const claude = (id: string): ModelInfo => m(id, tierOf(id), { provider: 'anthropic', providerName: 'Anthropic', note: 'remote', rank: rankOf(id), requiredGB: 0, maxFittingWindow: 131072 })

describe('Auto with Claude', () => {
  afterEach(() => { routingPrefs.preferCloud = false })
  const cloud = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'].map(claude)
  test('tiers: Haiku light, Sonnet standard, Opus hardest; Fable only when picked by name', () => {
    expect(tierOf('claude-haiku-5-5')).toBe(1)
    expect(tierOf('claude-sonnet-5-5')).toBe(2)
    expect(tierOf('claude-opus-5-5')).toBe(3)
    expect(pick(cloud, 0)?.id).toBe('claude-haiku-5-5')
    expect(pick(cloud, 1)?.id).toBe('claude-haiku-5-5')
    expect(pick(cloud, 2)?.id).toBe('claude-sonnet-5-5')
    expect(pick(cloud, 3)?.id).toBe('claude-opus-5-5')
    expect(isPremiumClaude('claude-fable-5-1')).toBe(true)
    expect(rankOf('claude-fable-5-1')).toBeGreaterThan(rankOf('claude-opus-5-5'))
    expect(pick([claude('claude-fable-5-1'), claude('claude-sonnet-5-5')], 3)?.id).toBe('claude-fable-5-1')
    expect(pick(cloud, 3, { prefer: 'claude-fable-5-1' })?.id).toBe('claude-fable-5-1')
  })
  test('newest of each family wins', () => {
    expect(pick([claude('claude-sonnet-4-6'), claude('claude-sonnet-5'), claude('claude-sonnet-5-5')], 2)?.id).toBe('claude-sonnet-5-5')
    expect(pick([claude('claude-opus-4-8'), claude('claude-opus-5-5')], 3)?.id).toBe('claude-opus-5-5')
  })
  test('local first by default; cloud first when preferred', () => {
    const local = [m('qwen3.5:9b', 1, { rank: 1 }), m('qwen3.8:27b', 2, { rank: 2 })]
    expect(pick([...local, ...cloud], 1)?.id).toBe('qwen3.5:9b')
    expect(pick([...local, ...cloud], 2)?.id).toBe('qwen3.8:27b')
    expect(pick([...local, ...cloud], 2, { preferCloud: true })?.id).toBe('claude-sonnet-5-5')
    routingPrefs.preferCloud = true
    expect(pick([...local, ...cloud], 1)?.id).toBe('claude-haiku-5-5')
    expect(pick([...local, ...cloud], 3)?.id).toBe('claude-opus-5-5')
  })
  test('older Claude models start off in the picker', () => {
    const older = olderClaude(['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-fable-5', 'claude-fable-5-1', 'qwen3.5:9b'])
    expect([...older].sort()).toEqual(['claude-fable-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5', 'claude-sonnet-4-6'])
  })
})

describe('Endpoints: cloud switch, budget cap, advisor', () => {
  afterEach(() => { routingPrefs.preferCloud = false })
  const settings = (cloud: Partial<Settings['cloud']> = {}, extra: Partial<Settings> = {}) => {
    const s = { hiddenModels: [], shownModels: [], customModels: [], cloud: { enabled: true, hybrid: true, advisorModel: '', maxConsultsPerRequest: 3, ...cloud }, ...extra } as unknown as Settings
    return { get: () => s } as unknown as ConstructorParameters<typeof Endpoints>[0]
  }
  const models = [m('qwen3.8:27b', 2, { rank: 2 }), ...['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'].map(claude)]
  const make = (cloud: Partial<Settings['cloud']> = {}, left?: number): Endpoints => {
    const e = new Endpoints(settings(cloud))
    e.last = { ok: true, models, budgetGB: 16, totalGB: 32 }
    if (left !== undefined) e.budgetLeft = () => left
    return e
  }
  test('cloud off: Auto never sees a cloud model, and there is no advisor', () => {
    expect(make({ enabled: false }).usable().map((x) => x.id)).toEqual(['qwen3.8:27b'])
    expect(make({ enabled: false }).advisor()).toBeUndefined()
  })
  test('near the cap, Auto keeps only the cloud models the budget can still pay for', () => {
    // A typical step (30K in, 32K out): Haiku 5.5 ~$0.02, Sonnet 5.5 ~$0.38, Opus 5.5 ~$0.76, Fable ~$1.90.
    expect(make({}, 0.5).usable().map((x) => x.id)).toEqual(['qwen3.8:27b', 'claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(make({}, 0).usable().map((x) => x.id)).toEqual(['qwen3.8:27b'])
    expect(make({}, 100).usable()).toHaveLength(5)
  })
  test('the cloud-first setting reaches Auto', () => {
    make({ prefer: 'cloud' }).usable()
    expect(routingPrefs.preferCloud).toBe(true)
    make({ prefer: 'cloud', enabled: false }).usable()
    expect(routingPrefs.preferCloud).toBe(false)
  })
  test('hybrid advisor: Opus by default, Sonnet when preferred, or an exact model', () => {
    expect(make().advisor()).toBe('claude-opus-5-5')
    expect(make({ advisorModel: 'sonnet' }).advisor()).toBe('claude-sonnet-5-5')
    expect(make({ advisorModel: 'claude-fable-5-1' }).advisor()).toBe('claude-fable-5-1')
    expect(make({ hybrid: false }).advisor()).toBeUndefined()
  })
})
