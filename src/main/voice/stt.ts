import { toWav, SAMPLE_RATE } from './audio'

// Cloud transcription handles one completed utterance per request. Local Whisper requires explicit opt-in.

/** What the voice pipeline needs from speech recognition (whisper-server or the cloud). */
export interface SpeechToText {
  /** Runs on SahilBot's side for free (whisper) or per request in the cloud (no live partials then). */
  readonly cloud?: boolean
  start(): Promise<void>
  transcribe(samples: Float32Array, prompt?: string): Promise<string>
}

export const NO_VOICE_INPUT = 'Choose an available speech provider in Settings → Voice and enable its API key in Models & Keys.'

export type SttChoice = { kind: 'whisper' } | { kind: 'openai' } | { kind: 'xai' } | { kind: 'none'; note: string }

/**
 * Which speech recognition voice input uses. localOn: transcribing on this Mac is allowed (the default,
 * independent of local models). Whisper when its model is ready; until then OpenAI's when allowed with a
 * key; else a short note (what's downloading, or what's needed).
 */
export function chooseStt(o: { localOn: boolean; whisperReady: boolean; openaiKey: boolean; openaiAllowed: boolean; cloudOn?: boolean; spendingNone?: boolean; preparing?: { label: string; progress?: number; error?: string } | null }): SttChoice {
  if (o.localOn && o.whisperReady) return { kind: 'whisper' }
  if (o.openaiKey && o.openaiAllowed && o.cloudOn !== false && !o.spendingNone) return { kind: 'openai' }
  if (o.localOn) {
    const p = o.preparing
    if (p?.error) return { kind: 'none', note: `Speech recognition couldn't download (${p.error}). It tries again the next time you use the mic, or retry in Settings → Voice.` }
    const pct = p && typeof p.progress === 'number' && p.progress > 0 ? `, ${Math.round(p.progress * 100)}%` : ''
    return { kind: 'none', note: `Getting speech recognition ready on this Mac (${p?.label ?? 'Whisper'}${pct}). Try again in a minute.` }
  }
  return { kind: 'none', note: NO_VOICE_INPUT }
}

export interface Transcribed { text: string; usage?: unknown; duration?: number }

/**
 * OpenAI transcription for one utterance (WAV, 16 kHz mono). `guard` runs before each request with the
 * audio's length in seconds (the monthly limit can refuse it); `charged` after, with the result.
 */
export class OpenAISttEngine implements SpeechToText {
  readonly cloud = true
  constructor(private o: {
    transcribe: (file: { name: string; data: Buffer; mime: string }, prompt: string | undefined, signal: AbortSignal) => Promise<Transcribed>
    guard?: (seconds: number) => void
    charged?: (seconds: number, t: Transcribed) => void
  }) {}

  async start(): Promise<void> {}

  async transcribe(samples: Float32Array, prompt?: string): Promise<string> {
    const seconds = samples.length / SAMPLE_RATE
    if (seconds < 0.25) return ''
    this.o.guard?.(seconds)
    const t = await this.o.transcribe({ name: 'speech.wav', data: toWav(samples), mime: 'audio/wav' }, prompt, AbortSignal.timeout(60_000))
    this.o.charged?.(seconds, t)
    return (t.text ?? '').replace(/\s+/g, ' ').trim()
  }
}
