import { appRoot, isPackaged } from '../paths'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline as streamPipeline } from 'node:stream/promises'
import type { VoiceStatus } from '@shared/types'
import { SentenceSplitter } from './audio'
import { VoicePipeline, type VoiceEvent } from './pipeline'
import { KokoroEngine, SayEngine, chooseTts, type TtsChoice, type TtsEngine } from './tts'
import { EnergyVad, SileroVad, type Vad } from './vad'
import { chooseStt, type SttChoice, type SpeechToText } from './stt'
import { WhisperServer } from './whisper'
import { WHISPER_MODELS, pickWhisper, whisperUrl, type Hardware, type WhisperBench, type WhisperModel, type WhisperPick } from './models'

// Electron side of voice: model files, the whisper-server process, and one pipeline that
// either dictates into the composer or runs a hands-free voice conversation.
// Speech recognition is local by default: the Whisper model voice/models.ts picks for this Mac downloads
// itself in the background (after onboarding, or on first mic use), checked against the official
// SHA-256, with progress in Settings → Voice. In test runs (download: 'stub') nothing is ever fetched.

export const MODELS_DIR = process.env.FOREMAN_MODELS_DIR || join(homedir(), 'Library/Application Support/Foreman/models')

/** Silero VAD (voice detection). Verified against GitHub's own blob hash for the file before it's used. */
const VAD = {
  file: 'silero_vad.onnx', mb: 2,
  url: 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx',
  meta: 'https://api.github.com/repos/snakers4/silero-vad/contents/src/silero_vad/data/silero_vad.onnx'
} as const

function whisperBin(): string {
  return isPackaged() ? join(appRoot(), 'whisper', 'whisper-server') : join(appRoot(), 'vendor/whisper.cpp/build/bin/whisper-server')
}

export type DownloadEvent = { type: 'download'; kind: string; progress: number; done?: boolean; error?: string; auto?: boolean; model?: string; label?: string }

export interface VoiceHooks {
  emit(e: VoiceEvent | DownloadEvent): void
  /** Sends text to the voice thread's agent and streams the reply text back. */
  respond(text: string, signal: AbortSignal, onText: (t: string) => void): Promise<void>
  /**
   * How replies may be spoken (llm-free): local voices allowed (local models on), and OpenAI's voice when
   * the user allowed it with a key saved (null otherwise). Without it: Kokoro when downloaded, else say.
   */
  output?(): { localOn: boolean; openai: TtsEngine | null; spendingNone?: boolean; openaiStt?: SpeechToText | null }
  /**
   * Speech recognition preferences (Settings → Voice): transcribe on this Mac (default on, whatever
   * local models say), the model ('auto' or a pinned id), the one-time benchmark, and this Mac.
   */
  input?(): { local: boolean; choice: string; bench?: WhisperBench | null; hw: Hardware }
  /** The one-time benchmark finished (saved so it never runs again for that model). */
  saveBench?(b: WhisperBench): void
  /** A spoken sentence (16 kHz mono) for the benchmark, or null when none can be made. */
  speechSample?(): Promise<Float32Array | null>
}

export interface VoiceOptions {
  modelsDir?: string
  /** 'stub' (test runs): downloads are recorded and reported, never fetched. */
  download?: 'real' | 'stub'
  fetch?: typeof fetch
}

type Prep = { model: string; label: string; progress: number; error?: string; running: boolean }

export class VoiceService {
  private whisper: WhisperServer | null = null
  private whisperFile: string | null = null
  private vad: Vad | null = null
  /** Which speech recognition the current pipeline was built with. */
  private pipeStt: SttChoice['kind'] | null = null
  private tts: TtsEngine | null = null
  private pipe: VoicePipeline | null = null
  private kokoroVoice = 'af_heart'
  private prep: Prep | null = null
  private benching = false
  /** Files asked for this session (Settings → Voice and tests: only speech models, never an LLM). */
  readonly requested: string[] = []
  private readonly dir: string
  active: 'off' | 'voice' | 'dictation' = 'off'

  constructor(private hooks: VoiceHooks, private opts: VoiceOptions = {}) {
    this.dir = opts.modelsDir || MODELS_DIR
    mkdirSync(this.dir, { recursive: true })
  }

  /** The voice replies are spoken with right now (tts.ts chooseTts). */
  private outputChoice(): TtsChoice {
    const o = this.hooks.output?.()
    return chooseTts({ localOn: o?.localOn ?? true, kokoroInstalled: this.kokoroInstalled(), openaiKey: !!o?.openai, openaiAllowed: !!o?.openai, spendingNone: o?.spendingNone })
  }

