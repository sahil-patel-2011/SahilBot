import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ModelInfo, Settings } from '../../src/shared/types'
import { localOff, localOn, migrateLocal } from '../../src/shared/local-mode'
import { Db } from '../../src/main/db'
import { SettingsStore } from '../../src/main/settings'
import { Endpoints } from '../../src/main/llm/endpoints'
import { pick } from '../../src/main/llm/router'
import { Warmup } from '../../src/main/llm/warmup'
import { LearningService, cheapestFor } from '../../src/main/learning/service'
import { MemoryStore } from '../../src/main/memory'
import { SkillStore } from '../../src/main/skills'
import { chooseTts } from '../../src/main/voice/tts'
import { NO_VOICE_INPUT, OpenAISttEngine, chooseStt } from '../../src/main/voice/stt'
import { EnergyVad } from '../../src/main/voice/vad'
import { VoicePipeline } from '../../src/main/voice/pipeline'
import { anyFileIn, hasLocalModels } from '../../src/main/local-detect'

const local = (id: string, tier: 0 | 1 | 2 | 3 = 2): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id, vision: false, tier, requiredGB: 1, maxFittingWindow: 32768, fits: true }) as ModelInfo
const cloud = (id: string, tier: 0 | 1 | 2 | 3, provider: ModelInfo['provider'] = 'anthropic'): ModelInfo =>
  ({ ...local(id, tier), provider, providerName: provider, note: 'remote' }) as ModelInfo
const secrets = { get: () => undefined, has: () => false, set: () => undefined } as never

const saved = process.env.FOREMAN_BASE_URL
afterEach(() => { if (saved === undefined) delete process.env.FOREMAN_BASE_URL; else process.env.FOREMAN_BASE_URL = saved; vi.unstubAllGlobals() })

describe('local models are opt-in', () => {
  test('only an explicit off counts as off (older partial settings keep working)', () => {
    expect(localOff({ local: { enabled: false } })).toBe(true)
    expect(localOn({ local: { enabled: true } })).toBe(true)
    expect(localOn({})).toBe(true)
  })

  test('migration: existing installs with local models keep them on; others (and new installs) start off', () => {
    expect(migrateLocal({ local: { enabled: false }, onboarded: true }, () => true)).toBeNull()
    expect(migrateLocal({ onboarded: false }, () => true)).toBeNull()
    expect(migrateLocal({ onboarded: true }, () => true)).toEqual({ enabled: true, migrated: true })
    expect(migrateLocal({ onboarded: true }, () => false)).toEqual({ enabled: false, migrated: true })
    expect(migrateLocal({ onboarded: true, providers: { custom: { enabled: true } } }, () => false)).toEqual({ enabled: true, migrated: true })
    expect(migrateLocal({ onboarded: true }, () => { throw new Error('unreadable') })).toEqual({ enabled: false, migrated: true })
  })

  test('the settings store: new installs are off until onboarding decides; an existing install is migrated once', () => {
    const fresh = new SettingsStore(new Db(':memory:'), secrets, { hasLocalModels: () => true })
    expect(fresh.get().local).toEqual({ enabled: false })
    expect(fresh.set({ local: { enabled: true } }).local).toEqual({ enabled: true })

    const old = new Db(':memory:')
    old.setSetting('settings', { onboarded: true, userName: 'JP' })
    const migrated = new SettingsStore(old, secrets, { hasLocalModels: () => true })
    expect(migrated.get().local).toEqual({ enabled: true, migrated: true })
    // Decided once: a later look that finds nothing doesn't flip it.
    expect(new SettingsStore(old, secrets, { hasLocalModels: () => false }).get().local?.enabled).toBe(true)
    // The user's own choice replaces the migrated one.
    expect(migrated.set({ local: { enabled: false } }).local).toEqual({ enabled: false })

    const none = new Db(':memory:')
    none.setSetting('settings', { onboarded: true })
    expect(new SettingsStore(none, secrets, { hasLocalModels: () => false }).get().local).toEqual({ enabled: false, migrated: true })
  })

  test('local model detection looks at the model folders only', () => {
    const home = mkdtempSync(join(tmpdir(), 'sb-home-'))
    expect(hasLocalModels(home)).toBe(false)
    mkdirSync(join(home, '.ollama/models/manifests/registry.ollama.ai/library/qwen'), { recursive: true })
    expect(hasLocalModels(home)).toBe(false)
    writeFileSync(join(home, '.ollama/models/manifests/registry.ollama.ai/library/qwen/latest'), '{}')
    expect(hasLocalModels(home)).toBe(true)
    expect(anyFileIn([join(home, 'nope')])).toBe(false)
  })
})

