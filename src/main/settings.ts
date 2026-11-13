import { DEFAULT_PROVIDERS, DEFS, baseUrlOf, keyName } from './llm/providers'
import { isBroadAllow } from './agent/permissions'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Appearance, CustomRule, MarketKeyProvider, MarketsSettings, McpServerSettings, ProviderId, Settings } from '@shared/types'
import type { Db } from './db'
import type { Secrets } from './secrets'

type Stored = Omit<Settings, 'hasApiKey' | 'keys' | 'hasCursorKey' | 'hasTbaKey' | 'search'> & { search: Omit<Settings['search'], 'hasBraveKey'> }

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
  cloudBudgetUsd: 200,
  customRules: [],
  // Always on
  menuBarIcon: true,
  openAtLogin: false,
  keepAwakeWhileWorking: true,
  catchUpHours: 12,
  routinesPaused: false,
  // Local models stay loaded this long between messages (Ollama's own default is 5 minutes).
  localKeepAlive: '30m',
  // Markets: keyless data (Stooq, SEC EDGAR) by default; API keys are optional (Settings → Markets).
  markets: { quoteProvider: 'auto', secContact: '' },
  // Connected apps (MCP): off until the user turns it on; port 0 = pick a free one on first start.
  mcpServer: { enabled: false, port: 0 }
}

/** The MCP server settings as saved: on/off, and a port in the unprivileged range (0 = pick one). */
export function cleanMcpServer(v: unknown): McpServerSettings {
  const x = (v ?? {}) as Partial<McpServerSettings>
  const port = typeof x.port === 'number' && Number.isInteger(x.port) && x.port >= 1024 && x.port <= 65535 ? x.port : 0
  return { enabled: x.enabled === true, port }
}

export const MARKET_KEY_PROVIDERS: MarketKeyProvider[] = ['tiingo', 'polygon', 'alphavantage', 'finnhub']
/** Keychain name of a market data provider's API key. */
export const marketKeyName = (p: MarketKeyProvider): string => `market:${p}`

/** Markets settings as saved: known quote providers only, a short one-line contact. */
export function cleanMarkets(m: unknown): MarketsSettings {
  const x = (m ?? {}) as Partial<MarketsSettings>
  const quoteProvider = x.quoteProvider === 'none' || x.quoteProvider === 'auto' || MARKET_KEY_PROVIDERS.includes(x.quoteProvider as MarketKeyProvider) ? x.quoteProvider! : 'auto'
  const secContact = typeof x.secContact === 'string' ? x.secContact.replace(/[\r\n]+/g, ' ').trim().slice(0, 120) : ''
  return { quoteProvider, secContact }
}

/** Missed-routine catch-up window in hours: a whole number from 0 (off) to 168 (a week); anything else is the default. */
export function cleanCatchUpHours(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return DEFAULTS.catchUpHours!
  return Math.max(0, Math.min(168, Math.round(n)))
}

/**
 * Approval rules as saved: trimmed, at most 1000 characters, 20 of each kind, no duplicates. An Allow
 * rule that would match nearly everything ("tool:*") is dropped: it would switch every approval off.
 */
export function cleanRules(rules: unknown): CustomRule[] {
  if (!Array.isArray(rules)) return []
  const seen = new Set<string>()
  const count = { allow: 0, ask: 0 }
  const out: CustomRule[] = []
  for (const r of rules as Array<Partial<CustomRule>>) {
    if (!r || (r.action !== 'allow' && r.action !== 'ask') || typeof r.when !== 'string') continue
    const when = r.when.replace(/\s+/g, ' ').trim().slice(0, 1000)
    const key = `${r.action}:${when.toLowerCase()}`
    if (!when || seen.has(key) || count[r.action] >= 20) continue
    if (r.action === 'allow' && isBroadAllow(when)) continue
    seen.add(key)
    count[r.action]++
    out.push({ id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, when, action: r.action })
  }
  return out
}

export type SettingsPatch = Partial<Settings> & {
  /** Key for the fallback endpoint (first-run setup, older callers). */
  apiKey?: string | null
  /** Keys per provider; null removes one. */
  setKeys?: Partial<Record<ProviderId, string | null>>
  braveKey?: string | null
  /** Cursor Cloud Agents API key. */
  cursorKey?: string | null
  /** The Blue Alliance read API key (FRC scouting in the frc_code tool); kept in the Keychain like the others. */
  tbaKey?: string | null
  /** Market data API keys (Settings → Markets); null removes one. */
  marketKeys?: Partial<Record<MarketKeyProvider, string | null>>
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
      search: { ...DEFAULTS.search, ...s.search }, advanced: { ...DEFAULTS.advanced, ...s.advanced },
      customRules: cleanRules(s.customRules),
      catchUpHours: cleanCatchUpHours(s.catchUpHours),
      markets: cleanMarkets(s.markets),
      mcpServer: cleanMcpServer(s.mcpServer)
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
      hasTbaKey: this.secrets.has('tbaKey'),
      keys: Object.fromEntries(DEFS.map((d) => [d.id, !!this.keyFor(baseUrlOf(d.id, s.providers))])) as Record<ProviderId, boolean>,
      search: { ...s.search, hasBraveKey: this.secrets.has('braveKey') },
      markets: { ...cleanMarkets(s.markets), keys: Object.fromEntries(MARKET_KEY_PROVIDERS.map((p) => [p, this.secrets.has(marketKeyName(p))])) as Record<MarketKeyProvider, boolean> }
    }
  }

  set(patch: SettingsPatch): Settings {
    const { apiKey, setKeys, braveKey, cursorKey, tbaKey, marketKeys, hasApiKey: _a, keys: _k, hasCursorKey: _c, hasTbaKey: _t, ...rest } = patch
    for (const [p, k] of Object.entries(marketKeys ?? {}) as Array<[MarketKeyProvider, string | null]>) {
      if (MARKET_KEY_PROVIDERS.includes(p)) this.secrets.set(marketKeyName(p), k ? k.trim() : null)
    }
    if (cursorKey !== undefined) this.secrets.set('cursorKey', cursorKey)
    if (tbaKey !== undefined) this.secrets.set('tbaKey', tbaKey ? tbaKey.trim() : null)
    if (braveKey !== undefined) this.secrets.set('braveKey', braveKey)
    const cur = this.stored()
    const search = rest.search ? { provider: rest.search.provider, searxngUrl: rest.search.searxngUrl } : cur.search
    this.db.setSetting('settings', {
      ...cur, ...rest, search,
      advanced: { ...cur.advanced, ...rest.advanced },
      appearance: { ...cur.appearance, ...rest.appearance },
      taskModels: { ...cur.taskModels, ...rest.taskModels },
      cloud: { ...cur.cloud, ...rest.cloud },
      customRules: rest.customRules !== undefined ? cleanRules(rest.customRules) : cur.customRules,
      catchUpHours: rest.catchUpHours !== undefined ? cleanCatchUpHours(rest.catchUpHours) : cur.catchUpHours,
      markets: rest.markets !== undefined ? cleanMarkets({ ...cur.markets, ...rest.markets }) : cur.markets,
      mcpServer: rest.mcpServer !== undefined ? cleanMcpServer({ ...cur.mcpServer, ...rest.mcpServer }) : cur.mcpServer,
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

  /** Saved market data API keys (main process only; never sent to the renderer or the model). */
  marketKeys(): Partial<Record<MarketKeyProvider, string>> {
    const out: Partial<Record<MarketKeyProvider, string>> = {}
    for (const p of MARKET_KEY_PROVIDERS) { const k = this.secrets.get(marketKeyName(p)); if (k) out[p] = k }
    return out
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