  private inputPrefs(): { local: boolean; choice: string; bench?: WhisperBench | null; hw: Hardware } {
    return this.hooks.input?.() ?? { local: true, choice: 'auto', hw: { ramGB: 16, appleSilicon: process.arch === 'arm64' } }
  }

  /** The Whisper model picked for this Mac (voice/models.ts). */
  pick(): WhisperPick {
    const p = this.inputPrefs()
    return pickWhisper(p.hw, { choice: p.choice, bench: p.bench })
  }

  private ready(m: WhisperModel): boolean {
    const f = join(this.dir, m.file)
    try { return existsSync(f) && statSync(f).size === m.bytes } catch { return false }
  }

  /** The model transcription uses now: the pick when it's downloaded, else any other ready one until it is. */
  private activeModel(): WhisperModel | null {
    const want = this.pick().model
    if (this.ready(want)) return want
    return [...WHISPER_MODELS].reverse().find((m) => this.ready(m)) ?? null
  }

  /** The speech recognition voice input uses right now (stt.ts chooseStt). */
  private inputChoice(): SttChoice {
    const o = this.hooks.output?.()
    const p = this.inputPrefs()
    const st = this.files()
    return chooseStt({
      localOn: p.local, whisperReady: st.binary && !!this.activeModel(), openaiKey: !!o?.openaiStt, openaiAllowed: !!o?.openaiStt, spendingNone: o?.spendingNone,
      preparing: this.prep ? { label: this.prep.label, progress: this.prep.progress, error: this.prep.error } : { label: this.pick().model.label }
    })
  }

  private files(): { binary: boolean; whisper: boolean; vad: boolean } {
    const vad = join(this.dir, VAD.file)
    return { binary: existsSync(whisperBin()), whisper: !!this.activeModel(), vad: existsSync(vad) && statSync(vad).size > 1000 }
  }

  private engine(): TtsEngine {
    const want = this.outputChoice()
    const have: TtsChoice | null = this.tts instanceof KokoroEngine ? 'kokoro' : this.tts instanceof SayEngine ? 'say' : this.tts ? 'openai' : null
    // A conversation in progress keeps its voice; the next one picks again.
    if (this.tts && (have === want || this.active !== 'off')) return this.tts
    this.tts = want === 'kokoro' ? new KokoroEngine(join(this.dir, 'hf'), this.kokoroVoice) : want === 'openai' ? this.hooks.output?.()?.openai ?? new SayEngine() : new SayEngine()
    // The pipeline holds its voice: a new one is made with the new engine.
    this.pipe = null
    return this.tts
  }

  private kokoroInstalled(): boolean {
    return existsSync(join(this.dir, 'hf', 'onnx-community', 'Kokoro-82M-v1.0-ONNX'))
  }

  status(): VoiceStatus {
    const f = this.files()
    const pick = this.pick()
    const prefs = this.inputPrefs()
    const active = this.activeModel()
    const ready = this.ready(pick.model)
    return {
      binary: f.binary,
      whisper: f.whisper,
      vad: f.vad,
      kokoro: this.kokoroInstalled(),
      voice: this.kokoroVoice,
      active: this.active,
      sizes: { whisper: Math.round(pick.model.bytes / 1e6), vad: VAD.mb, kokoro: 92 },
      output: this.outputChoice(),
      speech: {
        model: pick.model.id, label: pick.model.label, build: pick.model.build, mb: Math.round(pick.model.bytes / 1e6),
        reason: pick.reason, why: pick.why, choice: prefs.choice, local: prefs.local, ready,
        using: active && active.id !== pick.model.id ? { model: active.id, label: `${active.label} (${active.build})` } : undefined,
        state: !prefs.local ? 'off' : ready ? 'ready' : this.prep?.error ? 'error' : this.prep ? 'downloading' : 'waiting',
        progress: this.prep && !ready ? this.prep.progress : undefined,
        error: this.prep?.error,
        bench: prefs.bench && prefs.bench.model === pick.model.id ? prefs.bench.ms : undefined,
        stub: this.opts.download === 'stub' || undefined,
        requested: [...this.requested]
      },
      ...(() => { const c = this.inputChoice(); return { input: c.kind, ...(c.kind === 'none' ? { inputNote: c.note } : {}) } })()
    }
  }

  setVoice(v: string): void {
    this.kokoroVoice = v
    if (this.tts instanceof KokoroEngine) this.tts.voice = v
  }

