import { appRoot, isPackaged } from '../paths'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline as streamPipeline } from 'node:stream/promises'
import type { VoiceStatus } from '@shared/types'
import { SentenceSplitter } from './audio'
import { VoicePipeline, type VoiceEvent } from './pipeline'
import { KokoroEngine, SayEngine, type TtsEngine } from './tts'
import { SileroVad } from './vad'
import { WhisperServer } from './whisper'

// Electron side of voice: model files, the whisper-server process, and one pipeline that
// either dictates into the composer or runs a hands-free voice conversation.

export const MODELS_DIR = process.env.FOREMAN_MODELS_DIR || join(homedir(), 'Library/Application Support/Foreman/models')

const FILES = {
  whisper: { file: 'ggml-large-v3-turbo-q5_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin', mb: 574 },
  vad: { file: 'silero_vad.onnx', url: 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx', mb: 2 }
} as const

function whisperBin(): string {
  return isPackaged() ? join(appRoot(), 'whisper', 'whisper-server') : join(appRoot(), 'vendor/whisper.cpp/build/bin/whisper-server')
}

export interface VoiceHooks {
  emit(e: VoiceEvent | { type: 'download'; kind: string; progress: number; done?: boolean; error?: string }): void
  /** Sends text to the voice thread's agent and streams the reply text back. */
  respond(text: string, signal: AbortSignal, onText: (t: string) => void): Promise<void>
}

export class VoiceService {
  private whisper: WhisperServer | null = null
  private vad: SileroVad | null = null
  private tts: TtsEngine | null = null
  private pipe: VoicePipeline | null = null
  private kokoroVoice = 'af_heart'
  active: 'off' | 'voice' | 'dictation' = 'off'

  constructor(private hooks: VoiceHooks) {
    mkdirSync(MODELS_DIR, { recursive: true })
  }

  private kokoroInstalled(): boolean {
    return existsSync(join(MODELS_DIR, 'hf', 'onnx-community', 'Kokoro-82M-v1.0-ONNX'))
  }

  status(): VoiceStatus {
    const has = (k: keyof typeof FILES): boolean => existsSync(join(MODELS_DIR, FILES[k].file)) && statSync(join(MODELS_DIR, FILES[k].file)).size > 1000
    return {
      binary: existsSync(whisperBin()),
      whisper: has('whisper'),
      vad: has('vad'),
      kokoro: this.kokoroInstalled(),
      voice: this.kokoroVoice,
      active: this.active,
      sizes: { whisper: FILES.whisper.mb, vad: FILES.vad.mb, kokoro: 92 }
    }
  }

  setVoice(v: string): void {
    this.kokoroVoice = v
    if (this.tts instanceof KokoroEngine) this.tts.voice = v
  }

  /** User-initiated model download (Settings > Voice). */
  async download(kind: 'whisper' | 'vad' | 'kokoro'): Promise<void> {
    try {
      if (kind === 'kokoro') {
        process.env.FOREMAN_ALLOW_MODEL_DOWNLOAD = '1'
        this.hooks.emit({ type: 'download', kind, progress: 0.1 })
        const k = new KokoroEngine(join(MODELS_DIR, 'hf'), this.kokoroVoice)
        await k.warm()
        process.env.FOREMAN_ALLOW_MODEL_DOWNLOAD = '0'
        this.hooks.emit({ type: 'download', kind, progress: 1, done: true })
        return
      }
      const f = FILES[kind]
      const res = await fetch(f.url)
      if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`)
      const total = Number(res.headers.get('content-length')) || f.mb * 1e6
      let got = 0
      let last = 0
      const tmp = join(MODELS_DIR, `${f.file}.part`)
      const body = Readable.fromWeb(res.body as never)
      body.on('data', (c: Buffer) => {
        got += c.length
        if (Date.now() - last > 250) { last = Date.now(); this.hooks.emit({ type: 'download', kind, progress: got / total }) }
      })
      await streamPipeline(body, createWriteStream(tmp))
      renameSync(tmp, join(MODELS_DIR, f.file))
      this.hooks.emit({ type: 'download', kind, progress: 1, done: true })
    } catch (e) {
      this.hooks.emit({ type: 'download', kind, progress: 0, error: (e as Error).message })
    }
  }

  private async ensure(): Promise<VoicePipeline> {
    const st = this.status()
    if (!st.binary) throw new Error('Speech recognition isn\'t built yet (whisper.cpp). Run scripts/voice-setup.sh.')
    if (!st.whisper || !st.vad) throw new Error('Download the voice models in Settings > Voice first.')
    this.whisper ??= new WhisperServer(whisperBin(), join(MODELS_DIR, FILES.whisper.file))
    this.vad ??= await SileroVad.load(join(MODELS_DIR, FILES.vad.file))
    this.tts ??= st.kokoro ? new KokoroEngine(join(MODELS_DIR, 'hf'), this.kokoroVoice) : new SayEngine()
    await Promise.all([this.whisper.start(), this.tts.warm()])
    this.pipe ??= new VoicePipeline({ vad: this.vad, whisper: this.whisper, tts: this.tts, emit: (e) => this.hooks.emit(e), respond: (t, s, on) => this.hooks.respond(t, s, on) })
    return this.pipe
  }

  async startVoice(): Promise<void> {
    const p = await this.ensure()
    p.stop()
    p.mode = 'voice'
    this.active = 'voice'
    this.hooks.emit({ type: 'state', state: 'listening' })
  }

  async startDictation(): Promise<void> {
    const p = await this.ensure()
    this.active = 'dictation'
    p.startDictation()
  }

  async stopDictation(): Promise<string> {
    if (!this.pipe || this.active !== 'dictation') return ''
    this.active = 'off'
    return this.pipe.stopDictation()
  }

  stop(): void {
    this.pipe?.stop()
    this.active = 'off'
  }

  private speaking = 0
  /**
   * Read text aloud (a reply, or "Try it"). Needs only the voice, not speech recognition: Kokoro when
   * downloaded, else the Mac's own voice. Each sentence plays as soon as it's ready; a new call or
   * stopSpeaking() cuts the current one off.
   */
  async speak(text: string): Promise<void> {
    const token = ++this.speaking
    this.hooks.emit({ type: 'stop-audio' })
    this.tts ??= this.kokoroInstalled() ? new KokoroEngine(join(MODELS_DIR, 'hf'), this.kokoroVoice) : new SayEngine()
    // Code, source lists and reactions don't belong in speech.
    const body = text.replace(/<react>[\s\S]*?<\/react>/g, '').replace(/\n+Sources?:[\s\S]*$/i, '').replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/\n+/g, '. ').replace(/\.\s*\./g, '.')
    const split = new SentenceSplitter()
    for (const sentence of [...split.push(`${body} `), ...split.flush()]) {
      if (token !== this.speaking) return
      const { audio, rate } = await this.tts.synth(sentence)
      if (token !== this.speaking) return
      this.hooks.emit({ type: 'audio', audio, rate } as VoiceEvent)
    }
  }

  stopSpeaking(): void {
    this.speaking++
    this.hooks.emit({ type: 'stop-audio' } as VoiceEvent)
  }

  frame(samples: Float32Array): void {
    if (this.active !== 'off') void this.pipe?.feed(samples)
  }

  dispose(): void {
    this.stop()
    this.whisper?.stop()
  }
}
