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
  /** Charged as the conversation goes (each minute, and the rest when it ends): spending limit and usage. */
  charge?(usd: number, minutes: number): void
  /** Checked every minute of the conversation: throws when the spending limit won't cover another minute or two. */
  guard?(minutes: number): void
  /** Hangs up after this long with nobody talking and no work running (default 5 minutes). */
  idleMs?: number
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

/**
 * What do_task tells Grok: the bot's answer only when its run finished; a stopped or failed run says so, so Grok
 * never tells a draft as if it were done.
 */
export function taskOutcome(status: 'finished' | 'stopped' | 'error' | undefined, reply: string | undefined, error?: string): string {
  if (status === 'error') return `The bot didn't finish: ${(error ?? '').trim() || 'it hit an error'}. Nothing more was done; tell the user.`
  if (status === 'stopped') return 'The run was stopped before it finished. Don\'t say it was done.'
  return reply?.trim() || 'The bot finished but wrote no reply.'
}

/** The instructions Grok gets: who it is, how to talk, and when to hand work to the bot. */
export function grokVoiceInstructions(o: { botName: string; userName?: string; language?: string; role?: string }): string {
  return [
    `You are ${o.botName}, talking with ${o.userName || 'the user'} out loud. Keep replies short and natural, one to three sentences, like a phone call. No lists, markdown, links or emoji.`,
    o.role ? `What you're for: ${o.role.replace(/\s+/g, ' ').trim().slice(0, 300)}` : '',
    'You have no memory, files, apps or web access yourself. For anything that needs them, or any action, call do_task with the full request. Before calling it, say a few words such as "On it." Then tell the user the result briefly in your own words; offer details only if they ask.',
    'Big jobs keep going in the chat even if the call ends: say so when one will take a while.',
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
  /** A response.create was sent and its response hasn't started yet: another one now would collide. */
  private requested = false
  /** Tool results that came back while Grok was talking: sent together when it finishes. */
  private outputs: Array<{ callId: string; output: string }> = []
  /** Talked over: what's still arriving of the cut-off reply isn't played. */
  private cancelled = false
  /** The reply being spoken: its item and how much audio of it went out (to tell Grok where it was cut off). */
  private item: { id: string; sentMs: number; firstAt: number } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private chargedMin = 0
  private lastActive = 0
  /** The bot runs one request at a time in its chat: a second do_task waits for the one before it. */
  private work: Promise<void> = Promise.resolve()
  /** Talked over a reply that was asked for but hadn't started: it's cancelled as soon as it starts. */
  private cancelNext = false

  constructor(private o: GrokRealtimeOptions) {}

  /** The call ended (hung up, idle, spending limit, disconnected): nothing more will be heard or said. */
  get isClosed(): boolean { return this.closed }

  /** The voice bar changed mid-call (voice, or the language in the instructions): applied to the session now. */
  update(o: { voice?: string; instructions?: string }): void {
    if (this.closed) return
    const session: Record<string, unknown> = {}
    if (o.instructions && o.instructions !== this.o.instructions) { this.o = { ...this.o, instructions: o.instructions }; session.instructions = o.instructions }
    if (o.voice && o.voice !== this.o.voice) { this.o = { ...this.o, voice: o.voice }; session.voice = o.voice }
    if (Object.keys(session).length) this.send({ type: 'session.update', session })
  }

  /** Opens the conversation: a short-lived token for the socket (the key never rides on it), then the session. */
  async start(): Promise<void> {
    const base = (this.o.baseUrl ?? 'https://api.x.ai/v1').replace(/\/+$/, '')
    let res: Response
    try {
      res = await (this.o.fetch ?? fetch)(`${base}/realtime/client_secrets`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_after: { seconds: 600 } }), signal: AbortSignal.timeout(15_000)
      })
    } catch (e) {
      throw new Error((e as Error).name === 'TimeoutError' ? 'Grok voice took too long to connect.' : 'Grok voice couldn\'t connect.')
    }
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
    this.lastActive = this.startedAt
    ws.onmessage = (ev) => { try { this.handle(JSON.parse(String(ev.data))) } catch { /* not JSON */ } }
    // A socket error is followed by its close, which says so once (and offers Reconnect).
    ws.onerror = () => undefined
    ws.onclose = () => { if (!this.closed) { this.o.emit({ type: 'error', message: 'Grok voice disconnected.' }); this.finish() } }
    // Every minute: charge it (a crash or a forced quit loses at most a minute), check the spending limit still
    // covers more, and hang up after a long silence.
    this.timer = setInterval(() => this.minute(), 60_000)
    ;(this.timer as { unref?: () => void }).unref?.()
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
    if (this.responding || this.requested) { this.queue.push(text); return }
    this.create({ instructions: `Briefly tell the user, in one or two sentences: ${text}` })
  }

  /** One response at a time: a new one only once the last has finished (the server refuses a second). */
  private create(response?: Record<string, unknown>): void {
    this.requested = true
    this.send(response ? { type: 'response.create', response } : { type: 'response.create' })
  }

  /** Grok finished talking: tool results that came back meanwhile first (one reply for all), then what to announce. */
  private flush(): void {
    if (this.closed || this.responding || this.requested) return
    if (this.outputs.length) {
      for (const o of this.outputs.splice(0)) this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: o.callId, output: o.output } })
      this.create()
      return
    }
    if (this.queue.length) this.announce(this.queue.shift()!)
  }

  /** The once-a-minute check (also called directly by tests). */
  minute(): void {
    if (this.closed || !this.startedAt) return
    const now = (this.o.now ?? Date.now)()
    const minutes = (now - this.startedAt) / 60_000
    const whole = Math.floor(minutes)
    if (whole > this.chargedMin) {
      this.o.charge?.((whole - this.chargedMin) * GROK_VOICE_USD_PER_MIN, whole - this.chargedMin)
      this.chargedMin = whole
    }
    try { this.o.guard?.(minutes) } catch {
      this.o.emit({ type: 'error', message: 'Voice chat ended: the spending limit is reached.' })
      this.close()
      return
    }
    if (!this.tasks.size && !this.responding && now - this.lastActive >= (this.o.idleMs ?? 5 * 60_000)) {
      this.o.emit({ type: 'error', message: 'Voice chat ended after a few quiet minutes.' })
      this.close()
    }
  }

  /** Ends the conversation (and any work it started stops waiting on it). */
  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.ws?.close() } catch { /* already closed */ }
    this.finish()
  }

  private finish(): void {
    const was = !!this.startedAt
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Hanging up stops waiting for the work, not the work: the bot finishes it in its chat ('hangup').
    for (const c of this.tasks.values()) c.abort('hangup')
    this.tasks.clear()
    if (this.startedAt) {
      const minutes = Math.max(1 / 60, ((this.o.now ?? Date.now)() - this.startedAt) / 60_000)
      const rest = Math.max(0, minutes - this.chargedMin)
      if (rest > 0) this.o.charge?.(rest * GROK_VOICE_USD_PER_MIN, rest)
      this.startedAt = 0
    }
    this.o.emit({ type: 'state', state: 'idle' })
    // The call is over (by itself or hung up): the app lets go of the microphone and the conversation.
    if (was) this.o.emit({ type: 'ended' })
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg))
  }

  private handle(e: Record<string, unknown>): void {
    const type = String(e.type ?? '')
    switch (type) {
      case 'input_audio_buffer.speech_started':
        // You started talking: Grok stops (barge-in), the way a person would, and remembers only what you heard.
        this.lastActive = (this.o.now ?? Date.now)()
        this.o.emit({ type: 'stop-audio' })
        // A reply asked for that hasn't started yet: cancelled the moment it does (never played over you).
        if (this.requested && !this.responding) this.cancelNext = true
        if (this.responding) {
          this.cancelled = true
          this.send({ type: 'response.cancel' })
          if (this.item) {
            const heard = Math.max(0, Math.min(this.item.sentMs, this.lastActive - this.item.firstAt))
            this.send({ type: 'conversation.item.truncate', item_id: this.item.id, content_index: 0, audio_end_ms: Math.round(heard) })
          }
        }
        this.item = null
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
        this.requested = false
        this.cancelled = this.cancelNext
        if (this.cancelNext) this.send({ type: 'response.cancel' })
        this.cancelNext = false
        this.item = null
        this.replyText = ''
        return
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const b64 = typeof e.delta === 'string' ? e.delta : typeof e.audio === 'string' ? e.audio : ''
        // The rest of a reply you talked over: dropped (it would start playing again).
        if (!b64 || this.cancelled) return
        const audio = fromPcm16Base64(b64)
        const now = (this.o.now ?? Date.now)()
        if (typeof e.item_id === 'string') {
          if (this.item?.id !== e.item_id) this.item = { id: e.item_id, sentMs: 0, firstAt: now }
          this.item.sentMs += audio.length / OUT_RATE * 1000
        }
        this.lastActive = now
        this.o.emit({ type: 'state', state: 'speaking' })
        this.o.emit({ type: 'audio', audio, rate: OUT_RATE })
        return
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (typeof e.delta === 'string') this.replyText += e.delta
        return
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = (typeof e.transcript === 'string' ? e.transcript : this.replyText).trim()
        if (text && !this.cancelled) this.o.emit({ type: 'reply', text, whole: true })
        this.replyText = ''
        return
      }
      case 'response.function_call_arguments.done':
        void this.runTool(String(e.call_id ?? ''), String(e.name ?? ''), String(e.arguments ?? '{}'))
        return
      case 'response.done':
        this.responding = false
        this.requested = false
        this.cancelled = false
        this.lastActive = (this.o.now ?? Date.now)()
        if (!this.tasks.size) this.o.emit({ type: 'state', state: 'listening' })
        this.flush()
        return
      case 'error': {
        // The server turned one request down (nothing to cancel, a reply already running…): the conversation goes
        // on, so it's a passing note, not the bar's error state.
        const err = (e.error ?? e) as { message?: string }
        this.requested = false
        this.cancelNext = false
        // Talking over Grok: the server's own voice detection may already have cancelled or cut the reply, so our
        // cancel or truncate is turned down. Expected, not news.
        if (!/cancel|no active response|truncat|already/i.test(err.message ?? '')) this.o.emit({ type: 'notice', message: `Grok voice: ${err.message ?? 'something went wrong'}` })
        this.flush()
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
        // One request at a time: the bot's chat runs one job, so a second call waits for the first to finish.
        const before = this.work
        let release!: () => void
        this.work = new Promise<void>((r) => { release = r })
        try {
          await before
          if (ctrl.signal.aborted) throw new Error('the call ended')
          output = (await this.o.doTask(request, ctrl.signal)).trim().slice(0, 6000) || 'The bot finished without a reply.'
        }
        catch (err) { output = `The bot couldn't do it: ${(err as Error).message}` }
        finally { release(); this.tasks.delete(callId) }
      }
    }
    if (this.closed) return
    this.lastActive = (this.o.now ?? Date.now)()
    // Grok may be talking right now (you spoke while the bot worked, or it's announcing): the result waits for the
    // end of that reply, then goes in with any others and one new reply.
    this.outputs.push({ callId, output })
    this.flush()
  }
}
