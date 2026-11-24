import { expect, test, vi } from 'vitest'
import { GrokRealtime, GROK_VOICE_USD_PER_MIN, grokVoiceInstructions, toPcm16Base64, type RealtimeSocket } from '../../src/main/voice/grok-realtime'
import type { VoiceEvent } from '../../src/main/voice/pipeline'
vi.mock('../../src/renderer/src/api', () => ({ api: {}, isServerRuntime: false }))
import { setupError } from '../../src/renderer/src/components/VoiceMode'

// Grok Voice 3.0's turn-taking: one response at a time, talking over a reply, the per-minute charge and limit,
// and errors that don't break the bar.

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = []
  let ws!: RealtimeSocket & { serve(e: Record<string, unknown>): void }
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

async function setup(o: { doTask?: (req: string, signal: AbortSignal) => Promise<string>; guard?: (m: number) => void } = {}) {
  const sock = fakeSocket()
  const events: VoiceEvent[] = []
  const charged: number[] = []
  const clock = { now: 1_000_000 }
  const live = new GrokRealtime({
    apiKey: 'k', instructions: 'x', emit: (e) => events.push(e),
    doTask: o.doTask ?? (async () => 'Done.'), guard: o.guard,
    charge: (usd) => charged.push(usd), now: () => clock.now, socket: sock.make,
    fetch: (async () => new Response(JSON.stringify({ value: 't' }), { status: 200 })) as never
  })
  await live.start()
  return { sock, events, charged, clock, live }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

test('a tool result that arrives while Grok is talking waits for the reply to end: one response.create after done', async () => {
  const { sock, live } = await setup()
  sock.ws.serve({ type: 'response.created' })
  sock.ws.serve({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'do_task', arguments: JSON.stringify({ request: 'check the weather' }) })
  await tick()
  // Still talking: nothing goes out yet (the server would refuse a second active response).
  expect(sock.sent.filter((m) => m.type === 'conversation.item.create')).toHaveLength(0)
  expect(sock.sent.filter((m) => m.type === 'response.create')).toHaveLength(0)
  // Something to announce meanwhile waits too.
  live.announce('Your report is ready.')
  sock.ws.serve({ type: 'response.done' })
  expect(sock.sent.filter((m) => m.type === 'conversation.item.create')).toHaveLength(1)
  expect(sock.sent.filter((m) => m.type === 'response.create')).toEqual([{ type: 'response.create' }])
  // The announcement goes after the next reply, never on top of it.
  sock.ws.serve({ type: 'response.created' })
  expect(sock.sent.filter((m) => m.type === 'response.create')).toHaveLength(1)
  sock.ws.serve({ type: 'response.done' })
  expect(sock.sent.filter((m) => m.type === 'response.create')).toHaveLength(2)
  expect(sock.sent.at(-1)).toMatchObject({ response: { instructions: expect.stringContaining('Your report is ready.') } })
  live.close()
})

test('talking over a reply: the rest of its audio is dropped and Grok is told what was heard', async () => {
  const { sock, events, clock, live } = await setup()
  sock.ws.serve({ type: 'response.created' })
  sock.ws.serve({ type: 'response.output_audio.delta', item_id: 'it1', delta: toPcm16Base64(new Float32Array(24_000)) })
  clock.now += 400
  sock.ws.serve({ type: 'input_audio_buffer.speech_started' })
  expect(sock.sent.some((m) => m.type === 'response.cancel')).toBe(true)
  expect(sock.sent.find((m) => m.type === 'conversation.item.truncate')).toEqual({ type: 'conversation.item.truncate', item_id: 'it1', content_index: 0, audio_end_ms: 400 })
  const audioBefore = events.filter((e) => e.type === 'audio').length
  // Audio still in flight from the cut-off reply isn't played.
  sock.ws.serve({ type: 'response.output_audio.delta', item_id: 'it1', delta: toPcm16Base64(new Float32Array(2400)) })
  expect(events.filter((e) => e.type === 'audio').length).toBe(audioBefore)
  expect(events.at(-1)).toEqual({ type: 'state', state: 'hearing' })
  // The next reply plays again.
  sock.ws.serve({ type: 'response.done' })
  sock.ws.serve({ type: 'response.created' })
  sock.ws.serve({ type: 'response.output_audio.delta', item_id: 'it2', delta: toPcm16Base64(new Float32Array(2400)) })
  expect(events.filter((e) => e.type === 'audio').length).toBe(audioBefore + 1)
  live.close()
})

test('a server error is a passing notice, not the error state, and the conversation carries on', async () => {
  const { sock, events, live } = await setup()
  sock.ws.serve({ type: 'error', error: { message: 'Conversation already has an active response' } })
  expect(events.some((e) => e.type === 'error')).toBe(false)
  expect(events.at(-1)).toEqual({ type: 'notice', message: 'Grok voice: Conversation already has an active response' })
  live.close()
})

test('charged every minute as it goes, and the call ends when the spending limit is reached', async () => {
  let allow = true
  const { charged, clock, live, events } = await setup({ guard: () => { if (!allow) throw new Error('limit') } })
  clock.now += 60_000
  live.minute()
  expect(charged).toEqual([GROK_VOICE_USD_PER_MIN])
  clock.now += 30_000
  allow = false
  live.minute()
  // Ended: the half minute is charged at hang-up, and the user is told why.
  expect(charged).toHaveLength(2)
  expect(charged[1]).toBeCloseTo(0.5 * GROK_VOICE_USD_PER_MIN, 5)
  expect(events.some((e) => e.type === 'error' && /spending limit/.test(e.message))).toBe(true)
  expect(events.at(-1)).toEqual({ type: 'state', state: 'idle' })
})

test('a long silence hangs up; talking keeps it open', async () => {
  const { sock, clock, live, events } = await setup()
  clock.now += 4 * 60_000
  sock.ws.serve({ type: 'input_audio_buffer.speech_started' })
  clock.now += 2 * 60_000
  live.minute()
  expect(events.at(-1)?.type).not.toBe('error')
  clock.now += 4 * 60_000
  live.minute()
  expect(events.some((e) => e.type === 'error' && /quiet/.test(e.message))).toBe(true)
})

test('hanging up stops waiting for the bot, not the bot: its task is aborted with the reason "hangup"', async () => {
  let reason: unknown
  const { sock, live } = await setup({ doTask: (_req, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => { reason = signal.reason; resolve('') }) }) })
  sock.ws.serve({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'do_task', arguments: JSON.stringify({ request: 'write the report' }) })
  await tick()
  live.close()
  expect(reason).toBe('hangup')
})

test('the live voice knows which bot it is and what the bot is for', () => {
  const text = grokVoiceInstructions({ botName: 'Study Buddy', userName: 'Sahil', role: 'Homework help for chemistry' })
  expect(text).toContain('You are Study Buddy, talking with Sahil')
  expect(text).toContain('Homework help for chemistry')
})

test('the voice bar offers "Set up voice" only for setup problems; a dropped call offers Reconnect', () => {
  expect(setupError('Enable xAI and add its API key in Models & Keys to use Grok voice.')).toBe(true)
  expect(setupError('NotAllowedError: Permission denied')).toBe(true)
  expect(setupError('Grok voice disconnected.')).toBe(false)
  expect(setupError('Voice chat ended after a few quiet minutes.')).toBe(false)
})
