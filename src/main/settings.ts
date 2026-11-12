import { DEFAULT_PROVIDERS, DEFS, baseUrlOf, keyName } from './llm/providers'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Appearance, ProviderId, Settings } from '@shared/types'
import type { Db } from './db'
import type { Secrets } from './secrets'

type Stored = Omit<Settings, 'hasApiKey' | 'keys' | 'hasCursorKey' | 'search'> & { search: Omit<Settings['search'], 'hasBraveKey'> }

export const DEFAULT_APPEARANCE: Appearance = { density: 'compact', chatWidth: 780, codeWrap: false, hue: 30, tint: 0, reduceTransparency: false, fontSize: 15 }

export const DEFAULTS: Stored = {
  baseUrl: 'http://localhost:11434/v1',
  defaultModel: 'auto',
  providers: DEFAULT_PROVIDERS,
  hiddenModels: [],
  customModels: [],
  taskModels: { voice: '', background: '' },
  appearance: DEFAULT_APPEARANCE,
  pinnedBots: null,
  speakReplies: false,
  quickKey: 'Alt+Space',
  thinking: 'medium',
  cloud: { enabled: true, hybrid: true, advisorModel: '', maxConsultsPerRequest: 3 },
  contextWindow: 0,
  shownModels: [],
  sampling: {},
  theme: 'system',
  userName: '',
  workspaceDir: join(homedir(), 'SahilBot'),
  search: { provider: 'auto', searxngUrl: '' },
  advanced: { hardStopsEnabled: true },
  onboarded: false,
  cloudBudgetUsd: 200
}

export type SettingsPatch = Partial<Settings> & {
  /** Key for the fallback endpoint (first-run setup, older callers). */
  apiKey?: string | null
  /** Keys per provider; null removes one. */
  setKeys?: Partial<Record<ProviderId, string | null>>
  braveKey?: string | null
  /** Cursor Cloud Agents API key. */
  cursorKey?: string | null
}

export class SettingsStore {
  constructor(private db: Db, private secrets: Secrets) {}

  private stored(): Stored {
    const s = this.db.getSetting<Partial<Stored>>('settings') ?? {}
    const p = s.providers
    const providers = {
      ollama: { ...DEFAULT_PROVIDERS.ollama, ...p?.ollama },
      lmstudio: { ...DEFAULT_PROVIDERS.lmstudio, ...p?.lmstudio },
      custom: { ...DEFAULT_PROVIDERS.custom, ...p?.custom },
      openai: { ...DEFAULT_PROVIDERS.openai, ...p?.openai }
    }
    // Before several providers could be on at once there was one endpoint: keep it working.
    if (!p && s.baseUrl && !/11434|1234|anthropic\.com|openai\.com|openrouter\.ai/.test(s.baseUrl)) providers.custom = { ...providers.custom, enabled: true, baseUrl: s.baseUrl }
    return {
      ...DEFAULTS, ...s, providers,
      taskModels: { ...DEFAULTS.taskModels, ...s.taskModels },
      cloud: { ...DEFAULTS.cloud, ...s.cloud },
      appearance: { ...DEFAULT_APPEARANCE, ...s.appearance },
      search: { ...DEFAULTS.search, ...s.search }, advanced: { ...DEFAULTS.advanced, ...s.advanced }
    }
  }

  get(): Settings {
    const s = this.stored()
    return {
      ...s,
      // Env override keeps tests and power users off the real endpoint without touching saved settings.
      baseUrl: process.env.FOREMAN_BASE_URL || s.baseUrl,
      onboarded: s.onboarded || !!process.env.FOREMAN_SKIP_ONBOARDING,
      hasApiKey: !!this.keyFor(process.env.FOREMAN_BASE_URL || s.baseUrl),
      hasCursorKey: this.secrets.has('cursorKey'),
      keys: Object.fromEntries(DEFS.map((d) => [d.id, !!this.keyFor(baseUrlOf(d.id, s.providers))])) as Record<ProviderId, boolean>,
      search: { ...s.search, hasBraveKey: this.secrets.has('braveKey') }
    }
  }

  set(patch: SettingsPatch): Settings {
    const { apiKey, setKeys, braveKey, cursorKey, hasApiKey: _a, keys: _k, hasCursorKey: _c, ...rest } = patch
    if (cursorKey !== undefined) this.secrets.set('cursorKey', cursorKey)
    if (braveKey !== undefined) this.secrets.set('braveKey', braveKey)
    const cur = this.stored()
    const search = rest.search ? { provider: rest.search.provider, searxngUrl: rest.search.searxngUrl } : cur.search
    this.db.setSetting('settings', {
      ...cur, ...rest, search,
      advanced: { ...cur.advanced, ...rest.advanced },
      appearance: { ...cur.appearance, ...rest.appearance },
      taskModels: { ...cur.taskModels, ...rest.taskModels },
      cloud: { ...cur.cloud, ...rest.cloud },
      providers: rest.providers ? {
        ollama: { ...cur.providers.ollama, ...rest.providers.ollama },
        lmstudio: { ...cur.providers.lmstudio, ...rest.providers.lmstudio },
        custom: { ...cur.providers.custom, ...rest.providers.custom },
        openai: { ...cur.providers.openai, ...rest.providers.openai }
      } : cur.providers
    })
    const providers = this.stored().providers
    for (const [id, k] of Object.entries(setKeys ?? {}) as Array<[ProviderId, string | null]>) {
      this.secrets.set(keyName(baseUrlOf(id, providers)), k ? k.trim() : null)
    }
    // A key belongs to the endpoint it was entered for (after this patch's endpoint change).
    if (apiKey !== undefined) this.secrets.set(keyName(this.get().baseUrl), apiKey)
    return this.get()
  }

  providers(): Stored['providers'] {
    return this.stored().providers
  }

  /** The key for the fallback endpoint. */
  apiKey(): string | undefined {
    return this.keyFor(this.get().baseUrl)
  }

  keyFor(baseUrl: string): string | undefined {
    // Before per-endpoint keys there was one shared key: it moves to the endpoint in use then.
    const legacy = this.secrets.get('apiKey')
    if (legacy) {
      const cur = process.env.FOREMAN_BASE_URL || this.stored().baseUrl
      if (!this.secrets.has(keyName(cur))) this.secrets.set(keyName(cur), legacy)
      this.secrets.set('apiKey', null)
    }
    return this.secrets.get(keyName(baseUrl)) || undefined
  }
}
