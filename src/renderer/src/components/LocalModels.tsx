import { voicePreference, connectedVoice, nativeVoiceSite, voiceChoice, type CloudSpeechProvider } from '@shared/voice-provider'
import { useState } from 'react'
import type { Settings } from '@shared/types'
import { toast } from '../lib/toast'
import '../styles-attachments.css'

// Settings → Models: local models are opt-in. Off (the default for new installs): one quiet row, no
// download prompts anywhere. Turning it on brings back Ollama setup and the recommended downloads.

/** Local models are on (an explicit off is the only "off"; see shared/local-mode.ts). */
export const localIsOn = (s: Pick<Settings, 'local'>): boolean => s.local?.enabled !== false

export function LocalModelsRow({ s, patch, onChanged }: { s: Settings; patch: (p: Partial<Settings>) => Promise<unknown>; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false)
  const on = localIsOn(s)
  const set = async (v: boolean): Promise<void> => {
    setBusy(true)
    try { await patch({ local: { enabled: v } }); onChanged?.() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  return (
    <div className={`set-row${on ? '' : ' local-off-row'}`} data-testid="local-models-row" data-on={on ? '1' : '0'}>
      <div className="set-row-text">
        <div className="set-row-title">Local models: {on ? 'on' : 'off'}</div>
        <div className="set-row-sub">
          {on
            ? 'Free, private models on this Mac (Ollama, LM Studio) are available to Auto and the model picker.'
            : 'SahilBot uses your cloud models. Turn on to also use free local models on this Mac (Ollama; downloads ~5–20 GB).'}
        </div>
      </div>
      <div className="set-row-ctl">
        <button className={`btn${on ? '' : ' primary'}`} disabled={busy} onClick={() => void set(!on)} data-testid={on ? 'local-turn-off' : 'local-turn-on'}>{on ? 'Turn off' : 'Turn on'}</button>
      </div>
    </div>
  )
}

/**
 * Settings → Voice: OpenAI for voice (paid, within the monthly limit): it transcribes when speech
 * recognition on this Mac isn't ready or is off, and speaks replies. Off: the Mac's own voice (free), or
 * Kokoro on this Mac when local models are on.
 */
export function VoiceOutputRow({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => Promise<unknown> }) {
  const preference = voicePreference(s)
  const selected = connectedVoice(preference, { openai: !!s.keys.openai, xai: !!s.keys.xai })
  const choice = voiceChoice(preference, { openai: !!s.keys.openai, xai: !!s.keys.xai })
  return (
    <div className="set-row" data-testid="voice-output-row">
      <div className="set-row-text">
        <div className="set-row-title">Voice</div>
        <div className="set-row-sub">{preference === 'claude-app' ? 'Claude talks in its own app: Talk opens Claude\'s voice mode in your browser.' : nativeVoiceSite(preference) ? 'Talk opens the provider website. Select Voice there to use your account.' : preference === 'off' ? 'Pick Grok, ChatGPT or Claude to talk with your bots.' : selected ? `Uses your ${selected === 'xai' ? 'Grok (xAI)' : 'OpenAI'} key, within your monthly limit.` : `Add your ${choice === 'openai' ? 'OpenAI (ChatGPT)' : 'Grok (xAI)'} key in AI & spending to talk.`}</div>
      </div>
      <select className="set-select" aria-label="Whose voice" data-testid="voice-provider" value={choice} onChange={(e) => void patch({ voiceOutput: { provider: e.target.value as CloudSpeechProvider } })}>
        <option value="xai">Grok</option>
        <option value="openai">ChatGPT</option>
        <option value="claude-app">Claude</option>
        {(choice === 'chatgpt-app' || choice === 'grok-app') && <option value={choice}>{choice === 'grok-app' ? 'Grok in browser' : 'ChatGPT in browser'}</option>}
        <option value="off">Off</option>
      </select>
    </div>
  )
}

/** Settings → Voice with local models off: what voice input uses, or what it needs (never a download). */
export function VoiceInputNote({ input, note }: { input?: 'whisper' | 'openai' | 'none'; note?: string }) {
  return (
    <div className="set-row local-off-row" data-testid="voice-input-note" data-input={input ?? ''}>
      <div className="set-row-text">
        <div className="set-row-title">Voice input</div>
        <div className="set-row-sub">{input === 'openai' ? 'OpenAI transcription (your OpenAI key).' : input === 'whisper' ? 'Whisper on this Mac.' : note ?? 'Voice input needs an OpenAI key or local models (Settings → Voice).'}</div>
      </div>
    </div>
  )
}
