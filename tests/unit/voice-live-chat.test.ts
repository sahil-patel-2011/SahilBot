import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { GrokRealtime, grokVoiceInstructions, taskOutcome, toPcm16Base64, type RealtimeSocket } from '../../src/main/voice/grok-realtime'
import type { VoiceEvent } from '../../src/main/voice/pipeline'
import { VoiceService } from '../../src/main/voice/service'
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))
vi.mock('../../src/renderer/src/api', () => ({ api: {}, isServerRuntime: false }))
import { nextCaption } from '../../src/renderer/src/components/VoiceMode'

// Grok Voice 3.0 in the chat: one do_task at a time, talking over a reply that hasn't started, a token request
// that can't hang, whole replies in the caption, and the conversation itself kept in the chat (service hooks).

type FakeWs = RealtimeSocket & { serve(e: Record<string, unknown>): void }
function fakeSocket() {
  const sent: Array<Record<string, unknown>> = []
  let ws!: FakeWs
  const make = () => {
    ws = {
      readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: (d: string) => { sent.push(JSON.parse(d)) },
      close: () => { ws.readyState = 3 },
      serve: (e) => ws.onmessage?.({ data: JSON.stringify(e) })
    }
    setTimeout(() => { ws.readyState = 1; ws.onopen?.({}) }, 0)
    return ws
  }
  return { sent, make, get ws() { return ws } }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const okToken = (async () => new Response(JSON.stringify({ value: 't' }), { status: 200 })) as never

async function setup(doTask: (req: string, signal: AbortSignal) => Promise<string>) {
  const sock = fakeSocket()
  const events: VoiceEvent[] = []
  const live = new GrokRealtime({ apiKey: 'k', instructions: 'x', emit: (e) => events.push(e), doTask, socket: sock.make, fetch: okToken })
  await live.start()
  return { sock, events, live }
}

test('two do_task calls in one response run one after the other (never "still working in this thread")', async () => {
  const log: string[] = []
  const finish: Array<() => void> = []
  const { sock } = await setup((req) => new Promise((resolve) => {
    log.push(`start ${req}`)
    finish.push(() => { log.push(`end ${req}`); resolve(`did ${req}`) })
  }))
  sock.ws.serve({ type: 'response.created' })
  sock.ws.serve({ type: 'response.function_call_arguments.done', call_id: 'a', name: 'do_task', arguments: JSON.stringify({ request: 'email Priya' }) })
  sock.ws.serve({ type: 'response.function_call_arguments.done', call_id: 'b', name: 'do_task', arguments: JSON.stringify({ request: 'add it to my calendar' }) })
  sock.ws.serve({ type: 'response.done' })
  await tick()
  // Only the first is running; the second waits its turn.
  expect(log).toEqual(['start email Priya'])
  finish[0]()
  await tick(); await tick()
  expect(log).toEqual(['start email Priya', 'end email Priya', 'start add it to my calendar'])
  // Grok tells the first result (one reply at a time); the second goes in once that reply is done.
  sock.ws.serve({ type: 'response.created' })
  finish[1]()
  await tick(); await tick()
  sock.ws.serve({ type: 'response.done' })
  const outputs = sock.sent.filter((m) => m.type === 'conversation.item.create').map((m) => (m.item as { call_id: string; output: string }))
  expect(outputs).toEqual([{ type: 'function_call_output', call_id: 'a', output: 'did email Priya' }, { type: 'function_call_output', call_id: 'b', output: 'did add it to my calendar' }])
})

test('hanging up while a do_task waits its turn: the waiting one never starts', async () => {
  const started: string[] = []
  const { sock, live } = await setup((req, signal) => new Promise((resolve) => {
    started.push(req)
    signal.addEventListener('abort', () => resolve(''))
  }))
  sock.ws.serve({ type: 'response.function_call_arguments.done', call_id: 'a', name: 'do_task', arguments: JSON.stringify({ request: 'one' }) })
  sock.ws.serve({ type: 'response.function_call_arguments.done', call_id: 'b', name: 'do_task', arguments: JSON.stringify({ request: 'two' }) })
  await tick()
  live.close()
  await tick(); await tick()
  expect(started).toEqual(['one'])
})

test('talking over a reply that was asked for but has not started: it is cancelled as it starts, never played', async () => {
  const { sock, events, live } = await setup(async () => 'Done.')
  live.announce('Your report is ready.')
  expect(sock.sent.filter((m) => m.type === 'response.create')).toHaveLength(1)
  sock.ws.serve({ type: 'input_audio_buffer.speech_started' })
  sock.ws.serve({ type: 'response.created' })
  expect(sock.sent.at(-1)).toEqual({ type: 'response.cancel' })
  sock.ws.serve({ type: 'response.output_audio.delta', item_id: 'i1', delta: toPcm16Base64(new Float32Array(240)) })
  sock.ws.serve({ type: 'response.output_audio_transcript.done', transcript: 'Your report is ready.' })
  expect(events.some((e) => e.type === 'audio')).toBe(false)
  expect(events.some((e) => e.type === 'reply')).toBe(false)
  sock.ws.serve({ type: 'response.done' })
  // The next reply (to what you said) plays normally.
  sock.ws.serve({ type: 'response.created' })
  sock.ws.serve({ type: 'response.output_audio.delta', item_id: 'i2', delta: toPcm16Base64(new Float32Array(240)) })
  sock.ws.serve({ type: 'response.output_audio_transcript.done', transcript: 'Sure.' })
  expect(events.filter((e) => e.type === 'audio')).toHaveLength(1)
  expect(events.find((e) => e.type === 'reply')).toEqual({ type: 'reply', text: 'Sure.', whole: true })
  expect(sock.sent.filter((m) => m.type === 'response.cancel')).toHaveLength(1)
})

test('a request the server turned down clears the pending cancel (the reply to your words still plays)', async () => {
  const { sock, events, live } = await setup(async () => 'Done.')
  live.announce('Ready.')
  sock.ws.serve({ type: 'input_audio_buffer.speech_started' })
  sock.ws.serve({ type: 'error', error: { message: 'conversation already has an active response' } })
  sock.ws.serve({ type: 'response.created' })
  expect(sock.sent.some((m) => m.type === 'response.cancel')).toBe(false)
  sock.ws.serve({ type: 'response.output_audio.delta', item_id: 'i1', delta: toPcm16Base64(new Float32Array(240)) })
  expect(events.some((e) => e.type === 'audio')).toBe(true)
})

test('the token request has a timeout: a hung server fails to start with a plain reason', async () => {
  let signal: AbortSignal | undefined
  const live = new GrokRealtime({
    apiKey: 'k', instructions: 'x', emit: () => undefined, doTask: async () => '', socket: fakeSocket().make,
    fetch: (async (_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    }) as never
  })
  await expect(live.start()).rejects.toThrow('Grok voice took too long to connect.')
  expect(signal).toBeInstanceOf(AbortSignal)
})

test('the caption: a whole live reply replaces the last one; streamed pieces join up after what you said', () => {
  expect(nextCaption('On it.', { text: 'Done, I emailed Priya.', whole: true })).toBe('Done, I emailed Priya.')
  expect(nextCaption('“email Priya”', { text: 'On it.', whole: true })).toBe('On it.')
  expect(nextCaption('“email Priya”', { text: 'Sure, ' })).toBe('Sure, ')
  expect(nextCaption('Sure, ', { text: 'done.' })).toBe('Sure, done.')
})

// ---- the service: a live call through VoiceService's hooks ----

let wsNow: FakeWs | null = null
function stubWs(): void {
  class WS {
    readyState = 0
    onopen: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    onclose: ((ev: unknown) => void) | null = null
    sent: Array<Record<string, unknown>> = []
    constructor() {
      wsNow = this as unknown as FakeWs
      setTimeout(() => { this.readyState = 1; this.onopen?.({}) }, 0)
    }
    send(d: string): void { this.sent.push(JSON.parse(d)) }
    close(): void { this.readyState = 3 }
    serve(e: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(e) }) }
  }
  vi.stubGlobal('WebSocket', WS)
}
afterEach(() => { vi.unstubAllGlobals(); wsNow = null })

