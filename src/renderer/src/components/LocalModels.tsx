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
 * Settings → Voice → Speaking: which voice reads replies. Kokoro (local) only with local models on;
 * otherwise OpenAI's voice when allowed here with a key saved (paid, within the monthly limit), else the
 * Mac's own voice (free, nothing to download).
 */
export function VoiceOutputRow({ s, patch, output }: { s: Settings; patch: (p: Partial<Settings>) => Promise<unknown>; output?: 'kokoro' | 'openai' | 'say' }) {
  const allowed = !!s.voiceOutput?.openai
  const hasKey = !!s.keys?.openai
  const now = output === 'kokoro' ? 'Kokoro (on this Mac)' : output === 'openai' ? 'OpenAI voice' : output === 'say' ? 'the Mac\'s own voice' : ''
  return (
    <div className="set-row" data-testid="voice-output-row">
      <div className="set-row-text">
        <div className="set-row-title">Use OpenAI for voice</div>
        <div className="set-row-sub">
          {hasKey ? 'OpenAI listens (transcription, about 0.5¢ a minute) and speaks (about 1.5¢ a minute) through your OpenAI key, counted in your monthly limit.' : 'Needs an OpenAI key (Settings → API Keys).'}
          {localIsOn(s) ? ' Whisper and Kokoro, when downloaded, are used first.' : ' Off: replies use the Mac\'s own voice (free); voice input needs this or local models.'}
          {now ? ` Replies are spoken with ${now}.` : ''}
        </div>
      </div>
      <div className="set-row-ctl">
        <button type="button" role="switch" aria-checked={allowed} className={`btn${allowed ? ' primary' : ''}`} disabled={!hasKey && !allowed}
          onClick={() => void patch({ voiceOutput: { openai: !allowed } })} data-testid="voice-openai">{allowed ? 'On' : 'Off'}</button>
      </div>
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
