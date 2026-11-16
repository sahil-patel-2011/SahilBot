import { existsSync, mkdtempSync, readdirSync, writeFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))
import { BENCH_LIMIT_MS, WHISPER_MODELS, pickWhisper, whisperById, whisperUrl } from '../../src/main/voice/models'
import { NO_VOICE_INPUT, chooseStt } from '../../src/main/voice/stt'
import { VoiceService, type DownloadEvent } from '../../src/main/voice/service'

// Voice input is local by default: the Whisper model is picked for this Mac's memory and chip, downloads
// itself in the background (checked against the official SHA-256), and OpenAI (when allowed) or a short
// note covers the time until it's ready. Never a real download here.

describe('the model for this Mac', () => {
  test.each([
    ['Intel, 64 GB', { ramGB: 64, appleSilicon: false }, null, 'small-q5_1', 'fastest on this Mac'],
    ['Apple silicon, 8 GB', { ramGB: 8, appleSilicon: true }, null, 'small-q8_0', 'best for your Mac'],
    ['Apple silicon, 15.9 GB', { ramGB: 15.9, appleSilicon: true }, null, 'small-q8_0', 'best for your Mac'],
    ['Apple silicon, 16 GB, not timed yet', { ramGB: 16, appleSilicon: true }, null, 'large-v3-turbo-q5_0', 'best for your Mac'],
    ['M5 Pro, 24 GB, fast enough', { ramGB: 24, appleSilicon: true }, { model: 'large-v3-turbo-q5_0', ms: 640, at: 1 }, 'large-v3-turbo-q5_0', 'best for your Mac'],
    ['24 GB, too slow', { ramGB: 24, appleSilicon: true }, { model: 'large-v3-turbo-q5_0', ms: BENCH_LIMIT_MS + 1, at: 1 }, 'small-q8_0', 'fastest on this Mac'],
    ['24 GB, a benchmark of another model', { ramGB: 24, appleSilicon: true }, { model: 'small-q8_0', ms: 99_999, at: 1 }, 'large-v3-turbo-q5_0', 'best for your Mac'],
    ['32 GB', { ramGB: 32, appleSilicon: true }, null, 'large-v3-turbo-q8_0', 'best for your Mac'],
    ['M5 Max, 64 GB', { ramGB: 64, appleSilicon: true }, null, 'large-v3-turbo-q8_0', 'best for your Mac']
  ] as const)('%s', (_n, hw, bench, model, reason) => {
    const p = pickWhisper(hw, { bench: bench as never })
    expect(p.model.id).toBe(model)
    expect(p.reason).toBe(reason)
    expect(p.why.length).toBeGreaterThan(20)
  })

  test('only the 16–31 GB tier is timed, once', () => {
    expect(pickWhisper({ ramGB: 24, appleSilicon: true }).benchmark).toBe(true)
    expect(pickWhisper({ ramGB: 24, appleSilicon: true }, { bench: { model: 'large-v3-turbo-q5_0', ms: 500, at: 1 } }).benchmark).toBeUndefined()
    expect(pickWhisper({ ramGB: 64, appleSilicon: true }).benchmark).toBeUndefined()
    expect(pickWhisper({ ramGB: 8, appleSilicon: true }).benchmark).toBeUndefined()
  })

  test('a model pinned in Advanced wins', () => {
    expect(pickWhisper({ ramGB: 8, appleSilicon: true }, { choice: 'medium-q5_0' })).toMatchObject({ model: { id: 'medium-q5_0' }, reason: 'you chose it' })
    expect(pickWhisper({ ramGB: 8, appleSilicon: true }, { choice: 'nonsense' }).model.id).toBe('small-q8_0')
  })

  test('the catalog: official whisper.cpp files, quantized only, real sizes and SHA-256', () => {
    for (const m of WHISPER_MODELS) {
      expect(m.file).toMatch(/^ggml-(small|medium|large-v3-turbo)-q[58]_[01]\.bin$/)
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(whisperUrl(m)).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`)
    }
    expect(whisperById('large-v3-turbo-q5_0')?.bytes).toBe(574_041_195)
    expect(whisperById('large-v3-turbo-q8_0')?.bytes).toBe(874_188_075)
    expect(whisperById('small-q8_0')?.bytes).toBe(264_464_607)
  })
})

describe('which speech recognition voice input uses', () => {
  const base = { localOn: true, whisperReady: true, openaiKey: true, openaiAllowed: true }
  test('local first, whatever local models say; OpenAI until it is ready; else a note', () => {
    expect(chooseStt(base)).toEqual({ kind: 'whisper' })
    expect(chooseStt({ ...base, whisperReady: false })).toEqual({ kind: 'openai' })
    expect(chooseStt({ ...base, whisperReady: false, openaiAllowed: false, preparing: { label: 'Whisper large-v3-turbo', progress: 0.4 } }))
      .toEqual({ kind: 'none', note: 'Getting speech recognition ready on this Mac (Whisper large-v3-turbo, 40%). Try again in a minute.' })
    expect(chooseStt({ ...base, whisperReady: false, openaiKey: false, preparing: { label: 'Whisper small', error: 'offline' } })).toMatchObject({ kind: 'none', note: expect.stringMatching(/couldn't download \(offline\)/) })
    // "Transcribe on this Mac" off: OpenAI, or what's needed.
    expect(chooseStt({ ...base, localOn: false })).toEqual({ kind: 'openai' })
    expect(chooseStt({ ...base, localOn: false, openaiAllowed: false })).toEqual({ kind: 'none', note: NO_VOICE_INPUT })
  })
})

describe('the voice service', () => {
  const make = (o: { ramGB?: number; fetch?: typeof fetch; download?: 'real' | 'stub'; choice?: string } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-models-'))
    const events: DownloadEvent[] = []
    const svc = new VoiceService({
      emit: (e) => { if (e.type === 'download') events.push(e as DownloadEvent) },
      respond: async () => undefined,
      output: () => ({ localOn: false, openai: null }),
      input: () => ({ local: true, choice: o.choice ?? 'auto', hw: { ramGB: o.ramGB ?? 24, appleSilicon: true } })
    }, { modelsDir: dir, download: o.download ?? 'stub', fetch: o.fetch })
    return { svc, dir, events }
  }

  test('test runs: the picked Whisper model is reported as downloading and nothing is fetched or written', async () => {
    const { svc, dir, events } = make({ ramGB: 64 })
    await svc.prepare('auto')
    const st = svc.status()
    expect(st.speech).toMatchObject({ model: 'large-v3-turbo-q8_0', label: 'Whisper large-v3-turbo', reason: 'best for your Mac', state: 'downloading', ready: false, stub: true, requested: ['ggml-large-v3-turbo-q8_0.bin'] })
    expect(events).toEqual([expect.objectContaining({ kind: 'whisper', progress: 0, auto: true, model: 'large-v3-turbo-q8_0' })])
    expect(readdirSync(dir)).toEqual([])
    // Until it's ready, voice input says so (no OpenAI here).
    expect(st.input).toBe('none')
    expect(st.inputNote).toMatch(/Getting speech recognition ready on this Mac/)
  })

  test('a download that doesn\'t match the official checksum is thrown away, and the error is shown', async () => {
    const fake = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch
    const { svc, dir, events } = make({ ramGB: 8, download: 'real', fetch: fake })
    await svc.prepare('auto')
    expect(events.at(-1)).toMatchObject({ kind: 'whisper', error: expect.stringMatching(/official checksum/) })
    expect(svc.status().speech).toMatchObject({ state: 'error', model: 'small-q8_0' })
    expect(readdirSync(dir).filter((f) => f.endsWith('.bin') || f.endsWith('.part'))).toEqual([])
    // An automatic retry waits for the mic or the user; a click retries.
    let calls = 0
    const counting = (async () => { calls++; return new Response(new Uint8Array([1])) }) as unknown as typeof fetch
    const again = make({ ramGB: 8, download: 'real', fetch: counting })
    await again.svc.prepare('auto')
    await again.svc.prepare('auto')
    expect(calls).toBe(1)
    await again.svc.prepare('mic')
    expect(calls).toBe(2)
  })

  test('a model already on this Mac is used until the picked one is ready', () => {
    const { svc, dir } = make({ ramGB: 64 })
    const q5 = whisperById('large-v3-turbo-q5_0')!
    const f = join(dir, q5.file)
    writeFileSync(f, '')
    truncateSync(f, q5.bytes)
    const st = svc.status()
    expect(st.speech).toMatchObject({ model: 'large-v3-turbo-q8_0', ready: false, using: { model: 'large-v3-turbo-q5_0' } })
    expect(st.whisper).toBe(true)
    expect(existsSync(join(dir, 'ggml-large-v3-turbo-q8_0.bin'))).toBe(false)
  })
})