  /**
   * Gets speech recognition ready in the background: the picked Whisper model (and Silero voice detection),
   * no prompt. Called after onboarding, at launch, when the choice changes, and on mic use. A failure is
   * remembered for the status line and retried on the next call. Resolves when done (or skipped).
   */
  async prepare(why: 'auto' | 'mic' | 'user' = 'auto'): Promise<void> {
    const prefs = this.inputPrefs()
    if (!prefs.local && why !== 'user') return
    const m = this.pick().model
    if (this.ready(m)) { if (!this.files().vad) await this.fetchVad().catch(() => undefined); return this.benchmark() }
    if (this.prep?.running && (this.prep.model === m.id || this.opts.download !== 'stub')) return
    if (this.prep?.error && why === 'auto' && this.prep.model === m.id) return
    this.prep = { model: m.id, label: `${m.label}, ${m.build}`, progress: 0, running: true }
    const auto = why !== 'user'
    this.requested.push(m.file)
    if (this.opts.download === 'stub') {
      // Test runs: report it like a real download that hasn't finished; nothing is fetched or written.
      // It stays "downloading" for the session, so it's asked for once.
      this.hooks.emit({ type: 'download', kind: 'whisper', progress: 0, auto, model: m.id, label: m.label })
      return
    }
    try {
      await this.fetchWhisper(m, auto)
      this.prep = null
      // A conversation picks the new model up next time (the server restarts with it then).
      this.hooks.emit({ type: 'download', kind: 'whisper', progress: 1, done: true, auto, model: m.id, label: m.label })
      if (!this.files().vad) await this.fetchVad().catch(() => undefined)
      // The choice changed while this one downloaded (Settings → Voice → Advanced): get that one too.
      if (this.pick().model.id !== m.id) return this.prepare('auto')
      await this.benchmark()
    } catch (e) {
      const error = (e as Error).message.slice(0, 200)
      this.prep = { ...this.prep!, running: false, error }
      this.hooks.emit({ type: 'download', kind: 'whisper', progress: 0, error, auto, model: m.id, label: m.label })
    }
  }

