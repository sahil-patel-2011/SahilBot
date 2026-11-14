import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ModelInfo, ModelList } from '@shared/types'
import { pickerModels, recommendedRows, toDownload } from '@shared/model-picker'
import { Endpoints, addedModelStatus, missingReason, pickable } from '../../src/main/llm/endpoints'
import { RECOMMENDED, autoWindow, isMlx, rankOf, recommendedFor, sameModel } from '../../src/main/llm/catalog'

// Which models can be picked: downloaded local models, and cloud models whose provider has a key.
// Recommended models that aren't downloaded live on Settings → Models with a Download button.

const noKeys = { anthropic: false, openai: false, openrouter: false, ollama: false, lmstudio: false, custom: false }
const settingsFor = (o: { keys?: Partial<typeof noKeys>; cloud?: boolean; customModels?: string[] } = {}) => ({
  defaultModel: 'auto', contextWindow: 0, baseUrl: 'http://localhost:8080/v1',
  providers: { ollama: { enabled: true, baseUrl: 'http://localhost:11434/v1' }, lmstudio: { enabled: true, baseUrl: 'http://localhost:1234/v1' }, custom: { enabled: false, baseUrl: 'http://localhost:8080/v1', name: 'Custom server' }, openai: { baseUrl: '' } },
  keys: { ...noKeys, ...o.keys }, cloud: { enabled: o.cloud ?? true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 3, prefer: 'local' as const },
  customModels: o.customModels ?? [], hiddenModels: [], shownModels: [], taskModels: { voice: '', background: '' }
})
const store = (s: ReturnType<typeof settingsFor>) => ({ get: () => s, keyFor: () => undefined, apiKey: () => undefined }) as never

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** Ollama has three models (one an MLX build of a recommended one); LM Studio has one MLX model. */
function servers(o: { ollama?: boolean; lmstudio?: boolean } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('http://localhost:11434')) {
      if (o.ollama === false) throw new TypeError('fetch failed')
      if (url.endsWith('/v1/models')) return json({ data: [{ id: 'qwen3.8:27b-mlx' }, { id: 'lfm3:1.7b' }, { id: 'gemma4:12b' }] })
      if (url.endsWith('/api/tags')) return json({ models: [{ name: 'qwen3.8:27b-mlx', size: 18e9 }, { name: 'lfm3:1.7b', size: 1.1e9 }, { name: 'gemma4:12b', size: 8e9 }] })
      if (url.endsWith('/api/show')) return json({ capabilities: ['completion', 'tools'] })
    }
    if (url.startsWith('http://localhost:1234')) {
      if (o.lmstudio === false) throw new TypeError('fetch failed')
      if (url.endsWith('/v1/models')) return json({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }] })
      if (url.endsWith('/api/v0/models')) return json({ data: [{ id: 'qwen/qwen3.6-35b-a3b', compatibility_type: 'mlx' }] })
    }
    throw new TypeError('fetch failed')
  })
}