function service(hooks: Partial<ConstructorParameters<typeof VoiceService>[0]>) {
  const events: Array<{ type: string; message?: string }> = []
  const s = new VoiceService({
    emit: (e) => events.push(e as never),
    respond: async () => undefined,
    output: () => ({ localOn: false, openai: null }),
    input: () => ({ local: false, choice: 'auto', hw: { appleSilicon: false, ramGB: 8 } }),
    ...hooks
  }, { modelsDir: mkdtempSync(join(tmpdir(), 'voice-live-')) })
  return { s, events }
}

test('a live call keeps what was said in the chat, and do_task gets the bot\'s final answer as real work', async () => {
  stubWs()
  vi.stubGlobal('fetch', okToken)
  const said: Array<[string, string]> = []
  const asked: Array<{ text: string; task?: boolean }> = []
  const { s } = service({
    live: () => ({ apiKey: 'k', baseUrl: 'https://api.x.ai/v1', instructions: 'x' }),
    spoken: (who, text) => said.push([who, text]),
    // Drafts streamed out, then the answer that stood.
    respond: async (text, _signal, onText, opts) => { asked.push({ text, task: opts?.task }); onText('draft one'); onText('draft two'); return 'I emailed Priya the notes.' }
  })
  try {
    await s.startVoice()
    const ws = wsNow!
    ws.serve({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'can you email priya the notes' })
    ws.serve({ type: 'response.created' })
    ws.serve({ type: 'response.output_audio_transcript.done', transcript: 'On it.' })
    ws.serve({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'do_task', arguments: JSON.stringify({ request: 'Email Priya the meeting notes' }) })
    ws.serve({ type: 'response.done' })
    await tick(); await tick()
    expect(said).toEqual([['user', 'can you email priya the notes'], ['assistant', 'On it.']])
    expect(asked).toEqual([{ text: 'Email Priya the meeting notes', task: true }])
    const out = (ws as unknown as { sent: Array<Record<string, unknown>> }).sent.find((m) => m.type === 'conversation.item.create') as { item: { output: string } }
    expect(out.item.output).toBe('I emailed Priya the notes.')
  } finally { s.dispose() }
})