  private async fetchWhisper(m: WhisperModel, auto: boolean): Promise<void> {
    const f = this.opts.fetch ?? fetch
    const res = await f(whisperUrl(m))
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
    const tmp = join(this.dir, `${m.file}.part`)
    const hash = createHash('sha256')
    let got = 0
    let last = 0
    const body = Readable.fromWeb(res.body as never)
    body.on('data', (c: Buffer) => {
      hash.update(c)
      got += c.length
      if (this.prep) this.prep.progress = Math.min(0.99, got / m.bytes)
      if (Date.now() - last > 250) { last = Date.now(); this.hooks.emit({ type: 'download', kind: 'whisper', progress: Math.min(0.99, got / m.bytes), auto, model: m.id, label: m.label }) }
    })
    try {
      await streamPipeline(body, createWriteStream(tmp))
      const sum = hash.digest('hex')
      // The official checksum and size (voice/models.ts, from the repository's LFS metadata) or nothing is kept.
      if (got !== m.bytes || sum !== m.sha256) throw new Error('the file didn\'t match the official checksum')
      renameSync(tmp, join(this.dir, m.file))
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  /** Silero VAD, checked against the git blob hash GitHub reports for it. Optional: the built-in detector works without it. */
  private async fetchVad(): Promise<void> {
    if (this.opts.download === 'stub') { this.requested.push(VAD.file); return }
    const f = this.opts.fetch ?? fetch
    const meta = await f(VAD.meta, { headers: { accept: 'application/vnd.github+json' } })
    if (!meta.ok) throw new Error(`metadata ${meta.status}`)
    const { sha, size } = (await meta.json()) as { sha?: string; size?: number }
    const res = await f(VAD.url)
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    const blob = createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
    if (!sha || buf.length !== size || blob !== sha) throw new Error('the file didn\'t match GitHub\'s checksum')
    const tmp = join(this.dir, `${VAD.file}.part`)
    writeFileSync(tmp, buf)
    renameSync(tmp, join(this.dir, VAD.file))
    this.requested.push(VAD.file)
  }

  /**
   * The one-time benchmark (16–31 GB Macs, large-v3-turbo): a spoken sentence through whisper-server once;
   * too slow and the pick becomes Whisper small (voice/models.ts), which then downloads in the background.
   */
  private async benchmark(): Promise<void> {
    const pick = this.pick()
    if (!pick.benchmark || this.benching || !this.hooks.saveBench || !this.files().binary || this.opts.download === 'stub') return
    this.benching = true
    try {
      const sample = await this.hooks.speechSample?.()
      if (!sample) return
      const server = this.server(pick.model)
      await server.start()
      const t0 = performance.now()
      await server.transcribe(sample)
      const ms = Math.round(performance.now() - t0)
      this.hooks.saveBench({ model: pick.model.id, ms, at: Date.now() })
      if (this.active === 'off') { this.whisper?.stop(); this.whisper = null; this.whisperFile = null; this.pipe = null }
      if (this.pick().model.id !== pick.model.id) void this.prepare('auto')
    } catch { /* tried again next launch */ } finally { this.benching = false }
  }

  /** The whisper-server for this model (a different model restarts it). */
  private server(m: WhisperModel): WhisperServer {
    if (this.whisper && this.whisperFile !== m.file) { this.whisper.stop(); this.whisper = null; this.pipe = null }
    this.whisper ??= new WhisperServer(whisperBin(), join(this.dir, m.file))
    this.whisperFile = m.file
    return this.whisper
  }

  /** Model download from Settings → Voice: Whisper (retry or a pinned model), Silero, or Kokoro (local voices only). */
  async download(kind: 'whisper' | 'vad' | 'kokoro'): Promise<void> {
    if (kind === 'whisper') return this.prepare('user')
    try {
      if (kind === 'kokoro') {
        // Kokoro is a local voice model: never downloaded while local models are off.
        if (this.hooks.output && !this.hooks.output().localOn) throw new Error('Local voices are off. Turn on local models in Settings → Models first; until then replies use OpenAI\'s voice (if allowed) or the Mac\'s own voice.')
        if (this.opts.download === 'stub') { this.requested.push('kokoro'); return }
        process.env.FOREMAN_ALLOW_MODEL_DOWNLOAD = '1'
        this.hooks.emit({ type: 'download', kind, progress: 0.1 })
        const k = new KokoroEngine(join(this.dir, 'hf'), this.kokoroVoice)
        await k.warm()
        process.env.FOREMAN_ALLOW_MODEL_DOWNLOAD = '0'
        this.hooks.emit({ type: 'download', kind, progress: 1, done: true })
        return
      }
      this.hooks.emit({ type: 'download', kind, progress: 0.1 })
      await this.fetchVad()
      this.hooks.emit({ type: 'download', kind, progress: 1, done: true })
    } catch (e) {
      this.hooks.emit({ type: 'download', kind, progress: 0, error: (e as Error).message })
      if (kind === 'kokoro') throw e
    }
  }

  private async ensure(): Promise<VoicePipeline> {
    const st = this.files()
    // First mic use before the background download got going (or after it failed): start it now.
    if (this.inputPrefs().local && !this.ready(this.pick().model) && !this.prep?.running) void this.prepare('mic')
    const choice = this.inputChoice()
    let stt: SpeechToText
    if (choice.kind === 'whisper') {
      stt = this.server(this.activeModel()!)
    } else if (choice.kind === 'openai') {
      stt = this.hooks.output!().openaiStt!
    } else {
      if (this.inputPrefs().local && !st.binary) throw new Error('Speech recognition isn\'t built yet (whisper.cpp). Run scripts/voice-setup.sh.')
      throw new Error(choice.note)
    }
    // Voice detection: Silero when it's on this Mac; otherwise the built-in one (nothing to download).
    this.vad ??= st.vad ? await SileroVad.load(join(this.dir, VAD.file)) : new EnergyVad()
    if (this.pipeStt !== choice.kind) { this.pipe = null; this.pipeStt = choice.kind }
    const tts = this.engine()
    await Promise.all([stt.start(), tts.warm()])
    this.pipe ??= new VoicePipeline({ vad: this.vad, whisper: stt, tts, emit: (e) => this.hooks.emit(e), respond: (t, s, on) => this.hooks.respond(t, s, on) })
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
    const tts = this.engine()
    // Code, source lists and reactions don't belong in speech.
    const body = text.replace(/<react>[\s\S]*?<\/react>/g, '').replace(/\n+Sources?:[\s\S]*$/i, '').replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/\n+/g, '. ').replace(/\.\s*\./g, '.')
    const split = new SentenceSplitter()
    for (const sentence of [...split.push(`${body} `), ...split.flush()]) {
      if (token !== this.speaking) return
      const { audio, rate } = await tts.synth(sentence)
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
