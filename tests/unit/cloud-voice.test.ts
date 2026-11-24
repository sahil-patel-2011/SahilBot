import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { connectedVoice, nativeVoiceSite, voiceChoice, voicePreference } from '@shared/voice-provider'
import { toWav } from '../../src/main/voice/audio'
import { grokSpeech } from '../../src/main/voice/grok'
import { VoiceService } from '../../src/main/voice/service'
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))

test('Auto chooses a connected key, explicit choices and native web voices stay independent', () => {
  expect(voicePreference({ voiceOutput: { openai: true } })).toBe('openai')
  expect(connectedVoice('auto', { openai: false, xai: true })).toBe('xai')
  expect(connectedVoice('openai', { openai: false, xai: true })).toBeUndefined()
  expect(connectedVoice('chatgpt-app', { openai: true, xai: true })).toBeUndefined()
  expect(nativeVoiceSite('grok-app')).toBe('https://grok.com/')
  expect(nativeVoiceSite('chatgpt-app')).toBe('https://chatgpt.com/')
})

test('cloud-only hands-free speech sends one recording, responds in the current agent and plays the returned audio', async () => {
  const before = vi.fn(), after = vi.fn()
  const speech = grokSpeech({ credentials: () => ({ baseUrl: 'https://voice.test/v1', apiKey: 'fixture' }), before, after,
    fetch: async (url, init) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture' })
      if (String(url).endsWith('/stt')) {
        expect((init?.body as FormData).get('file')).toBeInstanceOf(Blob)
        return Response.json({ text: 'Review the Cursor change' })
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({ text: 'I will review the change.', output_format: { codec: 'wav' } })
      return Response.json({ audio: toWav(new Float32Array(320)).toString('base64') })
    }
  })
  const events: string[] = []
  const service = new VoiceService({
    emit: (e) => events.push(e.type),
    respond: async (transcript, _signal, reply) => { expect(transcript).toBe('Review the Cursor change'); reply('I will review the change. ') },
    output: () => ({ localOn: false, openai: null, xai: speech }),
    input: () => ({ local: false, choice: 'auto', hw: { appleSilicon: false, ramGB: 8 } })
  }, { modelsDir: mkdtempSync(join(tmpdir(), 'cloud-voice-')) })
  try {
    expect(service.status()).toMatchObject({ input: 'xai', output: 'xai', speech: { local: false, requested: [] } })
    await service.startVoice()
    for (let i = 0; i < 45; i++) service.frame(new Float32Array(512).fill(i < 22 ? 0.1 : 0))
    await expect.poll(() => events).toContain('audio')
    expect(before.mock.calls.map(([name]) => name)).toEqual(['grok-stt', 'grok-tts'])
    expect(after.mock.calls).toEqual(before.mock.calls)
  } finally { service.dispose() }
})

test('voice is one choice, Grok first: Auto uses Grok when its key is there; Claude opens its own voice mode', () => {
  expect(connectedVoice('auto', { openai: true, xai: true })).toBe('xai')
  expect(connectedVoice('auto', { openai: true, xai: false })).toBe('openai')
  expect(voiceChoice('auto', { openai: true, xai: true })).toBe('xai')
  expect(voiceChoice('auto', { openai: false, xai: false })).toBe('xai')
  expect(voiceChoice('auto', { openai: true, xai: false })).toBe('openai')
  expect(voiceChoice('claude-app', { openai: true, xai: true })).toBe('claude-app')
  expect(nativeVoiceSite('claude-app')).toBe('https://claude.ai/new')
  expect(connectedVoice('claude-app', { openai: true, xai: true })).toBeUndefined()
})
