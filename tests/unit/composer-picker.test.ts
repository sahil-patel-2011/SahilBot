import { describe, expect, test } from 'vitest'
import type { ModelInfo } from '@shared/types'
import { ALL_THINKING, byQuality, pickerLabel, shortModelName, splitModels, thinkingLevels } from '../../src/renderer/src/lib/picker'

// The composer's one picker: what its button says, which models it lists first, and the thinking
// levels a model offers.

const model = (id: string, o: Partial<ModelInfo> = {}): ModelInfo => ({
  id, provider: 'anthropic', providerName: 'Anthropic', enabled: true, installed: true, tier: 2, rank: 0,
  vision: true, requiredGB: 0, maxFittingWindow: 128_000, fits: true, note: 'remote', ...o
})

const opus = model('claude-opus-5-5', { label: 'Claude Opus 5.5', tier: 3, rank: 5.055 })
const fable = model('claude-fable-5-2', { label: 'Claude Fable 5.2', tier: 3, rank: 6.052 })
const sonnet = model('claude-sonnet-5-5', { label: 'Claude Sonnet 5.5', tier: 2, rank: 4.055 })
const haiku = model('claude-haiku-5-5', { label: 'Claude Haiku 5.5', tier: 1, rank: 3.055 })
const astra = model('gpt-6-astra', { label: 'GPT-6 Astra', provider: 'openai', providerName: 'OpenAI', tier: 3, rank: 2.06 })
const qwen = model('qwen3.8:27b', { label: 'Qwen3.8 27B', provider: 'ollama', providerName: 'Ollama', note: undefined, requiredGB: 22, tier: 2, rank: 3.1 })

describe('picker label', () => {
  test('all Auto reads "Auto"', () => {
    expect(pickerLabel({ model: 'auto', thinking: 'auto', mode: 'auto' })).toBe('Auto')
    expect(pickerLabel({ model: '', mode: 'auto' })).toBe('Auto')
  })
  test('shows only the overrides, short', () => {
    expect(pickerLabel({ model: 'claude-opus-5-5', models: [opus], thinking: 'high', mode: 'auto' })).toBe('Opus 5.5 · High')
    expect(pickerLabel({ model: 'claude-opus-5-5', models: [opus], thinking: 'auto', mode: 'auto' })).toBe('Opus 5.5')
    expect(pickerLabel({ model: 'auto', thinking: 'auto', mode: 'autonomous' })).toBe('Auto · Autonomous')
    expect(pickerLabel({ model: 'auto', thinking: 'xhigh', mode: 'ask' })).toBe('Auto · Extra · Ask first')
    expect(pickerLabel({ model: 'auto:cloud', thinking: 'auto', mode: 'auto' })).toBe('Auto (cloud)')
    expect(pickerLabel({ model: 'qwen3.8:27b', models: [qwen], mode: 'bypass' })).toBe('Qwen3.8 27B · Bypass')
  })
  test('a model the list does not know (yet) shows its id', () => {
    expect(pickerLabel({ model: 'llama3.3:70b', models: null, mode: 'auto' })).toBe('llama3.3:70b')
  })
  test('bot chats: model and thinking are automatic, only permissions show', () => {
    expect(pickerLabel({ model: 'claude-opus-5-5', models: [opus], thinking: 'max', mode: 'auto', autoBot: true })).toBe('Auto')
    expect(pickerLabel({ model: 'claude-opus-5-5', models: [opus], thinking: 'max', mode: 'autonomous', autoBot: true })).toBe('Auto · Autonomous')
  })
  test('short names drop the "Claude" prefix', () => {
    expect(shortModelName('claude-sonnet-5-5', sonnet)).toBe('Sonnet 5.5')
    expect(shortModelName('gpt-6-astra', astra)).toBe('GPT-6 Astra')
    expect(shortModelName('auto:local')).toBe('Auto (local)')
  })
})

describe('top models', () => {
  test('best first by tier, the premium model after the flagship, up to four', () => {
    const { top, more } = splitModels([haiku, sonnet, fable, opus])
    expect(top.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    expect(more).toEqual([])
  })
  test('the rest go to More models, in their original order', () => {
    const { top, more } = splitModels([qwen, haiku, sonnet, astra, fable, opus])
    expect(top.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-fable-5-2', 'gpt-6-astra', 'claude-sonnet-5-5'])
    expect(more.map((m) => m.id)).toEqual(['qwen3.8:27b', 'claude-haiku-5-5'])
  })
  test('a model too big for this Mac stays out of the top; one that fits at a smaller window is in', () => {
    const tooBig = model('huge:400b', { provider: 'ollama', providerName: 'Ollama', note: 'Too big for this Mac', tier: 3, rank: 9, fits: false, maxFittingWindow: 0 })
    const small = model('llama3.3:70b', { provider: 'ollama', providerName: 'Ollama', note: 'Fits at 16k context', tier: 2, rank: 2, fits: false, maxFittingWindow: 16_384 })
    const { top, more } = splitModels([tooBig, small, qwen])
    expect(top.map((m) => m.id)).toEqual(['qwen3.8:27b', 'llama3.3:70b'])
    expect(more.map((m) => m.id)).toEqual(['huge:400b'])
  })
  test('the same model from two providers is listed once at the top', () => {
    const viaRouter = model('anthropic/claude-opus-5-5', { provider: 'openrouter', providerName: 'OpenRouter', tier: 3, rank: 5.055 })
    const { top, more } = splitModels([viaRouter, opus, sonnet])
    expect(top.map((m) => m.id)).toEqual(['anthropic/claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(more.map((m) => m.id)).toEqual(['claude-opus-5-5'])
  })
  test('byQuality orders heavier tiers first', () => {
    expect([haiku, opus, sonnet].sort(byQuality).map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  })
})

describe('thinking levels', () => {
  test('Auto and unknown models offer every level', () => {
    expect(thinkingLevels('auto')).toEqual(ALL_THINKING)
    expect(thinkingLevels('qwen3.8:27b')).toEqual(ALL_THINKING)
  })
  test('current Claude models take all five; older ones fewer', () => {
    expect(thinkingLevels('claude-opus-5-5')).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(thinkingLevels('claude-sonnet-4-6')).toEqual(['auto', 'low', 'medium', 'high', 'max'])
    expect(thinkingLevels('claude-haiku-4-5')).toEqual(['auto'])
  })
  test('provider prefixes are ignored', () => {
    expect(thinkingLevels('anthropic/claude-sonnet-4-6')).toEqual(['auto', 'low', 'medium', 'high', 'max'])
  })
})
