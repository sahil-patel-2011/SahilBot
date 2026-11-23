import { SAMPLE_RATE } from './audio'
import type { VoiceEvent } from './pipeline'

// Grok Voice 3.0: a live speech-to-speech conversation with xAI's realtime model (wss://api.x.ai/v1/realtime,
// OpenAI Realtime-compatible events). Grok listens (its own voice detection, so you can talk over it), talks
// back in its own voice, and hands real work to the chat's bot through one tool (do_task): the bot's agent does
// it with its memory, apps, files and the web, in the bot's chat, and Grok tells you the result. Replaces the
// speech-to-text → model → text-to-speech chain when the voice is Grok and an xAI key is saved.

export const GROK_VOICE_MODEL = 'grok-voice-3.0'
/** xAI's price for speech to speech (grok-voice-3.0): per minute of the conversation. */
export const GROK_VOICE_USD_PER_MIN = 0.08
const OUT_RATE = 24_000

export interface RealtimeSocket {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
}

export interface GrokRealtimeOptions {
  apiKey: string
  /** https://api.x.ai/v1 (the key's own base URL). */
  baseUrl?: string
  model?: string
  voice?: string
  /** Who it is and how to talk (the bot's name, the user's name, short spoken answers). */
  instructions: string
  /** The chat's bot does the work: returns what it did or found (its reply), streamed into one text. */
  doTask(request: string, signal: AbortSignal): Promise<string>
  emit(e: VoiceEvent): void
  /** Charged when the conversation ends, by the minute (spending limit and usage). */
  charge?(usd: number, minutes: number): void
  fetch?: typeof fetch
  socket?: (url: string, protocols: string[]) => RealtimeSocket
  now?: () => number
}

/** PCM16 little-endian, base64: what the realtime API takes and gives. */
export function toPcm16Base64(samples: Float32Array): string {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  return buf.toString('base64')
}

