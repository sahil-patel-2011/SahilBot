import { ANTHROPIC_URL, baseUrlOf } from '../llm/providers'
import type { SettingsStore } from '../settings'
import type { AnthropicCreds } from './anthropic'
import type { OpenAICreds } from './openai'

// The user's own OpenAI and Anthropic keys for the media, vision and batch tools: the same Keychain
// entries (one per endpoint origin) the chat models use. Nothing is returned while cloud models are
// switched off, so the tools disappear from the tool list too.

export interface ApiAccess {
  cloudOn(): boolean
  openai(): OpenAICreds | undefined
  anthropic(): AnthropicCreds | undefined
}

export function apiAccess(settings: Pick<SettingsStore, 'get' | 'providers' | 'keyFor'>): ApiAccess {
  const on = (): boolean => settings.get().cloud.enabled
  return {
    cloudOn: on,
    openai() {
      if (!on()) return undefined
      const baseUrl = baseUrlOf('openai', settings.providers())
      const apiKey = settings.keyFor(baseUrl)
      return apiKey ? { baseUrl, apiKey } : undefined
    },
    anthropic() {
      if (!on()) return undefined
      const apiKey = settings.keyFor(ANTHROPIC_URL)
      return apiKey ? { baseUrl: ANTHROPIC_URL, apiKey } : undefined
    }
  }
}
