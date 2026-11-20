import type { ProviderId, ProviderPreset, ProviderSettings } from '@shared/types'
import { CODEX_URL, PLAN_PROVIDER_NAME } from './codex/ids'
import { GROK_PLAN_URL } from '@shared/grok-plan'

// Model servers. Several can be on at once: local ones are found by asking them which models they
// have; cloud ones claim models by name (any "claude-…" goes to Anthropic, like Cursor does).
// Keys live in the Keychain, one per endpoint, so a Claude key is never sent to LM Studio.

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1'
export const OPENAI_URL = 'https://api.openai.com/v1'
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
/** xAI (Grok): OpenAI-compatible REST API (docs.x.ai); SahilBot talks to its Responses endpoint (llm/xai-client.ts). */
export const XAI_URL = 'https://api.x.ai/v1'

export const DEFAULT_PROVIDERS: ProviderSettings = {
  ollama: { enabled: true, baseUrl: 'http://localhost:11434/v1' },
  lmstudio: { enabled: true, baseUrl: 'http://localhost:1234/v1' },
  custom: { enabled: false, baseUrl: 'http://localhost:8080/v1', name: 'Custom server' },
  openai: { baseUrl: '' }
}

export interface ProviderDef {
  id: ProviderId
  name: string
  local: boolean
  needsKey: boolean
  keyHint?: string
  keyUrl?: string
  /** Cloud providers claim models by id. */
  claims?: RegExp
}

export const DEFS: ProviderDef[] = [
  { id: 'ollama', name: 'Ollama', local: true, needsKey: false },
  { id: 'lmstudio', name: 'LM Studio', local: true, needsKey: false, keyHint: 'Only if you turned on "Require API key" in LM Studio\'s server settings.' },
  { id: 'custom', name: 'Custom server', local: true, needsKey: false, keyHint: 'Only if your server asks for one.' },
  { id: 'anthropic', name: 'Anthropic', local: false, needsKey: true, claims: /^claude-/i, keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'Used for every model whose name starts with "claude-". Spending is capped by your monthly budget.' },
  { id: 'openai', name: 'OpenAI', local: false, needsKey: true, claims: /^(gpt-|o\d|chatgpt-)/i, keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'Used for GPT models. Spending is capped by your monthly budget.' },
  { id: 'xai', name: 'xAI', local: false, needsKey: true, claims: /^grok-/i, keyUrl: 'https://console.x.ai/team/default/api-keys', keyHint: 'Used for Grok models (names starting with "grok-"). Spending is capped by your monthly limit.' },
  { id: 'openrouter', name: 'OpenRouter', local: false, needsKey: true, claims: /^[a-z0-9-]+\/[^/]+$/i, keyUrl: 'https://openrouter.ai/keys', keyHint: 'Used for models named like "vendor/model". Spending is capped by your monthly budget.' },
  // The user's ChatGPT plan through their own Codex (llm/codex): no key; Connect in Settings → Models. Its
  // chatgpt-plan/… models are routed by Endpoints.for before any claim (an OpenRouter-style name otherwise).
  { id: 'chatgpt', name: PLAN_PROVIDER_NAME, local: false, needsKey: false },
  { id: 'grok-plan', name: 'Grok subscription', local: false, needsKey: false }
]

export const def = (id: ProviderId): ProviderDef => DEFS.find((d) => d.id === id)!

export function baseUrlOf(id: ProviderId, p: ProviderSettings): string {
  switch (id) {
    case 'ollama': return p.ollama.baseUrl
    case 'lmstudio': return p.lmstudio.baseUrl
    case 'custom': return p.custom.baseUrl
    case 'anthropic': return ANTHROPIC_URL
    case 'openai': return p.openai.baseUrl.trim() || OPENAI_URL
    case 'openrouter': return OPENROUTER_URL
    case 'xai': return XAI_URL
    case 'chatgpt': return CODEX_URL
    case 'grok-plan': return GROK_PLAN_URL
  }
}

// One-click choices for first-run setup.
export const PROVIDERS: ProviderPreset[] = [
  { id: 'ollama', name: 'Ollama (local)', baseUrl: DEFAULT_PROVIDERS.ollama.baseUrl, needsKey: false, defaultModel: 'auto' },
  { id: 'lmstudio', name: 'LM Studio (local)', baseUrl: DEFAULT_PROVIDERS.lmstudio.baseUrl, needsKey: false, optionalKey: true, keyHint: def('lmstudio').keyHint, defaultModel: 'auto' },
  { id: 'anthropic', name: 'Anthropic (Claude)', baseUrl: ANTHROPIC_URL, needsKey: true, keyHint: 'Starts with sk-ant-. Usage is capped by your monthly budget.', keyUrl: def('anthropic').keyUrl, defaultModel: 'auto' },
  { id: 'openai', name: 'OpenAI', baseUrl: OPENAI_URL, needsKey: true, keyUrl: def('openai').keyUrl, defaultModel: 'auto' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: OPENROUTER_URL, needsKey: true, keyUrl: def('openrouter').keyUrl, defaultModel: 'auto' },
  { id: 'xai', name: 'xAI (Grok)', baseUrl: XAI_URL, needsKey: true, keyUrl: def('xai').keyUrl, defaultModel: 'auto' }
]

/** Keychain entry for an endpoint's key: one per origin. */
export const keyName = (baseUrl: string): string => {
  try { return `apiKey@${new URL(baseUrl).origin}` } catch { return `apiKey@${baseUrl.trim()}` }
}

export const isAnthropic = (baseUrl: string): boolean => /(^|\.)anthropic\.com$/.test(safeHost(baseUrl))

/**
 * OpenAI's own API (api.openai.com), where GPT models run over the Responses API. FOREMAN_OPENAI_URL names
 * another base URL that speaks it the same way (tests' fake server, a proxy in front of OpenAI).
 */
export function isOpenAI(baseUrl: string): boolean {
  if (safeHost(baseUrl) === 'api.openai.com') return true
  const alt = process.env.FOREMAN_OPENAI_URL
  return !!alt && trimUrl(alt) === trimUrl(baseUrl)
}

export const isOpenRouter = (baseUrl: string): boolean => safeHost(baseUrl) === 'openrouter.ai'

/** xAI's API (api.x.ai, or its us. regional endpoint); FOREMAN_XAI_URL names a stand-in (tests' fake server). */
export function isXai(baseUrl: string): boolean {
  const h = safeHost(baseUrl)
  if (h === 'api.x.ai' || h === 'us.api.x.ai') return true
  const alt = process.env.FOREMAN_XAI_URL
  return !!alt && trimUrl(alt) === trimUrl(baseUrl)
}

/** Which provider a base URL is (FOREMAN_BASE_URL pointing at a cloud API is that provider, not "custom"). */
export function providerForUrl(baseUrl: string): ProviderId {
  return isAnthropic(baseUrl) ? 'anthropic' : isOpenAI(baseUrl) ? 'openai' : isOpenRouter(baseUrl) ? 'openrouter' : isXai(baseUrl) ? 'xai' : 'custom'
}

const trimUrl = (u: string): string => u.trim().replace(/\/+$/, '')

function safeHost(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}
