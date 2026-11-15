import { describe, expect, test } from 'vitest'
import type { EffortChoice } from '@shared/types'
import { Db } from '../../src/main/db'
import { SettingsStore } from '../../src/main/settings'
import { EFFORT_CHOICES, autoEffort, effortChoice, resolveEffort } from '../../src/main/llm/auto-effort'
import { claudeEffort } from '../../src/main/llm/claude-models'
import { openaiEffort } from '../../src/main/llm/openai-models'
import { classifyTask } from '../../src/main/llm/task-classifier'

// Auto effort: the thinking level per request from the task, leaning high; chosen levels are used exactly.

const auto = (text: string, o: { task?: boolean; voice?: boolean; heavy?: boolean; ctx?: Parameters<typeof classifyTask>[1] } = {}) => {
  const c = classifyTask(text, { ...o.ctx, voice: o.voice })
  return autoEffort({ category: c.category, difficulty: c.difficulty, task: o.task, voice: o.voice, heavy: o.heavy })
}

describe('Auto effort per kind of task', () => {
  test('quick chat stays low / medium', () => {
    expect(auto('hi')).toBe('low')
    expect(auto('thanks!')).toBe('low')
    expect(auto('What does a VPN do?')).toBe('medium')
    expect(auto('What does git rebase do?')).toBe('medium')
  })
  test('real agent work, coding, research and multi-step tasks think at High', () => {
    expect(auto('Fix the TypeError in src/app.ts where user is undefined')).toBe('high')
    expect(auto('Check my inbox and reply to anything urgent from Sam')).toBe('high')
    expect(auto('Make a spreadsheet tracking my monthly budget with formulas')).toBe('high')
    expect(auto('Open Safari and log in to my bank site')).toBe('high')
    expect(auto('Research the best CRM tools for small clinics with sources')).toBe('high')
  })
  test('the hardest get Extra; Heavy and Deep Research get Max', () => {
    expect(auto('Refactor the whole app architecture to a plugin system, end to end')).toBe('xhigh')
    expect(auto('Prove that there are infinitely many primes')).toBe('xhigh')
    expect(auto('Refactor the whole app architecture to a plugin system, end to end', { heavy: true, ctx: { heavy: true } })).toBe('max')
    expect(auto('look into vector databases', { heavy: true, ctx: { deepResearch: true } })).toBe('high')
  })
  test('a task run never thinks below High; voice answers at Low', () => {
    expect(auto('hi', { task: true })).toBe('high')
    // Voice: replies must start fast; the hardest gets Medium (the effort rubric).
    expect(auto('Refactor the whole app architecture to a plugin system, end to end', { voice: true })).toBe('medium')
    expect(auto('what time is it', { voice: true })).toBe('low')
    expect(autoEffort({})).toBe('medium')
  })
  test('each provider maps the level onto what the model accepts', () => {
    expect(claudeEffort('claude-opus-5-5', 'xhigh')).toBe('xhigh')
    expect(claudeEffort('claude-sonnet-4-6', 'xhigh')).toBe('high')
    expect(openaiEffort('gpt-6-astra', 'max')).toBe('max')
    expect(openaiEffort('gpt-5.5', 'max')).toBe('xhigh')
  })
})

describe('manual choices are used exactly', () => {
  test('a level is sent as is; Auto or nothing picks per request', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolveEffort(e, { category: 'chat', difficulty: 0 })).toBe(e)
      expect(resolveEffort(e, { category: 'coding', difficulty: 3, task: true })).toBe(e)
      expect(resolveEffort(e, { voice: true })).toBe(e)
    }
    expect(resolveEffort('auto', { category: 'coding', difficulty: 2 })).toBe('high')
    expect(resolveEffort(undefined, { category: 'chat', difficulty: 0 })).toBe('low')
    expect(EFFORT_CHOICES[0]).toBe('auto')
  })
  test('chat, then bot, then group, then the app default', () => {
    expect(effortChoice(null, null, null, 'auto')).toBe('auto')
    expect(effortChoice(null, 'high', null, 'auto')).toBe('high')
    expect(effortChoice('low', 'high', null, 'auto')).toBe('low')
    expect(effortChoice('auto', 'high', null, 'max')).toBe('auto')
    expect(effortChoice(null, null, 'xhigh', 'medium')).toBe('xhigh')
    expect(effortChoice(null, null, null, 'medium')).toBe('medium')
    expect(effortChoice(null, 'bogus' as EffortChoice, undefined, undefined)).toBe('auto')
  })
})

describe('bots and chats keep their own thinking', () => {
  test('stored per bot and per chat; null inherits', () => {
    const db = new Db(':memory:')
    const bot = db.createSpace('Coder', '#000000')
    expect(bot.effort).toBeNull()
    expect(db.updateSpace(bot.id, { effort: 'xhigh' }).effort).toBe('xhigh')
    const t = db.createThread(bot.id, 'auto', null)
    expect(t.effort).toBeNull()
    // The chat inherits the bot's level…
    expect(effortChoice(db.getThread(t.id)?.effort, db.getSpace(bot.id)?.effort, null, 'auto')).toBe('xhigh')
    // …until the chat picks its own (Auto included).
    expect(db.updateThread(t.id, { effort: 'auto' }).effort).toBe('auto')
    expect(effortChoice(db.getThread(t.id)?.effort, db.getSpace(bot.id)?.effort, null, 'auto')).toBe('auto')
    expect(db.updateThread(t.id, { effort: 'low' }).effort).toBe('low')
    expect(db.updateThread(t.id, { effort: null }).effort).toBeNull()
    expect(db.updateSpace(bot.id, { effort: null }).effort).toBeNull()
    expect(effortChoice(db.getThread(t.id)?.effort, db.getSpace(bot.id)?.effort, null, 'auto')).toBe('auto')
  })
})

describe('the app default', () => {
  const secrets = { get: () => undefined, has: () => false, set: () => undefined } as never
  test('Auto for new installs; an old saved Medium (the old default) becomes Auto once; other levels are kept', () => {
    expect(new SettingsStore(new Db(':memory:'), secrets).get().thinking).toBe('auto')
    const old = new Db(':memory:')
    old.setSetting('settings', { thinking: 'medium' })
    const s = new SettingsStore(old, secrets)
    expect(s.get().thinking).toBe('auto')
    s.set({ thinking: 'medium' })
    expect(new SettingsStore(old, secrets).get().thinking).toBe('medium')
    const high = new Db(':memory:')
    high.setSetting('settings', { thinking: 'high' })
    expect(new SettingsStore(high, secrets).get().thinking).toBe('high')
  })
})
