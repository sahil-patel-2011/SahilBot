import { api } from '../api'

// Microphone in (16 kHz mono, 512-sample frames to main) and speech out (queued playback).

export class Mic {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private pending = new Float32Array(0)
  level = 0

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    // Chromium resamples the mic to the context rate, so this yields 16 kHz directly.
    this.ctx = new AudioContext({ sampleRate: 16000 })
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(512, 1, 1)
    this.node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      let sum = 0
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
      this.level = Math.min(1, Math.sqrt(sum / input.length) * 8)
      const merged = new Float32Array(this.pending.length + input.length)
      merged.set(this.pending)
      merged.set(input, this.pending.length)
      let off = 0
      while (merged.length - off >= 512) {
        api.voice.frame(merged.slice(off, off + 512))
        off += 512
      }
      this.pending = merged.slice(off)
    }
    src.connect(this.node)
    this.node.connect(this.ctx.destination)
  }

  stop(): void {
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.ctx = this.node = this.stream = null
    this.level = 0
  }
}

export class Speaker {
  private ctx = new AudioContext()
  private at = 0
  private sources: AudioBufferSourceNode[] = []
  private analyser = this.ctx.createAnalyser()

  constructor() {
    this.analyser.fftSize = 256
    this.analyser.connect(this.ctx.destination)
  }

  play(audio: Float32Array, rate: number): void {
    const buf = this.ctx.createBuffer(1, audio.length, rate)
    buf.copyToChannel(new Float32Array(audio), 0)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.analyser)
    const start = Math.max(this.ctx.currentTime + 0.02, this.at)
    src.start(start)
    this.at = start + buf.duration
    this.sources.push(src)
    src.onended = () => { this.sources = this.sources.filter((s) => s !== src) }
  }

  stop(): void {
    for (const s of this.sources) try { s.stop() } catch { /* already ended */ }
    this.sources = []
    this.at = 0
  }

  get playing(): boolean {
    return this.sources.length > 0
  }

  get level(): number {
    const d = new Uint8Array(this.analyser.frequencyBinCount)
    this.analyser.getByteTimeDomainData(d)
    let sum = 0
    for (const v of d) sum += ((v - 128) / 128) ** 2
    return Math.min(1, Math.sqrt(sum / d.length) * 4)
  }

  close(): void {
    this.stop()
    void this.ctx.close()
  }
}
