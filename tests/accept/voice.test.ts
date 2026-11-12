import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { FRAME, fromWav } from '../../src/main/voice/audio'
import { VoicePipeline, type VoiceEvent } from '../../src/main/voice/pipeline'
import { KokoroEngine } from '../../src/main/voice/tts'
import { SileroVad } from '../../src/main/voice/vad'
import { WhisperServer } from '../../src/main/voice/whisper'
import { streamChat } from '../../src/main/llm/client'
import { VOICE_SUFFIX } from '../../src/main/agent/prompt'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const MODELS = join(homedir(), 'Library/Application Support/Foreman/models')
const BIN = resolve('vendor/whisper.cpp/build/bin/whisper-server')
const ready = existsSync(BIN) && existsSync(join(MODELS, 'ggml-large-v3-turbo-q5_0.bin')) && existsSync(join(MODELS, 'silero_vad.onnx'))

function speech(text: string): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'))
  execFileSync('say', ['-o', join(dir, 'a.aiff'), text])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'a.aiff'), join(dir, 'a.wav')])
  return fromWav(readFileSync(join(dir, 'a.wav'))).samples
}

/** Feeds audio frame by frame at real-time pace, like a microphone. */
async function play(p: VoicePipeline, samples: Float32Array, silenceMs = 0): Promise<void> {
  const all = new Float32Array(samples.length + Math.round((silenceMs / 1000) * 16000))
  all.set(samples)
  const start = performance.now()
  for (let i = 0, n = 0; i + FRAME <= all.length; i += FRAME, n++) {
    const due = start + n * 32
    const wait = due - performance.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    void p.feed(all.slice(i, i + FRAME))
  }
}

// Phase 5 acceptance: end of speech -> first audio under 1.5 s, voice mode on a 16k window.
describe.skipIf(!ready)('phase 5: voice', () => {
  let llm: MockLlm
  let whisper: WhisperServer
  let vad: SileroVad
  let tts: KokoroEngine

  beforeAll(async () => {
    llm = await startMockLlm()
    whisper = new WhisperServer(BIN, join(MODELS, 'ggml-large-v3-turbo-q5_0.bin'))
    vad = await SileroVad.load(join(MODELS, 'silero_vad.onnx'))
    tts = new KokoroEngine(join(MODELS, 'hf'))
    await Promise.all([whisper.start(), tts.warm()])
  }, 180_000)
  afterAll(async () => {
    whisper?.stop()
    await llm?.close()
  })

  const pipeline = (events: VoiceEvent[]) => new VoicePipeline({
    vad, whisper, tts,
    emit: (e) => events.push(e),
    async respond(text, signal, onText) {
      for await (const part of streamChat({
        baseUrl: llm.url, model: 'qwen3.8:27b', maxTokens: 400, contextWindow: 16384, signal,
        sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 },
        messages: [{ role: 'system', content: `You are Foreman.${VOICE_SUFFIX}` }, { role: 'user', content: text }]
      })) if (part.type === 'content') onText(part.text)
    }
  })

  test('first audio arrives within 1.5 s of the end of speech', async () => {
    const results: number[] = []
    for (let run = 0; run < 3; run++) {
      const events: VoiceEvent[] = []
      const p = pipeline(events)
      vad.reset()
      llm.script.push({ content: 'Sure. You have two meetings tomorrow afternoon, one at two and one at four.', delay: 12 })
      await play(p, new Float32Array(8000))
      await play(p, speech("What's on my calendar tomorrow afternoon?"), 1600)
      await expect.poll(() => events.some((e) => e.type === 'audio'), { timeout: 10_000 }).toBe(true)
      const transcript = events.find((e) => e.type === 'transcript') as { text: string }
      expect(transcript.text.toLowerCase()).toContain('calendar tomorrow afternoon')
      const ms = (events.find((e) => e.type === 'metric' && e.name === 'first_audio_ms') as { ms: number }).ms
      results.push(ms)
      // The model was asked with the voice prompt and a 16k window.
      const req = llm.requests.at(-1)!
      expect(req.options?.num_ctx ?? 16384).toBe(16384)
      expect(String(req.messages[0].content)).toContain('speaking out loud')
      await expect.poll(() => events.filter((e) => e.type === 'state').at(-1), { timeout: 15_000 }).toEqual({ type: 'state', state: 'listening' })
    }
    process.stderr.write(`VOICE_LATENCY_MS ${results.map(Math.round).join(', ')}\n`)
    expect(Math.max(...results)).toBeLessThan(1500)
  }, 120_000)

  test('barge-in: speaking over the reply stops audio and cancels generation', async () => {
    const events: VoiceEvent[] = []
    const p = pipeline(events)
    vad.reset()
    llm.script.push({ content: Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1} of a long answer.`).join(' '), delay: 25 })
    await play(p, speech('Tell me a long story.'), 1200)
    await expect.poll(() => events.some((e) => e.type === 'audio'), { timeout: 10_000 }).toBe(true)
    const before = events.filter((e) => e.type === 'audio').length
    await play(p, speech('Stop, wait a second.'), 900)
    await expect.poll(() => events.some((e) => e.type === 'stop-audio'), { timeout: 5_000 }).toBe(true)
    await new Promise((r) => setTimeout(r, 1500))
    // After barge-in, the long answer stops producing audio (the new utterance gets its own reply).
    const transcripts = events.filter((e) => e.type === 'transcript').map((e) => (e as { text: string }).text.toLowerCase())
    expect(transcripts.some((t) => t.includes('stop'))).toBe(true)
    expect(events.filter((e) => e.type === 'audio').length).toBeLessThan(before + 10)
  }, 60_000)
})
