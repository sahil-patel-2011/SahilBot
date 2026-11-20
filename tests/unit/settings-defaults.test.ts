import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { SettingsStore, cleanVoiceInput, migrateLearning } from '../../src/main/settings'
import { LearningService } from '../../src/main/learning/service'
import { MemoryStore } from '../../src/main/memory'
import { SkillStore } from '../../src/main/skills'
import type { ModelInfo, Settings } from '../../src/shared/types'

// New defaults: memory that fills itself in ("Remember things automatically" on, cloud learning allowed within
// the small daily cap) for new installs, and for existing ones unless the user had chosen otherwise.

const secrets = () => {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v) m.set(k, v); else m.delete(k) }, has: (k: string) => m.has(k) } as never
}

describe('learning: on by default, and the migration keeps explicit choices', () => {
  test.each([
    ['never touched (old default write)', { cloudAllowed: false, dailyUsd: 0.25 }, { enabled: true, cloudAllowed: true }],
    ['nothing saved', undefined, { enabled: true, cloudAllowed: true }],
    ['turned learning off', { enabled: false, cloudAllowed: false, dailyUsd: 0.25 }, { enabled: false, cloudAllowed: true }],
    ['turned learning on', { enabled: true, cloudAllowed: false, dailyUsd: 0.25 }, { enabled: true, cloudAllowed: true }],
    ['allowed cloud learning', { cloudAllowed: true, dailyUsd: 1 }, { enabled: true, cloudAllowed: true }],
    ['explicit cloud off after this migration', { enabled: true, cloudAllowed: false, dailyUsd: 0.25, explicit: ['cloudAllowed'] }, { enabled: true, cloudAllowed: false }]
  ])('%s', (_name, saved, want) => {
    expect(migrateLearning(saved)).toMatchObject(want)
  })

  test('a fresh install: on, with cloud learning and a $0.25 daily cap', () => {
    const s = new SettingsStore(new Db(':memory:'), secrets()).get()
    expect(s.learning).toMatchObject({ enabled: true, cloudAllowed: true, dailyUsd: 0.25 })
  })

  test('an existing install moves once; a switch the user flips afterwards sticks and is recorded', () => {
    const db = new Db(':memory:')
    db.setSetting('settings', { userName: 'JP', learning: { cloudAllowed: false, dailyUsd: 0.5 } })
    db.setSetting('effortAuto', 1)
    const store = new SettingsStore(db, secrets())
    expect(store.get().learning).toMatchObject({ enabled: true, cloudAllowed: true, dailyUsd: 0.5 })
    store.set({ learning: { enabled: false } as never })
    expect(store.get().learning).toMatchObject({ enabled: false, cloudAllowed: true, explicit: ['enabled'] })
    // A second launch doesn't migrate again.
    expect(new SettingsStore(db, secrets()).get().learning).toMatchObject({ enabled: false, explicit: ['enabled'] })
  })

  test('an existing install that had turned learning off keeps it off', () => {
    const db = new Db(':memory:')
    db.setSetting('settings', { learning: { enabled: false, cloudAllowed: false, dailyUsd: 0.25 } })
    expect(new SettingsStore(db, secrets()).get().learning).toMatchObject({ enabled: false, explicit: ['enabled'] })
  })
})

describe('learning model choice and the monthly limit', () => {
  const remote = (id: string, provider = 'anthropic'): ModelInfo => ({ id, provider, providerName: provider, enabled: true, installed: true, tier: 1, note: 'remote', vision: false, requiredGB: 0, maxFittingWindow: 0, fits: true } as unknown as ModelInfo)
  const svc = (s: Partial<Settings>, models: ModelInfo[]) => {
    const db = new Db(':memory:')
    return new LearningService({
      db, memory: new MemoryStore(db), skills: new SkillStore(mkdtempSync(join(tmpdir(), 'skills-'))), busy: () => false,
      settings: { get: () => ({ taskModels: { voice: '', background: '' }, sampling: {}, cloud: { enabled: true }, local: { enabled: false }, learning: { enabled: true, cloudAllowed: true, dailyUsd: 0.25 }, cloudBudgetUsd: 200, ...s }) as Settings },
      endpoints: { usable: () => models, for: () => ({ baseUrl: 'https://api.anthropic.com/v1' }) }
    })
  }

  test('unset counts as on', () => {
    expect(svc({ learning: { cloudAllowed: true, dailyUsd: 0.25 } }, []).enabled()).toBe(true)
  })

  test('cloud learning within the cap; skipped when the monthly limit is None unless the ChatGPT plan is there', () => {
    expect(svc({}, [remote('claude-haiku-5-5')]).choose()).toEqual({ model: 'claude-haiku-5-5', cloud: true })
    expect(svc({ spendingMode: 'none' } as never, [remote('claude-haiku-5-5')]).choose()).toMatchObject({ blocked: expect.stringMatching(/monthly spending limit is None/) })
    const plan = remote('chatgpt-plan/gpt-6.1-sol', 'chatgpt')
    expect(svc({ spendingMode: 'none' } as never, [remote('claude-haiku-5-5'), plan]).choose()).toEqual({ model: plan.id, cloud: true })
  })
})

describe('voice input settings', () => {
  test('cloud-only by default, auto model, junk dropped', () => {
    expect(cleanVoiceInput(undefined)).toEqual({ local: false, model: 'auto' })
    expect(cleanVoiceInput({ local: false, model: 'small-q8_0', bench: { model: 'large-v3-turbo-q5_0', ms: 812.4, at: 5 } })).toEqual({ local: false, model: 'small-q8_0', bench: { model: 'large-v3-turbo-q5_0', ms: 812, at: 5 } })
    expect(cleanVoiceInput({ model: 'ggml-huge', bench: { model: 'x', ms: 1, at: 1 } })).toEqual({ local: false, model: 'auto' })
  })

  test('a fresh install keeps speech models off', () => {
    const s = new SettingsStore(new Db(':memory:'), secrets()).get()
    expect(s.local?.enabled).toBe(false)
    expect(s.voiceInput).toEqual({ local: false, model: 'auto' })
  })
})


test('switching a provider off keeps its saved key and restores it when switched back on', () => {
  const db = new Db(':memory:'), store = new SettingsStore(db, secrets())
  store.set({ setKeys: { anthropic: 'fixture-provider-key' } })
  expect(store.get().keys.anthropic).toBe(true)
  store.set({ disabledProviders: ['anthropic'] })
  expect(store.get().keys.anthropic).toBe(false)
  expect(store.get().keysSaved?.anthropic).toBe(true)
  store.set({ disabledProviders: [] })
  expect(store.get().keys.anthropic).toBe(true)
  expect(store.keyFor('https://api.anthropic.com/v1')).toBe('fixture-provider-key')
})