describe('model picker: only models you can use now', () => {
  beforeEach(() => { process.env.FOREMAN_RAM_GB = '64'; delete process.env.FOREMAN_BASE_URL })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.FOREMAN_RAM_GB })

  test('downloaded local models and keyed cloud models; not-downloaded recommendations and keyless names are left out', async () => {
    vi.stubGlobal('fetch', servers())
    const s = settingsFor({ customModels: ['claude-opus-9-9', 'mystery-local:7b', 'openai/gpt-oss-120b'] })
    const list = await new Endpoints(store(s)).list()
    const ids = pickerModels(list).map((m) => m.id).sort()
    expect(ids).toEqual(['gemma4:12b', 'lfm3:1.7b', 'qwen/qwen3.6-35b-a3b', 'qwen3.8:27b-mlx'])
    // Recommended but not downloaded: listed for Settings, never in the picker.
    expect(list.models.find((m) => m.id === 'qwen3.6:35b-a3b')).toMatchObject({ installed: false, pull: 'qwen3.6:35b-a3b' })
    expect(toDownload(list).map((m) => m.id)).toContain('qwen3.6:35b-a3b')
    // Added by name without the provider's key, or with no server having it.
    expect(list.models.find((m) => m.id === 'claude-opus-9-9')).toMatchObject({ installed: false, note: 'Needs an Anthropic API key' })
    expect(list.models.find((m) => m.id === 'openai/gpt-oss-120b')).toMatchObject({ installed: false, note: 'Needs an OpenRouter API key' })
    expect(list.models.find((m) => m.id === 'mystery-local:7b')).toMatchObject({ installed: false, note: 'No running model server has it' })
  })

  test('an MLX build counts as the recommended model downloaded, and ranks a hair above GGUF', async () => {
    vi.stubGlobal('fetch', servers())
    const list = await new Endpoints(store(settingsFor())).list()
    const rows = recommendedRows(list)
    expect(rows.filter((m) => m.pull === 'qwen3.8:27b').map((m) => [m.id, m.installed])).toEqual([['qwen3.8:27b-mlx', true]])
    expect(rows.length).toBe(RECOMMENDED.length)
    // Fitting ones first, strongest first; the 70B (too big with context on 64 GB) last.
    expect(rows.at(-1)?.pull).toBe('llama3.3:70b')
    expect(list.models.find((m) => m.id === 'qwen3.8:27b-mlx')?.rank).toBeCloseTo(2.05)
    // LM Studio's MLX model: matched to the recommendation through the catalog, boosted for MLX.
    expect(list.models.find((m) => m.id === 'qwen/qwen3.6-35b-a3b')?.rank).toBeCloseTo(1.85)
  })

  test('a cloud key added: its models and names added for it become pickable', async () => {
    vi.stubGlobal('fetch', servers())
    const s = settingsFor({ keys: { openrouter: true }, customModels: ['openai/gpt-oss-120b'] })
    const list = await new Endpoints(store(s)).list()
    expect(pickerModels(list).map((m) => m.id)).toContain('openai/gpt-oss-120b')
    expect(addedModelStatus('openai/gpt-oss-120b', s)).toEqual({ provider: 'openrouter' })
    expect(addedModelStatus('claude-opus-5-5', { ...s, cloud: { ...s.cloud, enabled: false } }).reason).toBe('Cloud models are off')
  })

  test('Auto never uses a cloud model whose key was removed after the listing', () => {
    const cloud = { id: 'claude-opus-5-5', provider: 'anthropic', providerName: 'Anthropic', enabled: true, installed: true, tier: 3, vision: true, requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'remote' } as ModelInfo
    expect(pickable(cloud, settingsFor({ keys: { anthropic: true } }))).toBe(true)
    expect(pickable(cloud, settingsFor())).toBe(false)
    expect(pickable(cloud, settingsFor({ keys: { anthropic: true }, cloud: false }))).toBe(false)
    const e = new Endpoints(store(settingsFor()))
    e.last = { ok: true, models: [cloud], budgetGB: 48, totalGB: 64 }
    expect(e.usable()).toEqual([])
  })
})

describe('a chosen model that is gone falls back to Auto', () => {
  beforeEach(() => { process.env.FOREMAN_RAM_GB = '64'; delete process.env.FOREMAN_BASE_URL })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.FOREMAN_RAM_GB })

  test('deleted from Ollama, never downloaded, or its key removed', async () => {
    vi.stubGlobal('fetch', servers())
    const s = settingsFor({ customModels: ['claude-opus-9-9'] })
    const list = await new Endpoints(store(s)).list()
    expect(missingReason('auto', list, s)).toBeUndefined()
    expect(missingReason('qwen3.8:27b-mlx', list, s)).toBeUndefined()
    expect(missingReason('qwen/qwen3.6-35b-a3b', list, s)).toBeUndefined()
    expect(missingReason('old-model:7b', list, s)).toBe('it was deleted from Ollama')
    expect(missingReason('qwen3.5:9b', list, s)).toBe('it isn\'t downloaded')
    expect(missingReason('claude-opus-5-5', list, s)).toBe('there\'s no Anthropic API key any more')
    expect(missingReason('claude-opus-9-9', list, s)).toBe('it needs an Anthropic API key')
    expect(missingReason('gpt-5', list, { ...s, cloud: { ...s.cloud, enabled: false } })).toBe('cloud models are switched off')
  })

  test('no telling while its server is down: the choice is kept', async () => {
    vi.stubGlobal('fetch', servers({ ollama: false }))
    const s = settingsFor()
    const list = await new Endpoints(store(s)).list()
    expect(missingReason('qwen3.8:27b', list, s)).toBeUndefined()
    expect(missingReason('qwen3.5:9b', list, s)).toBeUndefined()
    // An LM Studio-style name while Ollama (also a local server that's on) is down: unknown too.
    expect(missingReason('some-lmstudio-model', list, s)).toBeUndefined()
    expect(missingReason(null as unknown as string, list as ModelList, s)).toBeUndefined()
  })

  test('re-checks with a fresh listing first, and never second-guesses FOREMAN_BASE_URL', async () => {
    const fetchFn = servers()
    vi.stubGlobal('fetch', fetchFn)
    const e = new Endpoints(store(settingsFor()))
    await e.list()
    expect(await e.missing('qwen3.8:27b-mlx')).toBeUndefined()
    const calls = fetchFn.mock.calls.length
    expect(await e.missing('old-model:7b')).toBe('it was deleted from Ollama')
    expect(fetchFn.mock.calls.length).toBeGreaterThan(calls)
    process.env.FOREMAN_BASE_URL = 'http://localhost:9999/v1'
    expect(await e.missing('old-model:7b')).toBeUndefined()
    delete process.env.FOREMAN_BASE_URL
  })
})

