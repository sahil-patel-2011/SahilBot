import type { Settings } from './types'

export type CloudSpeechProvider = 'auto' | 'openai' | 'xai' | 'off' | 'chatgpt-app' | 'grok-app' | 'claude-app'

export function voicePreference(s: Pick<Settings, 'voiceOutput'>): CloudSpeechProvider {
  // Not chosen yet: Auto, Grok's voice first, else ChatGPT's (whichever key is connected).
  return s.voiceOutput?.provider ?? (s.voiceOutput?.openai ? 'openai' : s.voiceOutput?.openai === false ? 'off' : 'auto')
}

export function connectedVoice(preference: CloudSpeechProvider, keys: { openai: boolean; xai: boolean }): 'openai' | 'xai' | undefined {
  if (preference === 'auto') return keys.xai ? 'xai' : keys.openai ? 'openai' : undefined
  if ((preference === 'openai' || preference === 'xai') && keys[preference]) return preference
  return undefined
}

export function nativeVoiceSite(preference: CloudSpeechProvider): string | undefined {
  if (preference === 'chatgpt-app') return 'https://chatgpt.com/'
  if (preference === 'grok-app') return 'https://grok.com/'
  // Claude has no voice API: its own voice mode, in the browser.
  if (preference === 'claude-app') return 'https://claude.ai/new'
  return undefined
}

/** The one choice Settings shows: Grok, ChatGPT, Claude or Off ("Auto" shows as what it uses, Grok first). */
export function voiceChoice(preference: CloudSpeechProvider, keys: { openai: boolean; xai: boolean }): 'xai' | 'openai' | 'claude-app' | 'off' | 'chatgpt-app' | 'grok-app' {
  if (preference === 'auto') return connectedVoice('auto', keys) ?? 'xai'
  return preference
}
