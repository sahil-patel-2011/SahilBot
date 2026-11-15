import { toWav, SAMPLE_RATE } from './audio'

// Speech to text, cloud first. Local models on (and Whisper downloaded): whisper.cpp on this Mac. Local
// off: OpenAI's transcription when an OpenAI key is saved and the user allowed OpenAI for voice (the same
// switch as spoken replies), charged against the monthly limit. Otherwise voice input says what it needs;
// it never asks to download the Whisper model while local models are off.
// macOS's own speech recognition isn't reachable from Electron without a native helper (SFSpeechRecognizer)
// and Chromium's Web Speech API needs Google's servers, so neither is used.

/** What the voice pipeline needs from speech recognition (whisper-server or the cloud). */
export interface SpeechToText {
  /** Runs on SahilBot's side for free (whisper) or per request in the cloud (no live partials then). */
  readonly cloud?: boolean
  start(): Promise<void>
  transcribe(samples: Float32Array, prompt?: string): Promise<string>
}

export const NO_VOICE_INPUT = 'Voice input needs an OpenAI key or local models (Settings → Voice).'

export type SttChoice = { kind: 'whisper' } | { kind: 'openai' } | { kind: 'none'; note: string }

/**
 * Which speech recognition voice input uses. Local on: Whisper (its download lives in Settings → Voice;
 * until it's there, OpenAI's when allowed). Local off: OpenAI's when allowed with a key, else a quiet note.
 */
export function chooseStt(o: { localOn: boolean; whisperReady: boolean; openaiKey: boolean; openaiAllowed: boolean; cloudOn?: boolean; spendingNone?: boolean }): SttChoice {
  if (o.localOn && o.whisperReady) return { kind: 'whisper' }
  if (o.openaiKey && o.openaiAllowed && o.cloudOn !== false && !o.spendingNone) return { kind: 'openai' }
  if (o.localOn) return { kind: 'none', note: 'Download the voice models in Settings > Voice first.' }
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
