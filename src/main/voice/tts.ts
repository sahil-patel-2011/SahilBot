import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromWav } from './audio'

/** Swappable text-to-speech engine. */
export interface TtsEngine {
  readonly name: string
  warm(): Promise<void>
  synth(text: string): Promise<{ audio: Float32Array; rate: number }>
}

/** Kokoro-82M (ONNX, q8) through kokoro-js, fully local. */
export class KokoroEngine implements TtsEngine {
  readonly name = 'Kokoro-82M'
  private tts: any = null

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
    const a = await this.tts.generate(text, { voice: this.voice })
    return { audio: a.audio as Float32Array, rate: a.sampling_rate as number }
  }
}

/** Fallback when Kokoro isn't installed: macOS's built-in voices. */
export class SayEngine implements TtsEngine {
  readonly name = 'macOS voice'
  async warm(): Promise<void> {}
  synth(text: string): Promise<{ audio: Float32Array; rate: number }> {
    const dir = mkdtempSync(join(tmpdir(), 'say-'))
    const out = join(dir, 'a.wav')
    return new Promise((ok, bad) => {
      execFile('say', ['-o', out, '--data-format=LEI16@22050', text], (e) => {
        if (e) return bad(e)
        try {
          const w = fromWav(readFileSync(out))
          ok({ audio: w.samples, rate: w.rate })
        } catch (err) { bad(err) } finally { rmSync(dir, { recursive: true, force: true }) }
      })
    })
  }
}