describe('Auto with local models off', () => {
  const providers = { ollama: { enabled: true, baseUrl: 'http://localhost:11434/v1' }, lmstudio: { enabled: true, baseUrl: 'http://localhost:1234/v1' }, custom: { enabled: false, baseUrl: 'http://localhost:8080/v1', name: 'Custom' }, openai: { baseUrl: '' } }
  const settingsFor = (on: boolean) => ({
    get: () => ({ hiddenModels: [], shownModels: [], customModels: [], contextWindow: 0, keys: { anthropic: true, openai: false }, cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, providers, cloudBudgetUsd: 200, local: { enabled: on } }),
    keyFor: () => undefined, providers: () => providers
  }) as never

  test('never picks a local model, at any tier (even a stale listing that still has one)', () => {
    delete process.env.FOREMAN_BASE_URL
    const ep = new Endpoints(settingsFor(false))
    ep.last = { ok: true, models: [local('qwen3.5:9b', 0), local('gemma4:26b', 3), cloud('claude-haiku-5-5', 1), cloud('claude-opus-5-5', 3)], totalGB: 64, budgetGB: 48 } as never
    const usable = ep.usable()
    expect(usable.map((m) => m.id).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
    for (const tier of [0, 1, 2, 3] as const) expect(pick(usable, tier)?.provider).toBe('anthropic')
    // Turned on: local models are back.
    const on = new Endpoints(settingsFor(true))
    on.last = ep.last
    expect(on.usable().some((m) => m.provider === 'ollama')).toBe(true)
  })

  test('the model listing never asks a local server and offers no downloads while local is off', async () => {
    delete process.env.FOREMAN_BASE_URL
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(String(u)); throw new Error('offline') }))
    const off = await new Endpoints(settingsFor(false)).list()
    expect(urls.some((u) => /localhost/.test(u))).toBe(false)
    expect(off.models.some((m) => m.pull)).toBe(false)
    urls.length = 0
    const on = await new Endpoints(settingsFor(true)).list()
    expect(urls.some((u) => /localhost:11434/.test(u))).toBe(true)
    expect(on.models.some((m) => m.pull && !m.installed)).toBe(true)
  })

  test('warm-up never starts while local is off', async () => {
    const list = vi.fn(async () => undefined)
    const w = new Warmup({ endpoints: { last: null, list, usable: () => [local('qwen3.5:9b')], for: () => ({ baseUrl: 'http://localhost:11434/v1' }) }, settings: { get: () => ({ defaultModel: 'auto', contextWindow: 0, localKeepAlive: '30m', local: { enabled: false } }) }, fitWindow: () => 16384 })
    const r = await w.run()
    expect(r).toMatchObject({ status: 'skipped', reason: 'local models are off' })
    expect(list).not.toHaveBeenCalled()
  })
})