describe('recommendations for a 64 GB Mac (M5 Max class)', () => {
  test('setup picks: the most capable model, a fast one for voice, and the fast MoE as the alternative', async () => {
    process.env.FOREMAN_RAM_GB = '64'
    const picks = new Endpoints(store(settingsFor())).setupPicks()
    delete process.env.FOREMAN_RAM_GB
    expect(picks.map((p) => p.pull)).toEqual(['qwen3.8:27b', 'lfm3:1.7b', 'qwen3.6:35b-a3b'])
    expect(picks.map((p) => p.role)).toEqual(['Best for agent work on this Mac', 'Fast: quick chats and voice', 'Also great'])
  })

  test('every recommendation calls tools, and MoE ones say how many parameters are active', () => {
    expect(RECOMMENDED.every((r) => r.tools)).toBe(true)
    expect(RECOMMENDED.find((r) => r.pull === 'qwen3.6:35b-a3b')).toMatchObject({ activeB: 3, sizeGB: 24, tier: 2 })
    expect(new Set(RECOMMENDED.map((r) => r.pull)).size).toBe(RECOMMENDED.length)
  })

  test('context window on Auto: 64k with room (48 GB+ Macs), 32k otherwise', () => {
    expect(autoWindow(48)).toBe(65536)
    expect(autoWindow(15.8)).toBe(32768)
  })

  test('builds of the same model match; MLX builds are recognized', () => {
    expect(sameModel('qwen3.8:27b-q8_0', 'qwen3.8:27b')).toBe(true)
    expect(sameModel('flint:40b', 'flint')).toBe(true)
    expect(sameModel('flint:latest', 'flint')).toBe(true)
    expect(sameModel('gemma4:12b', 'gemma4:26b')).toBe(false)
    expect(recommendedFor('gemma4:26b-mlx')?.pull).toBe('gemma4:26b')
    expect(isMlx('qwen3.8:27b-mlx') && isMlx('lfm3:1.7b-nvfp4') && isMlx('mlx-community/Qwen3-8B-4bit')).toBe(true)
    expect(isMlx('qwen3.8:27b') || isMlx('qwen3.8:27b-q4_K_M')).toBe(false)
    expect(rankOf('claude-opus-5-5')).toBeGreaterThan(5)
  })
})

describe('shared picker helpers', () => {
  const m = (id: string, o: Partial<ModelInfo>): ModelInfo => ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, tier: 2, vision: false, requiredGB: 1, maxFittingWindow: 32768, fits: true, ...o })
  test('picker: installed and on; downloads: not installed, has a tag, fits', () => {
    const list = { models: [m('a:1b', {}), m('b:1b', { enabled: false }), m('c:1b', { installed: false, pull: 'c:1b' }), m('d:70b', { installed: false, pull: 'd:70b', fits: false, maxFittingWindow: 0 }), m('e', { installed: false })] }
    expect(pickerModels(list).map((x) => x.id)).toEqual(['a:1b'])
    expect(toDownload(list).map((x) => x.id)).toEqual(['c:1b'])
    expect(pickerModels(null)).toEqual([])
  })
})

describe('light requests on a big Mac stay fast', () => {
  test('with no light model, a light request goes to the fast mixture-of-experts, a hard one to the best', async () => {
    const { pick } = await import('../../src/main/llm/router')
    const models = [
      { id: 'lfm3:1.7b', tier: 0, rank: 1, tools: true },
      { id: 'qwen3.8:27b', tier: 2, rank: 2, tools: true },
      { id: 'qwen3.6:35b-a3b', tier: 2, rank: 1.8, tools: true }
    ] as never
    expect(pick(models, 1)?.id).toBe('qwen3.6:35b-a3b')
    expect(pick(models, 2)?.id).toBe('qwen3.8:27b')
    expect(pick(models, 0)?.id).toBe('lfm3:1.7b')
  })
})
