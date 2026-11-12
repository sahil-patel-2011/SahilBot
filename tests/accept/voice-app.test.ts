import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { fromWav } from '../../src/main/voice/audio'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const MODELS = join(homedir(), 'Library/Application Support/Foreman/models')
const ready = existsSync(resolve('vendor/whisper.cpp/build/bin/whisper-server')) && existsSync(join(MODELS, 'silero_vad.onnx'))

describe.skipIf(!ready)('voice inside the app', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('voice mode hears speech, answers through the agent with the voice prompt and a 16k window, and speaks', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    const dir = mkdtempSync(join(tmpdir(), 'v-'))
    execFileSync('say', ['-o', join(dir, 'a.aiff'), 'Remind me what Foreman can do.'])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'a.aiff'), join(dir, 'a.wav')])
    const speech = Array.from(fromWav(readFileSync(join(dir, 'a.wav'))).samples)
    llm.script.push({ content: 'I can chat, browse, and handle your files. What do you need?' })
    await page.evaluate(() => {
      const w = window as unknown as { voiceLog: unknown[] }
      w.voiceLog = []
      window.foreman.voice.onEvent((e) => { w.voiceLog.push(e.type === 'audio' ? { type: 'audio' } : e) })
    })
    const spaces = await page.evaluate(() => window.foreman.spaces.list())
    const threadId = await page.evaluate((sid) => window.foreman.voice.start(null, sid), spaces[0].id)
    // Stream speech + silence like a microphone would (32 ms frames).
    await page.evaluate(async (s) => {
      const all = new Float32Array(s.length + 16000 * 2)
      all.set(s, 8000)
      for (let i = 0; i + 512 <= all.length; i += 512) {
        window.foreman.voice.frame(all.slice(i, i + 512))
        await new Promise((r) => setTimeout(r, 32))
      }
    }, speech)
    const log = () => page.evaluate(() => (window as unknown as { voiceLog: Array<{ type: string; text?: string }> }).voiceLog)
    await expect.poll(async () => (await log()).some((e) => e.type === 'audio'), { timeout: 30_000 }).toBe(true)
    const events = await log()
    expect((events.find((e) => e.type === 'transcript')?.text ?? '').toLowerCase()).toContain('foreman can do')
    const req = llm.requests.at(-1)!
    expect(String(req.messages[0].content)).toContain('# Voice mode')
    expect(req.options?.num_ctx).toBe(16384)
    // The conversation is saved as a normal thread.
    const msgs = await page.evaluate((id) => window.foreman.threads.messages(id), threadId)
    expect(msgs.filter((m) => m.role === 'user')[0].content.toLowerCase()).toContain('foreman can do')
    await page.evaluate(() => window.foreman.voice.stop())
    await app.close()
  }, 120_000)
})