describe('learning with local models off', () => {
  function setup(o: { models: ModelInfo[]; cloudAllowed: boolean; dailyUsd?: number; background?: string }) {
    const db = new Db(':memory:')
    const settings = {
      taskModels: { voice: '', background: o.background ?? '' }, sampling: {}, cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 },
      learning: { enabled: true, cloudAllowed: o.cloudAllowed, dailyUsd: o.dailyUsd ?? 0.25 }, local: { enabled: false }
    } as unknown as Settings
    return new LearningService({
      db, memory: new MemoryStore(db), skills: new SkillStore(mkdtempSync(join(tmpdir(), 'skills-'))), settings: { get: () => settings },
      endpoints: { usable: () => o.models, for: (m) => ({ baseUrl: o.models.find((x) => x.id === m)?.note === 'remote' ? 'https://api.anthropic.com/v1' : 'http://localhost:11434/v1' }), last: {} },
      busy: () => false, chat: () => ({ async *[Symbol.asyncIterator]() { /* never called */ } }), now: () => Date.now(), secretValues: () => []
    })
  }

  test('skips with a clear note when cloud learning isn\'t allowed (nothing local is suggested)', () => {
    const c = setup({ models: [cloud('claude-haiku-5-5', 1)], cloudAllowed: false }).choose()
    expect(c).toMatchObject({ blocked: expect.stringMatching(/Local models are off .*skipped.*Use cloud models for learning/) })
  })

  test('uses the cheapest suitable cloud model within the daily cap, never a local background model', () => {
    const svc = setup({ models: [cloud('claude-opus-5-5', 3), cloud('claude-haiku-5-5', 1), cloud('claude-sonnet-5-5', 2), local('qwen3.5:9b', 2)], cloudAllowed: true, background: 'qwen3.5:9b' })
    expect(svc.choose()).toEqual({ model: 'claude-haiku-5-5', cloud: true })
    // Today's cap used up: the pass is blocked (status says why).
    const capped = setup({ models: [cloud('claude-haiku-5-5', 1)], cloudAllowed: true, dailyUsd: 0 })
    expect(capped.status().blocked).toMatch(/budget/)
  })

  test('the ChatGPT plan goes first when it is connected (no per-request cost)', () => {
    const plan = { ...cloud('chatgpt-plan/gpt-6.1-sol', 2, 'chatgpt') }
    expect(cheapestFor([cloud('claude-haiku-5-5', 1), plan])?.id).toBe('chatgpt-plan/gpt-6.1-sol')
    expect(cheapestFor([cloud('claude-opus-5-5', 3), cloud('claude-haiku-5-5', 1)])?.id).toBe('claude-haiku-5-5')
  })
})

describe('speech output', () => {
  test('Kokoro only with local on; OpenAI\'s voice when allowed with a key; else the Mac\'s voice', () => {
    expect(chooseTts({ localOn: true, kokoroInstalled: true, openaiKey: true, openaiAllowed: true })).toBe('kokoro')
    expect(chooseTts({ localOn: false, kokoroInstalled: true, openaiKey: true, openaiAllowed: true })).toBe('openai')
    expect(chooseTts({ localOn: false, kokoroInstalled: true, openaiKey: true, openaiAllowed: false })).toBe('say')
    expect(chooseTts({ localOn: false, kokoroInstalled: false, openaiKey: false, openaiAllowed: true })).toBe('say')
    expect(chooseTts({ localOn: false, kokoroInstalled: false, openaiKey: true, openaiAllowed: true, spendingNone: true })).toBe('say')
    expect(chooseTts({ localOn: true, kokoroInstalled: false, openaiKey: true, openaiAllowed: true, cloudOn: false })).toBe('say')
  })
})

