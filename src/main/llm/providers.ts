import type { ProviderId, ProviderPreset, ProviderSettings } from '@shared/types'

// Model servers. Several can be on at once: local ones are found by asking them which models they
// have; cloud ones claim models by name (any "claude-…" goes to Anthropic, like Cursor does).
// Keys live in the Keychain, one per endpoint, so a Claude key is never sent to LM Studio.

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1'
export const OPENAI_URL = 'https://api.openai.com/v1'
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'

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
  { id: 'openrouter', name: 'OpenRouter', local: false, needsKey: true, claims: /^[a-z0-9-]+\/[^/]+$/i, keyUrl: 'https://openrouter.ai/keys', keyHint: 'Used for models named like "vendor/model". Spending is capped by your monthly budget.' }
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
  }
}

// One-click choices for first-run setup.
export const PROVIDERS: ProviderPreset[] = [
  { id: 'ollama', name: 'Ollama (local)', baseUrl: DEFAULT_PROVIDERS.ollama.baseUrl, needsKey: false, defaultModel: 'auto' },
  { id: 'lmstudio', name: 'LM Studio (local)', baseUrl: DEFAULT_PROVIDERS.lmstudio.baseUrl, needsKey: false, optionalKey: true, keyHint: def('lmstudio').keyHint, defaultModel: 'auto' },
  { id: 'anthropic', name: 'Anthropic (Claude)', baseUrl: ANTHROPIC_URL, needsKey: true, keyHint: 'Starts with sk-ant-. Usage is capped by your monthly budget.', keyUrl: def('anthropic').keyUrl, defaultModel: 'auto' },
  { id: 'openai', name: 'OpenAI', baseUrl: OPENAI_URL, needsKey: true, keyUrl: def('openai').keyUrl, defaultModel: 'auto' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: OPENROUTER_URL, needsKey: true, keyUrl: def('openrouter').keyUrl, defaultModel: 'auto' }
]

/** Keychain entry for an endpoint's key: one per origin. */
export const keyName = (baseUrl: string): string => {
  try { return `apiKey@${new URL(baseUrl).origin}` } catch { return `apiKey@${baseUrl.trim()}` }
}

export const isAnthropic = (baseUrl: string): boolean => /(^|\.)anthropic\.com$/.test(safeHost(baseUrl))

function safeHost(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}
