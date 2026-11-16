import { ANTHROPIC_URL, XAI_URL, baseUrlOf } from '../llm/providers'
import type { SettingsStore } from '../settings'
import type { AnthropicCreds } from './anthropic'
import type { OpenAICreds } from './openai'

// The user's own OpenAI and Anthropic keys for the media, vision and batch tools: the same Keychain
// entries (one per endpoint origin) the chat models use. Nothing is returned while cloud models are
// switched off (or that provider is, in Settings → Models & Keys), so the tools disappear from the tool list too.

export interface ApiAccess {
  cloudOn(): boolean
  openai(): OpenAICreds | undefined
  anthropic(): AnthropicCreds | undefined
  xai(): OpenAICreds | undefined
}

export function apiAccess(settings: Pick<SettingsStore, 'get' | 'providers' | 'keyFor'>): ApiAccess {
  const on = (): boolean => settings.get().cloud.enabled
  const off = (id: 'openai' | 'anthropic' | 'xai'): boolean => !!settings.get().disabledProviders?.includes(id)
  return {
    cloudOn: on,
    openai() {
      if (!on() || off('openai')) return undefined
      const baseUrl = baseUrlOf('openai', settings.providers())
      const apiKey = settings.keyFor(baseUrl)
      return apiKey ? { baseUrl, apiKey } : undefined
    },
    anthropic() {
      if (!on() || off('anthropic')) return undefined
      const apiKey = settings.keyFor(ANTHROPIC_URL)
      return apiKey ? { baseUrl: ANTHROPIC_URL, apiKey } : undefined
    },
    xai() {
      if (!on() || off('xai')) return undefined
      const apiKey = settings.keyFor(XAI_URL)
      return apiKey ? { baseUrl: XAI_URL, apiKey } : undefined
    }
  }
}
