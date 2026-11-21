import type { Settings } from './types'

export type CloudSpeechProvider = 'auto' | 'openai' | 'xai' | 'off' | 'chatgpt-app' | 'grok-app'

export function voicePreference(s: Pick<Settings, 'voiceOutput'>): CloudSpeechProvider {
  // Not chosen yet: Auto, the cloud voice of whichever key is connected (ChatGPT's or Grok's).
  return s.voiceOutput?.provider ?? (s.voiceOutput?.openai ? 'openai' : s.voiceOutput?.openai === false ? 'off' : 'auto')
}

export function connectedVoice(preference: CloudSpeechProvider, keys: { openai: boolean; xai: boolean }): 'openai' | 'xai' | undefined {
  if (preference === 'auto') return keys.openai ? 'openai' : keys.xai ? 'xai' : undefined
  if ((preference === 'openai' || preference === 'xai') && keys[preference]) return preference
  return undefined
}

export function nativeVoiceSite(preference: CloudSpeechProvider): string | undefined {
  if (preference === 'chatgpt-app') return 'https://chatgpt.com/'
  if (preference === 'grok-app') return 'https://grok.com/'
  return undefined
}