export function fromPcm16Base64(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  const out = new Float32Array(Math.floor(buf.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

/** The tool Grok calls for anything beyond conversation. */
export const DO_TASK_TOOL = {
  type: 'function',
  name: 'do_task',
  description: 'Have the bot do something for the user, or look something up: anything that needs their memory and past chats, their files, apps, email or calendar, the web, current information, or an action (send, schedule, make, change). Pass the user\'s request in their own words with any details from this conversation. Returns what the bot did or found.',
  parameters: { type: 'object', properties: { request: { type: 'string', description: 'What the user wants, in full' } }, required: ['request'] }
}

/** The instructions Grok gets: who it is, how to talk, and when to hand work to the bot. */
export function grokVoiceInstructions(o: { botName: string; userName?: string; language?: string }): string {
  return [
    `You are ${o.botName}, talking with ${o.userName || 'the user'} out loud. Keep replies short and natural, one to three sentences, like a phone call. No lists, markdown, links or emoji.`,
    'You have no memory, files, apps or web access yourself. For anything that needs them, or any action, call do_task with the full request. Before calling it, say a few words such as "On it." Then tell the user the result briefly in your own words; offer details only if they ask.',
    'Never claim you did something unless do_task says it was done. If it needs the user (an approval, a choice), ask them.',
    o.language ? `Speak ${o.language} unless the user switches.` : ''
  ].filter(Boolean).join('\n')
}

export class GrokRealtime {
  private ws: RealtimeSocket | null = null
  private startedAt = 0
  private responding = false
  private tasks = new Map<string, AbortController>()
  private queue: string[] = []
  private closed = false
  private replyText = ''

  constructor(private o: GrokRealtimeOptions) {}

  /** Opens the conversation: a short-lived token for the socket (the key never rides on it), then the session. */
  async start(): Promise<void> {
    const base = (this.o.baseUrl ?? 'https://api.x.ai/v1').replace(/\/+$/, '')
    const res = await (this.o.fetch ?? fetch)(`${base}/realtime/client_secrets`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { seconds: 600 } })
    })
    if (!res.ok) throw new Error(`Grok voice couldn't start (${res.status}). Check your xAI key in Settings → AI & spending.`)
    const token = (await res.json() as { value?: string }).value
    if (!token) throw new Error('Grok voice couldn\'t start: no session token.')
    const url = `${base.replace(/^http/, 'ws')}/realtime?model=${encodeURIComponent(this.o.model ?? GROK_VOICE_MODEL)}`
    const make = this.o.socket ?? ((u: string, p: string[]) => new (globalThis as unknown as { WebSocket: new (u: string, p: string[]) => RealtimeSocket }).WebSocket(u, p))
    const ws = make(url, [`xai-client-secret.${token}`])
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Grok voice took too long to connect.')), 15_000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('Grok voice couldn\'t connect.')) }
    })
    this.startedAt = (this.o.now ?? Date.now)()
    ws.onmessage = (ev) => { try { this.handle(JSON.parse(String(ev.data))) } catch { /* not JSON */ } }
    ws.onerror = () => this.o.emit({ type: 'error', message: 'Grok voice lost its connection.' })
    ws.onclose = () => { if (!this.closed) { this.o.emit({ type: 'error', message: 'Grok voice disconnected.' }); this.finish() } }
    this.send({
      type: 'session.update',
      session: {
        instructions: this.o.instructions,
        voice: this.o.voice ?? 'eve',
        turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, transcription: { model: 'grok-transcribe' } },
          output: { format: { type: 'audio/pcm', rate: OUT_RATE } }
        },
        tools: [DO_TASK_TOOL]
      }
    })
    this.o.emit({ type: 'state', state: 'listening' })
  }

  /** A frame from the microphone (16 kHz mono). */
  pushAudio(samples: Float32Array): void {
    if (this.ws?.readyState === 1) this.send({ type: 'input_audio_buffer.append', audio: toPcm16Base64(samples) })
  }

  /** Something to say on its own between turns (a bot finished work started in this conversation). */
  announce(text: string): void {
    if (this.responding) { this.queue.push(text); return }
    this.send({ type: 'response.create', response: { instructions: `Briefly tell the user, in one or two sentences: ${text}` } })
  }

  /** Ends the conversation (and any work it started stops waiting on it). */
  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.ws?.close() } catch { /* already closed */ }
    this.finish()
  }

  private finish(): void {
    this.closed = true
    for (const c of this.tasks.values()) c.abort()
    this.tasks.clear()
    if (this.startedAt) {
      const minutes = Math.max(1 / 60, ((this.o.now ?? Date.now)() - this.startedAt) / 60_000)
      this.o.charge?.(minutes * GROK_VOICE_USD_PER_MIN, minutes)
      this.startedAt = 0
    }
    this.o.emit({ type: 'state', state: 'idle' })
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg))
  }

  private handle(e: Record<string, unknown>): void {
    const type = String(e.type ?? '')
    switch (type) {
      case 'input_audio_buffer.speech_started':
        // You started talking: Grok stops (barge-in), the way a person would.
        this.o.emit({ type: 'stop-audio' })
        if (this.responding) this.send({ type: 'response.cancel' })
        this.o.emit({ type: 'state', state: 'hearing' })
        return
      case 'input_audio_buffer.speech_stopped':
        this.o.emit({ type: 'state', state: 'thinking' })
        return
      case 'conversation.item.input_audio_transcription.updated':
        if (typeof e.transcript === 'string') this.o.emit({ type: 'partial', text: e.transcript })
        return
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof e.transcript === 'string' && e.transcript.trim()) this.o.emit({ type: 'transcript', text: e.transcript.trim() })
        return
      case 'response.created':
        this.responding = true
        this.replyText = ''
        return
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const b64 = typeof e.delta === 'string' ? e.delta : typeof e.audio === 'string' ? e.audio : ''
        if (!b64) return
        this.o.emit({ type: 'state', state: 'speaking' })
        this.o.emit({ type: 'audio', audio: fromPcm16Base64(b64), rate: OUT_RATE })
        return
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (typeof e.delta === 'string') this.replyText += e.delta
        return
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = (typeof e.transcript === 'string' ? e.transcript : this.replyText).trim()
        if (text) this.o.emit({ type: 'reply', text })
        this.replyText = ''
        return
      }
      case 'response.function_call_arguments.done':
        void this.runTool(String(e.call_id ?? ''), String(e.name ?? ''), String(e.arguments ?? '{}'))
        return
      case 'response.done':
        this.responding = false
        if (!this.tasks.size) this.o.emit({ type: 'state', state: 'listening' })
        if (this.queue.length) this.announce(this.queue.shift()!)
        return
      case 'error': {
        const err = (e.error ?? e) as { message?: string }
        this.o.emit({ type: 'error', message: `Grok voice: ${err.message ?? 'something went wrong'}` })
        return
      }
    }
  }

  private async runTool(callId: string, name: string, args: string): Promise<void> {
    if (!callId) return
    let output: string
    if (name !== 'do_task') output = `There is no tool called ${name}.`
    else {
      let request = ''
      try { request = String((JSON.parse(args) as { request?: unknown }).request ?? '') } catch { /* bad JSON */ }
      if (!request.trim()) output = 'No request was given.'
      else {
        const ctrl = new AbortController()
        this.tasks.set(callId, ctrl)
        this.o.emit({ type: 'state', state: 'thinking' })
        try { output = (await this.o.doTask(request, ctrl.signal)).trim().slice(0, 6000) || 'The bot finished without a reply.' }
        catch (err) { output = `The bot couldn't do it: ${(err as Error).message}` }
        finally { this.tasks.delete(callId) }
      }
    }
    if (this.closed) return
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } })
    this.send({ type: 'response.create' })
  }
}
