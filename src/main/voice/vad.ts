import { FRAME, SAMPLE_RATE } from './audio'

// Silero VAD (onnxruntime-node). Speech starts above `start` probability; it ends after
// `endMs` of frames below `stop` (500 ms by spec).

export interface VadEvents {
  onStart(): void
  onEnd(): void
}

export class SileroVad {
  private session: any
  private ort: any
  private state!: any
  private sr!: any
  private speaking = false
  private silentMs = 0
  private voicedMs = 0
  private context = new Float32Array(64)
  start = 0.5
  stop = 0.35
  endMs = 500
  /** Raised while audio is playing so speaker echo doesn't trigger barge-in. */
  minSpeechMs = 96

  static async load(modelPath: string): Promise<SileroVad> {
    const v = new SileroVad()
    v.ort = await import('onnxruntime-node')
    v.session = await v.ort.InferenceSession.create(modelPath)
    v.reset()
    return v
  }

  reset(): void {
    this.state = new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
    this.sr = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]))
    this.speaking = false
    this.silentMs = 0
    this.voicedMs = 0
    this.context = new Float32Array(64)
  }

  get silence(): number {
    return this.silentMs
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  async prob(frame: Float32Array): Promise<number> {
    // Silero v5 expects 64 samples of context before each 512-sample frame.
    const input = new Float32Array(64 + FRAME)
    input.set(this.context, 0)
    input.set(frame.subarray(0, FRAME), 64)
    this.context = input.slice(input.length - 64)
    const out = await this.session.run({ input: new this.ort.Tensor('float32', input, [1, input.length]), state: this.state, sr: this.sr })
    this.state = out.stateN
    return (out.output.data as Float32Array)[0]
  }

  /** Feed one 512-sample frame; fires onStart/onEnd at speech boundaries. */
  async feed(frame: Float32Array, ev: VadEvents): Promise<number> {
    const p = await this.prob(frame)
    const ms = (FRAME / SAMPLE_RATE) * 1000
    if (!this.speaking) {
      this.voicedMs = p >= this.start ? this.voicedMs + ms : 0
      if (this.voicedMs >= this.minSpeechMs) {
        this.speaking = true
        this.silentMs = 0
        ev.onStart()
      }
    } else {
      this.silentMs = p < this.stop ? this.silentMs + ms : 0
      if (this.silentMs >= this.endMs) {
        this.speaking = false
        this.voicedMs = 0
        ev.onEnd()
      }
    }
    return p
  }
}

/** What the voice pipeline needs from a voice detector (Silero, or the energy fallback below). */
export interface Vad {
  start: number
  stop: number
  endMs: number
  minSpeechMs: number
  readonly silence: number
  readonly isSpeaking: boolean
  reset(): void
  feed(frame: Float32Array, ev: VadEvents): Promise<number>
}

/**
 * A voice detector with nothing to download: loudness against an adaptive noise floor, mapped to a 0–1
 * "speech" score with the same thresholds and timing as Silero. Used when the Silero model isn't on this
 * Mac (local models off: nothing is downloaded for voice).
 */
export class EnergyVad implements Vad {
  start = 0.5
  stop = 0.35
  endMs = 500
  minSpeechMs = 96
  private speaking = false
  private silentMs = 0
  private voicedMs = 0
  private floor = 0.004

  get silence(): number { return this.silentMs }
  get isSpeaking(): boolean { return this.speaking }

  reset(): void {
    this.speaking = false
    this.silentMs = 0
    this.voicedMs = 0
  }

  /** 0–1: how far above the noise floor this frame is (about 4x the floor counts as speech). */
  prob(frame: Float32Array): number {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / Math.max(1, frame.length))
    const ratio = rms / Math.max(this.floor, 1e-4)
    // The floor follows quiet frames quickly and loud ones slowly (a room's hum, not the voice).
    this.floor = ratio < 2 ? this.floor * 0.95 + rms * 0.05 : this.floor * 0.999 + rms * 0.001
    return Math.max(0, Math.min(1, (ratio - 1) / 6))
  }

  async feed(frame: Float32Array, ev: VadEvents): Promise<number> {
    const p = this.prob(frame)
    const ms = (FRAME / SAMPLE_RATE) * 1000
    if (!this.speaking) {
      this.voicedMs = p >= this.start ? this.voicedMs + ms : 0
      if (this.voicedMs >= this.minSpeechMs) { this.speaking = true; this.silentMs = 0; ev.onStart() }
    } else {
      this.silentMs = p < this.stop ? this.silentMs + ms : 0
      if (this.silentMs >= this.endMs) { this.speaking = false; this.voicedMs = 0; ev.onEnd() }
    }
    return p
  }
}
