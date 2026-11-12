import { describe, expect, test } from 'vitest'
import type { ModelInfo } from '@shared/types'
import { classify, decide, pick } from '../../src/main/llm/router'

const tier = (text: string, extra: Partial<Parameters<typeof decide>[0]> = {}): number => decide({ text, ...extra }).tier

describe('auto routing: how hard is it?', () => {
  test('small talk is instant', () => {
    for (const t of ['hi', 'Hey SahilBot!', 'thanks', 'ok cool', 'good morning', 'lol', 'sounds good']) expect(tier(t), t).toBe(0)
  })
  test('quick questions are light', () => {
    for (const t of ['What does a VPN do?', 'Give me a synonym for happy', 'How many cups are in a quart?', 'Translate "good night" into Spanish']) expect(tier(t), t).toBe(1)
  })
  test('fresh facts and routine tasks are standard', () => {
    for (const t of ['Who is the current CEO of Anthropic?', 'What is the weather in Atlanta today?', 'Remind me to call mom tomorrow at 9', 'Send an email to Sam saying I will be late', 'Summarize this file for me']) expect(tier(t), t).toBe(2)
  })
  test('making documents, coding and multi-step work go higher', () => {
    expect(tier('Create a PDF report about our Q3 sales')).toBeGreaterThanOrEqual(2)
    expect(tier('Research the top 5 CRMs for small clinics, compare pricing and features, then build a spreadsheet and a short deck')).toBe(3)
    expect(tier('Refactor the whole app architecture to use a plugin system, end to end')).toBe(3)
    expect(tier('Fix this TypeError: cannot read properties of undefined in my React component')).toBeGreaterThanOrEqual(2)
    expect(tier('Prove that the square root of 2 is irrational')).toBe(3)
  })
  test('attachments raise the level', () => {
    expect(tier('look at this', { attachments: [{ kind: 'folder', path: '/x', name: 'x' }] })).toBe(3)
    expect(tier('what is this', { images: 1 })).toBe(2)
  })
  test('follow-ups keep the previous strength', () => {
    expect(tier('yes do it', { previousTier: 3 })).toBe(3)
    expect(tier('continue', { previousTier: 2 })).toBe(2)
    expect(tier('ok', { openPlan: true, previousTier: 3 })).toBe(3)
  })
  test('not sure means one level up', () => {
    const r = classify({ text: 'I have been thinking about whether to move to a new city for a job, there are a lot of factors and I am not sure what to weigh most heavily here honestly' })
    expect(r.confident).toBe(false)
    expect(decide({ text: 'I have been thinking about whether to move to a new city for a job, there are a lot of factors and I am not sure what to weigh most heavily here honestly' }).tier).toBe(r.tier + 1)
  })
})

const m = (id: string, tier: 0 | 1 | 2 | 3, o: Partial<ModelInfo> = {}): ModelInfo => ({
  id, tier, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, vision: false, requiredGB: 1, maxFittingWindow: 32768, fits: true, ...o
})

describe('auto routing: which model', () => {
  const local = [m('lfm3:1.7b', 0, { rank: 1 }), m('qwen3.5:9b', 1, { rank: 1, vision: true }), m('gemma4:12b', 1, { rank: 2, vision: true }), m('qwen3.8:27b', 2, { rank: 2, vision: true }), m('gemma4:26b', 2, { rank: 1 })]
  const cloud = [m('claude-haiku-5-5', 1, { note: 'remote', rank: 3, vision: true }), m('claude-opus-5-5', 3, { note: 'remote', rank: 5, vision: true })]
  test('best model at the needed level, local first', () => {
    expect(pick(local, 0)?.id).toBe('lfm3:1.7b')
    expect(pick(local, 1)?.id).toBe('gemma4:12b')
    expect(pick(local, 2)?.id).toBe('qwen3.8:27b')
    expect(pick([...local, ...cloud], 2)?.id).toBe('qwen3.8:27b')
  })
  test('nothing at that level: step up, or use the strongest there is', () => {
    expect(pick([...local, ...cloud], 3)?.id).toBe('claude-opus-5-5')
    expect(pick(local, 3)?.id).toBe('qwen3.8:27b')
    expect(pick([m('qwen3.8:27b', 2)], 0)?.id).toBe('qwen3.8:27b')
  })
  test('images need a model that can see', () => {
    expect(pick([m('lfm3:1.7b', 0), m('qwen3.5:9b', 1, { vision: true })], 0, { needsVision: true })?.id).toBe('qwen3.5:9b')
  })
})

describe('auto routing: newer versions win ties', () => {
  test('Claude Haiku 5.5 over 4.5, Opus 5.5 over Opus 5', async () => {
    const { rankOf } = await import('../../src/main/llm/catalog')
    const c = (id: string, t: 0 | 1 | 2 | 3) => m(id, t, { note: 'remote', rank: rankOf(id) })
    expect(pick([c('claude-haiku-4-5', 1), c('claude-haiku-5-5', 1)], 1)?.id).toBe('claude-haiku-5-5')
    expect(pick([c('claude-opus-5-5', 3), c('claude-opus-5', 3)], 3)?.id).toBe('claude-opus-5-5')
  })
})