describe('speech input', () => {
  test('Whisper only with local on; OpenAI transcription when allowed with a key; else a note (never a Whisper download prompt)', () => {
    const base = { whisperReady: true, openaiKey: true, openaiAllowed: true }
    expect(chooseStt({ ...base, localOn: true })).toEqual({ kind: 'whisper' })
    expect(chooseStt({ ...base, localOn: false })).toEqual({ kind: 'openai' })
    expect(chooseStt({ ...base, localOn: true, whisperReady: false })).toEqual({ kind: 'openai' })
    expect(chooseStt({ ...base, localOn: false, openaiAllowed: false })).toEqual({ kind: 'none', note: NO_VOICE_INPUT })
    expect(chooseStt({ ...base, localOn: false, openaiKey: false })).toEqual({ kind: 'none', note: NO_VOICE_INPUT })
    expect(chooseStt({ ...base, localOn: false, spendingNone: true })).toEqual({ kind: 'none', note: NO_VOICE_INPUT })
    expect(chooseStt({ ...base, localOn: false, cloudOn: false })).toEqual({ kind: 'none', note: NO_VOICE_INPUT })
    expect(NO_VOICE_INPUT).toBe('Voice input needs an OpenAI key or local models (Settings → Voice).')
    // Local on without Whisper and no OpenAI: the existing download hint (downloads are allowed then).
    expect(chooseStt({ localOn: true, whisperReady: false, openaiKey: false, openaiAllowed: false })).toMatchObject({ kind: 'none', note: expect.stringMatching(/Download the voice models/) })
  })

  test('OpenAI transcription: a WAV per utterance, priced before and charged after; no request for a blip', async () => {
    const calls: Array<{ name: string; mime: string; bytes: number }> = []
    const spent: string[] = []
    const stt = new OpenAISttEngine({
      transcribe: async (file) => { calls.push({ name: file.name, mime: file.mime, bytes: file.data.length }); return { text: '  hello   there ' } },
      guard: (sec) => spent.push(`before ${sec}`),
      charged: (sec) => spent.push(`after ${sec}`)
    })
    expect(stt.cloud).toBe(true)
    expect(await stt.transcribe(new Float32Array(16000))).toBe('hello there')
    expect(calls).toEqual([{ name: 'speech.wav', mime: 'audio/wav', bytes: 44 + 32000 }])
    expect(spent).toEqual(['before 1', 'after 1'])
    expect(await stt.transcribe(new Float32Array(1000))).toBe('')
    expect(calls.length).toBe(1)
    // Over the monthly limit: refused before anything is sent.
    const capped = new OpenAISttEngine({ transcribe: async () => { throw new Error('sent') }, guard: () => { throw new Error('Cloud budget reached') } })
    await expect(capped.transcribe(new Float32Array(16000))).rejects.toThrow(/budget/)
  })

  test('cloud dictation makes one request at the end (no paid live partials); the built-in voice detector needs no download', async () => {
    const vad = new EnergyVad()
    const frame = (amp: number): Float32Array => Float32Array.from({ length: 512 }, (_, i) => amp * Math.sin(i / 3))
    let started = 0
    let ended = 0
    for (let i = 0; i < 20; i++) await vad.feed(frame(0.002), { onStart: () => started++, onEnd: () => ended++ })
    for (let i = 0; i < 20; i++) await vad.feed(frame(0.3), { onStart: () => started++, onEnd: () => ended++ })
    expect(started).toBe(1)
    for (let i = 0; i < 30; i++) await vad.feed(frame(0.002), { onStart: () => started++, onEnd: () => ended++ })
    expect(ended).toBe(1)

    let requests = 0
    let t = 0
    const pipe = new VoicePipeline({
      vad: new EnergyVad(), whisper: { cloud: true, start: async () => undefined, transcribe: async () => { requests++; return 'note to self' } },
      tts: { name: 'x', warm: async () => undefined, synth: async () => ({ audio: new Float32Array(1), rate: 16000 }) },
      respond: async () => undefined, emit: () => undefined, now: () => (t += 100)
    })
    pipe.startDictation()
    for (let i = 0; i < 40; i++) await pipe.feed(frame(i < 5 ? 0.002 : 0.3))
    expect(requests).toBe(0)
    expect(await pipe.stopDictation()).toBe('note to self')
    expect(requests).toBe(1)
  })
})
