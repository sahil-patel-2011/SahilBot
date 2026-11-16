import type { ElectronApplication } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Cloud first, local opt-in: first-run setup leads with cloud connections and asks one question about
// local models, with Not now as the default. Not now: no local model is installed, downloaded or offered.
// Voice is the one exception: speech recognition (Whisper) runs on this Mac by default.

let llm: MockLlm
const LOCAL_IPC = ['ollama:setup', 'ollama:installed', 'models:pull', 'models:setupPicks', 'detectProviders']

/** Counts calls to the local-model IPC (the handlers are swapped for counters: nothing really runs). */
async function countLocalIpc(app: ElectronApplication, passThrough: boolean): Promise<void> {
  await app.evaluate(({ ipcMain }, o) => {
    const g = globalThis as unknown as { __localCalls: string[] }
    g.__localCalls = []
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers
    for (const ch of o.channels) {
      const orig = handlers?.get(ch)
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, (e, ...a) => { g.__localCalls.push(ch); return o.passThrough && orig ? orig(e, ...a) : (ch === 'models:setupPicks' || ch === 'detectProviders' ? [] : undefined) })
    }
  }, { channels: LOCAL_IPC, passThrough })
}
const localCalls = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __localCalls: string[] }).__localCalls)

describe('cloud-first onboarding', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('declining local models: no Ollama or LLM download IPC, no download prompts (only the speech model downloads), and the choice is saved', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_SKIP_ONBOARDING: '', FOREMAN_RAM_GB: '64', FOREMAN_MODELS_DIR: mkdtempSync(join(tmpdir(), 'cf-models-')) })
    await countLocalIpc(app, false)
    await page.locator('[data-testid="onboarding"]').waitFor()
    await page.fill('[data-testid="onboarding-name"]', 'JP')
    await page.click('[data-testid="onboarding-name-next"]')

    // Cloud first: Claude, OpenAI, Grok keys and the ChatGPT plan; then the one local question.
    const cloud = await page.locator('[data-testid="onboarding-cloud"]').innerText()
    for (const t of ['Connect Claude (API key)', 'Connect OpenAI (API key)', 'Connect Grok (API key)', 'Use my ChatGPT plan (Codex)']) expect(cloud).toContain(t)
    expect(await page.locator('[data-testid="onboarding-local"]').innerText()).toContain('Also use free local models on this Mac?')
    expect(await page.getAttribute('[data-testid="onboarding-local-no"]', 'aria-checked')).toBe('true')
    // No local setup or download buttons until the user says yes.
    for (const sel of ['[data-testid="ollama-setup"]', '[data-testid="setup-picks"]', '[data-testid="local-setup"]', '[data-testid^="setup-get-"]']) expect(await page.locator(sel).count()).toBe(0)

    await page.click('[data-testid="onboarding-next"]')

    // The last step: Mac permissions and files anywhere.

    await page.click('[data-testid="onboarding-finish"]')
    await expect.poll(() => page.locator('[data-testid="onboarding"]').count()).toBe(0)

    const s = await page.evaluate(() => window.foreman.settings.get())
    expect(s.onboarded).toBe(true)
    expect(s.userName).toBe('JP')
    expect(s.local?.enabled).toBe(false)
    expect(await page.evaluate(() => window.foreman.local.status().then((x) => x.enabled))).toBe(false)

    // Settings → Models: a quiet "Local models: off" row, no download prompts.
    await page.keyboard.press('Meta+,')
    await page.click('[data-testid="settings-models"]')
    const row = page.locator('[data-testid="local-models-row"]')
    await row.waitFor()
    expect(await row.getAttribute('data-on')).toBe('0')
    expect(await row.innerText()).toContain('Local models: off')
    expect(await page.locator('[data-testid="local-turn-on"]').count()).toBe(1)
    for (const sel of ['[data-testid="recommended-row"]', '[data-testid^="pull-"]', '[data-testid="ollama-setup"]', '.install-ollama']) expect(await page.locator(sel).count()).toBe(0)
    // Settings → Voice: voice is the one exception to local opt-in. Speech recognition runs on this Mac by
    // default and downloads itself in the background after onboarding: the Whisper model picked for this
    // Mac (64 GB here: large-v3-turbo, 8-bit), never an LLM or Ollama. (Test runs only record the request.)
    await page.click('[data-testid="settings-voice"]')
    const speech = page.locator('[data-testid="voice-speech-model"]')
    await speech.waitFor()
    await expect.poll(() => speech.innerText()).toMatch(/Whisper large-v3-turbo · best for your Mac/)
    const st = await page.evaluate(() => window.foreman.voice.status())
    expect(st.speech).toMatchObject({ model: 'large-v3-turbo-q8_0', local: true, stub: true })
    expect(st.speech!.requested.length).toBeGreaterThan(0)
    for (const f of st.speech!.requested) expect(f).toMatch(/^(ggml-(small|medium|large-v3-turbo)-q[58]_[01]\.bin|silero_vad\.onnx)$/)
    // No Kokoro (a local voice) and no LLM download buttons.
    expect(await page.locator('.settings-page').innerText()).not.toMatch(/Kokoro-82M/)
    expect(await page.locator('.settings-page button', { hasText: /^Download$/ }).count()).toBe(0)
    // Until it's ready, dictation says so (no OpenAI key here); never a download prompt.
    const err = await page.evaluate(() => window.foreman.voice.dictateStart().then(() => '', (e: Error) => e.message))
    expect(err).toContain('Getting speech recognition ready on this Mac')
    expect(await page.evaluate(() => window.foreman.voice.download('whisper').then(() => 'ok', (e: Error) => e.message))).toBe('ok')
    expect(await page.evaluate(() => window.foreman.voice.download('kokoro').then(() => 'ok', (e: Error) => e.message))).toMatch(/Local voices are off/)
    await page.click('[data-testid="settings-close"]')
    // The model menu doesn't nudge toward downloads either.
    await page.click('[data-testid="model-picker"]')
    expect(await page.locator('.model-menu').innerText()).not.toMatch(/to download/)
    await page.keyboard.press('Escape')

    // Nothing local was asked for, from the first screen to here.
    expect(await localCalls(app)).toEqual([])
    await app.close()
  })

  test('saying yes runs the existing local setup (and saves local on)', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_SKIP_ONBOARDING: '' })
    await countLocalIpc(app, false)
    await page.locator('[data-testid="onboarding"]').waitFor()
    await page.click('[data-testid="onboarding-name-next"]')
    await page.click('[data-testid="onboarding-local-yes"]')
    expect(await localCalls(app)).toEqual([])
    await page.click('[data-testid="onboarding-next"]')
    await page.locator('[data-testid="local-setup"]').waitFor()
    await expect.poll(() => localCalls(app)).toEqual(expect.arrayContaining(['detectProviders', 'models:setupPicks']))
    expect((await page.evaluate(() => window.foreman.settings.get())).local?.enabled).toBe(true)
    await page.click('[data-testid="onboarding-local-next"]')
    // The last step: Mac permissions and files anywhere.
    await page.click('[data-testid="onboarding-finish"]')
    await expect.poll(() => page.locator('[data-testid="onboarding"]').count()).toBe(0)
    expect((await page.evaluate(() => window.foreman.settings.get())).local?.enabled).toBe(true)
    // Nothing was downloaded without a click.
    expect((await localCalls(app)).filter((c) => c === 'models:pull' || c === 'ollama:setup')).toEqual([])
    await app.close()
  })
})
