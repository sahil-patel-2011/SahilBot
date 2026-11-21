import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromWav } from './audio'

/** Swappable text-to-speech engine. */
export interface TtsEngine {
  readonly name: string
  /** The voice id (per engine) and speed (1 = normal), when the engine supports them. */
  voice?: string
  speed?: number
  warm(): Promise<void>
  synth(text: string): Promise<{ audio: Float32Array; rate: number }>
}

/** Kokoro-82M (ONNX, q8) through kokoro-js, fully local. */
export class KokoroEngine implements TtsEngine {
  readonly name = 'Kokoro-82M'
  private tts: any = null

  speed = 1
  constructor(private cacheDir: string, public voice = 'af_heart') {}

  async warm(): Promise<void> {
    if (this.tts) return
    const { env } = await import('@huggingface/transformers')
    env.cacheDir = this.cacheDir
    // Models are downloaded from Settings > Voice; never fetch silently while talking.
    env.allowRemoteModels = process.env.FOREMAN_ALLOW_MODEL_DOWNLOAD === '1'
    const { KokoroTTS } = await import('kokoro-js')
    this.tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })
    await this.tts.generate('Ready.', { voice: this.voice })
  }

  async synth(text: string): Promise<{ audio: Float32Array; rate: number }> {
    await this.warm()
    const a = await this.tts.generate(text, { voice: this.voice, speed: this.speed })
    return { audio: a.audio as Float32Array, rate: a.sampling_rate as number }
  }
}

/** Fallback when Kokoro isn't installed: macOS's built-in voices. */
export class SayEngine implements TtsEngine {
  readonly name = 'macOS voice'
  voice?: string
  speed = 1
  async warm(): Promise<void> {}
  synth(text: string): Promise<{ audio: Float32Array; rate: number }> {
    const dir = mkdtempSync(join(tmpdir(), 'say-'))
    const out = join(dir, 'a.wav')
    return new Promise((ok, bad) => {
      const args = ['-o', out, '--data-format=LEI16@22050', ...(this.voice ? ['-v', this.voice] : []), ...(this.speed !== 1 ? ['-r', String(Math.round(185 * this.speed))] : []), text.replace(/^-+/, '')]
      execFile('say', args, (e) => {
        if (e) return bad(e)
        try {
          const w = fromWav(readFileSync(out))
          ok({ audio: w.samples, rate: w.rate })
        } catch (err) { bad(err) } finally { rmSync(dir, { recursive: true, force: true }) }
      })
    })
  }
}

/**
 * OpenAI text-to-speech (gpt-4o-mini-tts, WAV), for speaking replies when local voices are off and the
 * user allowed it with an OpenAI key saved. `guard` runs before each request (the monthly limit can
 * refuse it) and `charged` after, with the characters sent.
 */
export class OpenAITtsEngine implements TtsEngine {
  readonly name = 'OpenAI voice'
  voice?: string
  speed = 1
  constructor(private o: {
    baseUrl: string
    apiKey: () => string | undefined
    voice?: string
    model?: string
    guard?: (chars: number) => void
    charged?: (chars: number) => void
    fetch?: typeof fetch
  }) {}

  async warm(): Promise<void> {}

  async synth(text: string): Promise<{ audio: Float32Array; rate: number }> {
    const key = this.o.apiKey()
    if (!key) throw new Error('No OpenAI key is saved for OpenAI voices.')
    this.o.guard?.(text.length)
    const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.o.model ?? 'gpt-4o-mini-tts', voice: this.voice ?? this.o.voice ?? 'alloy', input: text.slice(0, 4000), response_format: 'wav', ...(this.speed !== 1 ? { speed: this.speed } : {}) }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`OpenAI voice answered ${res.status}`)
    this.o.charged?.(text.length)
    const w = fromWav(Buffer.from(await res.arrayBuffer()))
    return { audio: w.samples, rate: w.rate }
  }
}

export type TtsChoice = 'kokoro' | 'openai' | 'xai' | 'say'

/**
 * Which voice speaks replies. Local on with Kokoro downloaded: Kokoro. Otherwise OpenAI's voice when an
 * OpenAI key is saved, cloud models are on and the user allowed it; else the Mac's own voice (free,
 * nothing to download). With local models off Kokoro is never used or downloaded.
 */
export function chooseTts(o: { localOn: boolean; kokoroInstalled: boolean; openaiKey: boolean; openaiAllowed: boolean; cloudOn?: boolean; spendingNone?: boolean }): TtsChoice {
  if (o.localOn && o.kokoroInstalled) return 'kokoro'
  if (o.openaiKey && o.openaiAllowed && o.cloudOn !== false && !o.spendingNone) return 'openai'
  return 'say'
}
