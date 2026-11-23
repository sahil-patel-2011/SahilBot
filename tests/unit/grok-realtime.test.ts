import { expect, test } from 'vitest'
import { GrokRealtime, GROK_VOICE_USD_PER_MIN, fromPcm16Base64, grokVoiceInstructions, toPcm16Base64, type RealtimeSocket } from '../../src/main/voice/grok-realtime'
import type { VoiceEvent } from '../../src/main/voice/pipeline'

// Grok Voice 3.0 (live speech to speech) against a stand-in for xAI's realtime socket: the token request, the
// session it sets up, audio both ways, barge-in, the bot doing the work through do_task, and the charge at the end.

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = []
  let ws!: RealtimeSocket & { serve(e: Record<string, unknown>): void; url: string; protocols: string[] }
  const make = (url: string, protocols: string[]) => {
    ws = {
      readyState: 0, url, protocols, onopen: null, onmessage: null, onerror: null, onclose: null,
      send: (d: string) => { sent.push(JSON.parse(d)) },
      close: () => { ws.readyState = 3 },
      serve: (e) => ws.onmessage?.({ data: JSON.stringify(e) })
    }
    setTimeout(() => { ws.readyState = 1; ws.onopen?.({}) }, 0)
    return ws
  }
  return { sent, make, get ws() { return ws } }
}

test('a live conversation: token, session, audio both ways, barge-in, work through the bot, and the charge', async () => {
  const sock = fakeSocket()
  const events: VoiceEvent[] = []
  const calls: string[] = []
  const charged: number[] = []
  let now = 1_000_000
  const tokenReq: Array<{ url: string; auth: string; body: string }> = []
  const live = new GrokRealtime({
    apiKey: 'xai-key', baseUrl: 'https://api.x.ai/v1', voice: 'ara',
    instructions: grokVoiceInstructions({ botName: 'Homework Helper', userName: 'Sahil' }),
    emit: (e) => events.push(e),
    doTask: async (req) => { calls.push(req); return 'Made 3 practice problems and saved them to Library.' },
    charge: (usd) => charged.push(usd),
    now: () => now,
    socket: sock.make,
    fetch: (async (url: string, init: RequestInit) => {
      tokenReq.push({ url, auth: String((init.headers as Record<string, string>).Authorization), body: String(init.body) })
      return new Response(JSON.stringify({ value: 'tok-123', expires_at: 1 }), { status: 200 })
    }) as never
  })
  await live.start()
  // The key only goes to the token endpoint; the socket gets the short-lived token, and the model is Grok Voice 3.0.
  expect(tokenReq[0]).toMatchObject({ url: 'https://api.x.ai/v1/realtime/client_secrets', auth: 'Bearer xai-key' })
  expect(sock.ws.url).toBe('wss://api.x.ai/v1/realtime?model=grok-voice-3.0')
  expect(sock.ws.protocols).toEqual(['xai-client-secret.tok-123'])
  const session = sock.sent[0] as { type: string; session: Record<string, any> }
  expect(session.type).toBe('session.update')
  expect(session.session).toMatchObject({ voice: 'ara', turn_detection: { type: 'server_vad' }, audio: { input: { format: { type: 'audio/pcm', rate: 16000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } } })
  expect(session.session.tools[0].name).toBe('do_task')
  expect(session.session.instructions).toContain('You are Homework Helper, talking with Sahil')

  // Microphone frames go up as PCM16.
  live.pushAudio(new Float32Array([0, 0.5, -0.5]))
  const append = sock.sent.at(-1) as { type: string; audio: string }
  expect(append.type).toBe('input_audio_buffer.append')
  expect(Array.from(fromPcm16Base64(append.audio)).map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.5, -0.5])

  // You speak; Grok transcribes, then answers out loud.
  sock.ws.serve({ type: 'input_audio_buffer.speech_started' })
  sock.ws.serve({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'make me three practice problems' })
  sock.ws.serve({ type: 'response.created' })
  sock.ws.serve({ type: 'response.output_audio.delta', delta: toPcm16Base64(new Float32Array(240)) })
  sock.ws.serve({ type: 'response.output_audio_transcript.done', transcript: 'On it.' })
  expect(events.some((e) => e.type === 'transcript' && e.text === 'make me three practice problems')).toBe(true)
  expect(events.find((e) => e.type === 'audio')).toMatchObject({ rate: 24000 })
  expect(events.some((e) => e.type === 'reply' && e.text === 'On it.')).toBe(true)

  // Talking over it stops it (barge-in).
  sock.ws.serve({ type: 'input_audio_buffer.speech_started' })
  expect(events.at(-2)).toEqual({ type: 'stop-audio' })
  expect(sock.sent.some((m) => m.type === 'response.cancel')).toBe(true)

  // Grok hands the work to the bot; the result goes back and Grok answers again.
  sock.ws.serve({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'do_task', arguments: JSON.stringify({ request: 'Make three practice problems on balancing equations' }) })
  await new Promise((r) => setTimeout(r, 0))
  expect(calls).toEqual(['Make three practice problems on balancing equations'])
  const out = sock.sent.find((m) => m.type === 'conversation.item.create') as { item: { type: string; call_id: string; output: string } }
  expect(out.item).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'Made 3 practice problems and saved them to Library.' })
  expect(sock.sent.at(-1)).toEqual({ type: 'response.create' })

  // Something to say between turns waits for the current reply to finish.
  live.announce('Your report is ready.')
  expect(sock.sent.filter((m) => m.type === 'response.create' && m.response)).toHaveLength(0)
  sock.ws.serve({ type: 'response.done' })
  expect(sock.sent.at(-1)).toMatchObject({ type: 'response.create', response: { instructions: expect.stringContaining('Your report is ready.') } })

  // Ending: charged by the minute.
  now += 90_000
  live.close()
  expect(charged).toHaveLength(1)
  expect(charged[0]).toBeCloseTo(1.5 * GROK_VOICE_USD_PER_MIN, 5)
  expect(events.at(-1)).toEqual({ type: 'state', state: 'idle' })
})

test('a rejected key fails to start with a plain reason (the standard voice then takes over)', async () => {
  const live = new GrokRealtime({
    apiKey: 'bad', instructions: 'x', emit: () => undefined, doTask: async () => '',
    fetch: (async () => new Response('{}', { status: 401 })) as never, socket: fakeSocket().make
  })
  await expect(live.start()).rejects.toThrow(/couldn't start \(401\).*xAI key/)
})
