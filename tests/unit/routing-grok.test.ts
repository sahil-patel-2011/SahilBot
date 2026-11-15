import { describe, expect, test } from 'vitest'
import type { ModelInfo } from '@shared/types'
import { rankOf, tierOf } from '../../src/main/llm/catalog'
import { ROUTING_TABLE, routeTask, slotCost, slotOf, slotsFor, type RouteOptions } from '../../src/main/llm/routing-table'
import { TASK_CATEGORIES, classifyTask, type TaskContext } from '../../src/main/llm/task-classifier'
import { xaiInfo, xaiRank } from '../../src/main/llm/xai-models'

// Grok in Auto's routing table (docs/model-routing.md "Grok"): routed by its measured strengths, category by
// category. Its one relative strength is knowledge / office work (GDPval-AA, Snorkel, Vals legal); everywhere
// else independent boards put Grok 4.7 behind Claude and GPT, so it is a later fallback, and it is not routed
// at all for computer use (no data) or voice (9.9 s to the first token).

const cloud = (id: string, o: Partial<ModelInfo> = {}): ModelInfo => {
  const g = xaiInfo(id)
  return {
    id, provider: id.startsWith('claude') ? 'anthropic' : g ? 'xai' : 'openai', providerName: '', enabled: true, installed: true,
    tier: g ? g.tier : tierOf(id), rank: g ? xaiRank(id) : rankOf(id), vision: true, tools: true, requiredGB: 0, maxFittingWindow: 131072, fits: true,
    note: 'remote', contextTokens: g ? g.contextTokens : id.startsWith('claude') ? 1_000_000 : 1_050_000, label: id, ...o
  }
}
const GROK = cloud('grok-4.7')
const CLAUDE = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map((id) => cloud(id))
const GPT = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'].map((id) => cloud(id))
const routed = (text: string, models: ModelInfo[], ctx: TaskContext = {}, o: RouteOptions = {}): string | undefined =>
  routeTask(models, classifyTask(text, ctx), { preferCloud: true, fableForHardest: false, ...o })?.model.id

describe('Grok in the routing table', () => {
  test('grok-4.7 (and a newer grok) fill the grok slot; the multi-agent model does not', () => {
    expect(slotOf('grok-4.7')).toBe('grok')
    expect(slotOf('grok-4.8')).toBe('grok')
    expect(slotOf('grok-4.20-multi-agent-0309')).toBeUndefined()
    expect(slotOf('grok-imagine-image')).toBeUndefined()
  })

  test('it never leads a row; it is ahead of GPT only in office work, and absent from computer use and voice', () => {
    for (const c of TASK_CATEGORIES) {
      const r = ROUTING_TABLE[c]
      for (const row of [...r.tiers, ...(r.balancedHardest ? [r.balancedHardest] : [])]) {
        if (row.includes('grok')) expect(row[0]).not.toBe('grok')
        const g = row.indexOf('grok')
        if (g >= 0 && c !== 'office') expect(g).toBe(row.length - 1)
      }
    }
    for (const t of [1, 2, 3] as const) {
      const row = ROUTING_TABLE.office.tiers[t]
      expect(row.indexOf('grok')).toBeLessThan(row.indexOf('sol'))
      expect(row.indexOf('grok')).toBeGreaterThan(Math.max(row.indexOf('sonnet'), row.indexOf('opus')))
    }
    expect(ROUTING_TABLE['computer-use'].tiers.flat()).not.toContain('grok')
    expect(ROUTING_TABLE.voice.tiers.flat()).not.toContain('grok')
  })

  test('with Claude and GPT on, Auto routes as before (Grok adds nothing above them)', () => {
    const all = [...CLAUDE, ...GPT, GROK]
    expect(routed('Refactor the auth module and fix the failing tests in this repo', all, { codeProject: true })).toBe('claude-opus-5-5')
    expect(routed('Prove that the sum of the first n odd numbers is n squared', all)).toMatch(/^gpt-6/)
    expect(routed('Write a warm wedding toast for my brother', all)).toMatch(/^claude-/)
  })

  test('office work: Grok comes right after Claude, ahead of GPT', () => {
    const text = 'Build a financial model spreadsheet with a budget forecast for next year'
    expect(routed(text, [...GPT, GROK])).toBe('grok-4.7')
    expect(routed(text, [CLAUDE[1], ...GPT, GROK])).toBe('claude-sonnet-5-5')
  })

  test('elsewhere GPT comes first; Grok is used when it is the only cloud model', () => {
    const code = 'Refactor the auth module and fix the failing tests in this repo'
    expect(routed(code, [...GPT, GROK], { codeProject: true })).toMatch(/^gpt-6/)
    expect(routed(code, [GROK], { codeProject: true })).toBe('grok-4.7')
    expect(routed('Write a warm wedding toast for my brother', [GROK, GPT[2]])).toBe('gpt-6.1-sol')
  })

  test('the newest Grok wins its slot', () => {
    expect(routed('Build a financial model spreadsheet with a budget forecast', [cloud('grok-4.6'), GROK])).toBe('grok-4.7')
  })

  test('Cheapest keeps Grok behind the $2 / $10 models (its cost per task is high)', () => {
    expect(slotCost('grok')).toBeGreaterThan(slotCost('sol'))
    expect(slotCost('grok')).toBeLessThan(slotCost('opus'))
    const row = slotsFor('coding', 2, 'cheapest', false)
    expect(row.indexOf('grok')).toBeGreaterThan(row.indexOf('sol'))
  })
})
