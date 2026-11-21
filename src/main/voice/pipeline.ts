import { concat, FRAME, SAMPLE_RATE, SentenceSplitter } from './audio'
import type { TtsEngine } from './tts'
import type { Vad } from './vad'
import type { SpeechToText } from './stt'

export type VoiceEvent =
  | { type: 'state'; state: 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking' }
  | { type: 'partial'; text: string }
  | { type: 'transcript'; text: string }
  | { type: 'reply'; text: string }
  /** Something said on its own, between turns (a bot finished work started in this conversation). */
  | { type: 'announce'; text: string }
  | { type: 'audio'; audio: Float32Array; rate: number }
  | { type: 'stop-audio' }
  | { type: 'metric'; name: 'first_audio_ms' | 'stt_ms'; ms: number }
  | { type: 'error'; message: string }

export interface PipelineDeps {
  vad: Vad
  /** Speech recognition: whisper-server on this Mac, or OpenAI's (cloud: no speculative or partial requests, each costs). */
  whisper: SpeechToText
  tts: TtsEngine
  /** Sends the user's words to the model; calls onText with streamed reply text. */
  respond(text: string, signal: AbortSignal, onText: (t: string) => void): Promise<void>
  emit(e: VoiceEvent): void
  now?: () => number
}

const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000
const PREROLL = Math.round(300 / FRAME_MS)
const SPECULATE_AT_MS = 250

/**
 * Voice mode: Silero VAD → whisper → model → TTS, speaking each sentence as soon as it's
 * finished. Talking over it (barge-in) stops playback and cancels the reply. Dictation mode
 * only transcribes, with live partials.
 */
export class VoicePipeline {
  private ring: Float32Array[] = []
  private speech: Float32Array[] = []
  private chain: Promise<void> = Promise.resolve()
  private reply: AbortController | null = null
  private generation = 0
  private stopped = 0
  private audioUntil = 0
  private lastVoiceAt = 0
  private speculative: { frames: number; text: Promise<string> } | null = null
  private dictation: Float32Array[] = []
  private lastPartialAt = 0
  private partialBusy = false
  /** Turns being transcribed or answered (from the end of the user's speech to the end of the reply). */
  private turns = 0
  private announcements: string[] = []
  private draining = false
  mode: 'voice' | 'dictation' = 'voice'

  constructor(private d: PipelineDeps) {}

  /** A new voice mid-conversation (ChatGPT's ⇄ Grok's): the next sentence uses it. */
  setTts(t: TtsEngine): void { this.d.tts = t }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /** True while a reply is being generated or its audio is still playing. */
  get busy(): boolean {
    return !!this.reply || this.now() < this.audioUntil
  }

  /** Feed one 512-sample frame of 16 kHz mono audio. Frames are processed in order. */
  feed(frame: Float32Array): Promise<void> {
    const stopped = this.stopped
    this.chain = this.chain.then(() => stopped === this.stopped ? this.process(frame) : undefined).catch((e) => this.d.emit({ type: 'error', message: (e as Error).message }))
    return this.chain
  }

  private async process(frame: Float32Array): Promise<void> {
    const vad = this.d.vad
    // Speaker echo shouldn't count as the user talking: demand longer speech while we're talking.
    vad.minSpeechMs = this.busy ? 288 : 96
    if (this.mode === 'dictation') this.dictation.push(frame)
    const p = await vad.feed(frame, {
      onStart: () => {
        this.speech = [...this.ring]
        this.speculative = null
        if (this.mode === 'voice') {
          if (this.busy) this.bargeIn()
          else this.generation++
        }
        this.d.emit({ type: 'state', state: 'hearing' })
      },
      onEnd: () => {
        if (this.mode === 'voice') void this.utterance()
        else this.d.emit({ type: 'state', state: 'listening' })
      }
    })
    if (p >= vad.stop) this.lastVoiceAt = this.now()
    this.ring.push(frame)
    if (this.ring.length > PREROLL) this.ring.shift()
    if (!vad.isSpeaking) return
    this.speech.push(frame)
    if (vad.silence === 0) this.speculative = null
    // Start transcribing during the pause; if the user keeps talking the guess is dropped.
    if (this.mode === 'voice' && !this.d.whisper.cloud && !this.speculative && vad.silence >= SPECULATE_AT_MS) {
      const audio = concat(this.speech)
      this.speculative = { frames: this.speech.length, text: this.d.whisper.transcribe(audio) }
    }
    if (this.mode === 'dictation' && !this.d.whisper.cloud && !this.partialBusy && this.now() - this.lastPartialAt > 700) {
      this.partialBusy = true
      this.lastPartialAt = this.now()
      void this.d.whisper.transcribe(concat(this.dictation)).then((t) => { if (t) this.d.emit({ type: 'partial', text: t }) }).finally(() => { this.partialBusy = false })
    }
  }

  private bargeIn(): void {
    this.generation++
    this.reply?.abort()
    this.reply = null
    this.audioUntil = 0
    this.d.emit({ type: 'stop-audio' })
  }

  private async utterance(): Promise<void> {
    this.turns++
    try { await this.turn() } finally { this.turns-- }
  }

  /**
   * Says something on its own (a bot finished the work you asked for). It waits for a gap: never while you're
   * talking, while your words are being answered, or while a reply is still playing. Talking over it stops it,
   * like any reply.
   */
  announce(text: string): void {
    if (this.mode !== 'voice' || !text.trim()) return
    this.announcements.push(text.trim())
    if (!this.draining) void this.drain()
  }

  private async drain(): Promise<void> {
    this.draining = true
    const stopped = this.stopped
    try {
      while (this.announcements.length && stopped === this.stopped) {
        if (this.mode !== 'voice' || this.busy || this.turns > 0 || this.d.vad.isSpeaking || this.now() - this.lastVoiceAt < 1200) {
          await new Promise((r) => setTimeout(r, 250))
          continue
        }
        const text = this.announcements.shift()!
        const ctrl = new AbortController()
        this.reply = ctrl
        this.d.emit({ type: 'announce', text })
        this.d.emit({ type: 'state', state: 'speaking' })
        const splitter = new SentenceSplitter()
        try {
          for (const s of [...splitter.push(text), ...splitter.flush()]) {
            if (ctrl.signal.aborted) break
            const { audio, rate } = await this.d.tts.synth(s)
            if (ctrl.signal.aborted) break
            this.audioUntil = Math.max(this.audioUntil, this.now()) + (audio.length / rate) * 1000
            this.d.emit({ type: 'audio', audio, rate })
          }
        } catch (e) {
          this.d.emit({ type: 'error', message: (e as Error).message })
        } finally {
          if (this.reply === ctrl) this.reply = null
        }
        if (!ctrl.signal.aborted) this.d.emit({ type: 'state', state: 'listening' })
      }
    } finally {
      this.draining = false
      // Something queued while the old loop was finishing (a quick stop and start): say it too.
      if (this.announcements.length && stopped !== this.stopped) void this.drain()
    }
  }

  private async turn(): Promise<void> {
    const endedAt = this.lastVoiceAt
    const t0 = this.now()
    const spec = this.speculative
    this.speculative = null
    const generation = this.generation
    const audio = concat(this.speech)
    this.speech = []
    let text: string
    try { text = spec ? await spec.text : await this.d.whisper.transcribe(audio) } catch (error) {
      if (this.generation === generation) this.d.emit({ type: 'error', message: (error as Error).message })
      return
    }
    if (generation !== this.generation) return
    this.d.emit({ type: 'metric', name: 'stt_ms', ms: this.now() - t0 })
    if (!text || /^[\s.,!?-]*$/.test(text)) {
      this.d.emit({ type: 'state', state: 'listening' })
      return
    }
    this.d.emit({ type: 'transcript', text })
    this.d.emit({ type: 'state', state: 'thinking' })
    const ctrl = new AbortController()
    this.reply = ctrl
    const splitter = new SentenceSplitter()
    let speaking = Promise.resolve()
    let first = true
    const say = (sentence: string): void => {
      speaking = speaking.then(async () => {
        if (ctrl.signal.aborted) return
        const { audio, rate } = await this.d.tts.synth(sentence)
        if (ctrl.signal.aborted) return
        if (first) {
          first = false
          this.d.emit({ type: 'metric', name: 'first_audio_ms', ms: this.now() - endedAt })
          this.d.emit({ type: 'state', state: 'speaking' })
        }
        this.audioUntil = Math.max(this.audioUntil, this.now()) + (audio.length / rate) * 1000
        this.d.emit({ type: 'audio', audio, rate })
      })
    }
    try {
      await this.d.respond(text, ctrl.signal, (t) => {
        this.d.emit({ type: 'reply', text: t })
        for (const s of splitter.push(t)) say(s)
      })
      for (const s of splitter.flush()) say(s)
      await speaking
    } catch (e) {
      if (!ctrl.signal.aborted) this.d.emit({ type: 'error', message: (e as Error).message })
    } finally {
      if (this.reply === ctrl) this.reply = null
      if (!ctrl.signal.aborted) this.d.emit({ type: 'state', state: 'listening' })
    }
  }

  /** Dictation: start collecting; stop() returns the final transcript. */
  startDictation(): void {
    this.mode = 'dictation'
    this.dictation = []
    this.lastPartialAt = this.now()
    this.d.vad.reset()
    this.d.emit({ type: 'state', state: 'listening' })
  }

  async stopDictation(): Promise<string> {
    await this.chain
    const audio = concat(this.dictation)
    this.dictation = []
    this.mode = 'voice'
    const text = audio.length > SAMPLE_RATE / 4 ? await this.d.whisper.transcribe(audio) : ''
    this.d.emit({ type: 'transcript', text })
    this.d.emit({ type: 'state', state: 'idle' })
    return text
  }

  stop(): void {
    this.stopped++
    this.announcements = []
    this.bargeIn()
    this.d.vad.reset()
    this.speech = []
    this.ring = []
    this.d.emit({ type: 'state', state: 'idle' })
  }
}