test('a spending limit too close for a live call says so once, then the standard voice takes over', async () => {
  const { s, events } = service({ live: () => ({ skip: 'The spending limit is too close for a live Grok call.' }) })
  try {
    // No voice is set up in this test, so the standard chain then fails: the notice came first, with the reason.
    await s.startVoice().catch(() => undefined)
    expect(events.filter((e) => e.type === 'notice').map((e) => e.message)).toEqual(['The spending limit is too close for a live Grok call. Using the standard voice.'])
  } finally { s.dispose() }
})

test('do_task tells Grok a stopped or failed run as not done, never its draft', () => {
  expect(taskOutcome('stopped', 'I\'m drafting the email to Priya now')).toBe('The run was stopped before it finished. Don\'t say it was done.')
  expect(taskOutcome('error', 'Something went wrong', 'Gmail is not connected')).toMatch(/^The bot didn't finish: Gmail is not connected/)
  expect(taskOutcome('error', undefined)).toMatch(/it hit an error/)
  expect(taskOutcome('finished', 'I emailed Priya the notes.')).toBe('I emailed Priya the notes.')
  expect(taskOutcome('finished', '  ')).toBe('The bot finished but wrote no reply.')
})

test('a call that ends by itself lets go: an ended event, the service drops it, and announce says it did not speak', async () => {
  stubWs()
  vi.stubGlobal('fetch', okToken)
  const { s, events } = service({ live: () => ({ apiKey: 'k', baseUrl: 'https://api.x.ai/v1', instructions: 'x' }) })
  try {
    await s.startVoice()
    expect(s.announce('Your report is ready.')).toBe(true)
    // The server hangs up (or the idle timer or the spending limit ends it).
    wsNow?.onclose?.({})
    expect(events.map((e) => e.type)).toContain('ended')
    expect(events.find((e) => e.type === 'error')?.message).toBe('Grok voice disconnected.')
    expect(s.announce('Your report is ready.')).toBe(false)
  } finally { s.dispose() }
})

test('the idle hang-up ends the call with one ended event', async () => {
  let now = 1_000
  const sock = fakeSocket()
  const events: VoiceEvent[] = []
  const live = new GrokRealtime({ apiKey: 'k', instructions: 'x', emit: (e) => events.push(e), doTask: async () => '', socket: sock.make, fetch: okToken, now: () => now, idleMs: 60_000 })
  await live.start()
  now += 61_000
  live.minute()
  expect(live.isClosed).toBe(true)
  expect(events.filter((e) => e.type === 'ended')).toHaveLength(1)
  live.close()
  expect(events.filter((e) => e.type === 'ended')).toHaveLength(1)
})

test('talking over Grok: the server turning down our cancel or truncate is not shown as a notice', async () => {
  const { sock, events } = await setup(async () => 'Done.')
  sock.ws.serve({ type: 'response.created' })
  sock.ws.serve({ type: 'input_audio_buffer.speech_started' })
  sock.ws.serve({ type: 'error', error: { message: 'Cancellation failed: no active response found' } })
  sock.ws.serve({ type: 'error', error: { message: 'Audio content of 900ms is already shorter than 1200ms; cannot truncate' } })
  expect(events.some((e) => e.type === 'notice')).toBe(false)
  sock.ws.serve({ type: 'error', error: { message: 'Invalid voice' } })
  expect(events.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message)).toEqual(['Grok voice: Invalid voice'])
})

test('the voice bar language and Grok voice reach a live call: in the instructions, and mid-call by session.update', async () => {
  expect(grokVoiceInstructions({ botName: 'Ava', language: 'Spanish' })).toContain('Speak Spanish unless the user switches.')
  stubWs()
  vi.stubGlobal('fetch', okToken)
  const { s } = service({ live: () => ({ apiKey: 'k', baseUrl: 'https://api.x.ai/v1', instructions: 'x', voice: 'eve' }) })
  try {
    await s.startVoice()
    const sent = (wsNow as unknown as { sent: Array<Record<string, unknown>> }).sent
    s.updateLive({ instructions: 'x', voice: 'eve' })
    expect(sent.filter((m) => m.type === 'session.update')).toHaveLength(1)
    s.updateLive({ instructions: 'x\nSpeak French unless the user switches.', voice: 'rex' })
    expect(sent.filter((m) => m.type === 'session.update').at(-1)).toEqual({ type: 'session.update', session: { instructions: 'x\nSpeak French unless the user switches.', voice: 'rex' } })
  } finally { s.dispose() }
})
