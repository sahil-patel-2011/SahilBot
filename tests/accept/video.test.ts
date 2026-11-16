import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startFakeHeygen, TINY_MP4 } from '../fixtures/fake-heygen-mcp'

// "Make a 30-second avatar video about our launch", end to end with a mock model and a local fake of
// HeyGen's MCP server (OAuth DCR + PKCE, the documented tool names): the request loads the video tool, its
// first call shows the one-click Connect card, the avatar video waits on an approval card with the credit
// estimate, the render-progress card shows while the fake renders, and the finished MP4 is saved into the
// workspace's videos/ folder and plays in the chat. Everything stays on 127.0.0.1; no credits, no HeyGen.

let llm: MockLlm
const names = (r: Record<string, any>): string[] => (r.tools ?? []).map((t: any) => t.function.name)
const lastTool = (r: Record<string, any>): string => String([...r.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '')
const SCRIPT = 'Big news: our new app is live today. It plans your week in seconds, learns what matters to you, and keeps every deadline in view. Teams in our beta saved five hours a week. Try it free for thirty days. Tap the link below and see what your week looks like when it finally fits.'

describe('HeyGen avatar video from a chat', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('connect (one click) → approval with the credit estimate → render progress → the video plays from videos/', async () => {
    const fake = await startFakeHeygen({ renderChecks: 5 })
    const { app, page } = await launch(tempProfile(), llm.url, {
      // A big enough window that intent loading lists the video tool up front (small windows use find_tools).
      FOREMAN_RAM_GB: '64',
      SAHILBOT_TEST_OAUTH_FETCH: '1',
      SAHILBOT_TEST_PRESETS: JSON.stringify([{ id: 'test-heygen', name: 'Fakegen Video', url: fake.url, description: 'A local stand-in for HeyGen.' }]),
      SAHILBOT_TEST_VIDEO_PRESETS: JSON.stringify({ heygen: 'test-heygen' }),
      SAHILBOT_TEST_VIDEO_LOOPBACK: '1'
    })
    try {
      // A workspace of the test's own (the default is the user's real ~/SahilBot).
      const ws = realpathSync(mkdtempSync(join(tmpdir(), 'video-ws-')))
      await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w } as never), ws)
      llm.script.push(
        // The request names an avatar video: the video tool is loaded before the first step.
        (req) => (names(req).includes('video') ? { toolCalls: [{ name: 'video', arguments: '{"action":"list_avatars"}' }] } : { content: `video not loaded: ${names(req).join(', ')}` }),
        (req) => (lastTool(req).includes('lk_anna_office')
          ? { toolCalls: [{ name: 'video', arguments: JSON.stringify({ action: 'create_avatar_video', script: SCRIPT, avatar: 'lk_anna_office', voice: 'v_anna', aspect: '16:9', captions: true, title: 'Launch announcement' }) }] }
          : { content: `unexpected: ${lastTool(req).slice(0, 300)}` }),
        (req) => ({ content: /Started the HeyGen video/.test(lastTool(req)) ? 'Your launch video is rendering. It will play here when HeyGen finishes.' : `unexpected: ${lastTool(req).slice(0, 300)}` })
      )
      await page.fill('[data-testid="composer-input"]', 'make a 30-second avatar video about our launch')
      await page.keyboard.press('Enter')

      // 1. Not connected yet: the in-chat Connect card, one click (OAuth against the local fake).
      const connect = page.locator('[data-testid="connect-card"]')
      await connect.waitFor({ timeout: 20_000 }).catch(async (e) => {
        console.log('[video debug]', await page.locator('main').innerText().catch(() => ''), JSON.stringify(llm.requests.map((r) => [names(r), lastTool(r).slice(0, 400)])))
        throw e
      })
      expect(await connect.innerText()).toContain('Fakegen Video')
      await connect.locator('[data-testid="connect-card-go"]').click()

      // 2. The video itself waits for approval, with the credit estimate on the card.
      const card = page.locator('[data-testid="approval-card"]')
      await card.waitFor({ timeout: 20_000 })
      const summary = await card.locator('[data-testid="approval-summary"]').innerText()
      expect(summary).toContain('"Launch announcement"')
      expect(summary).toMatch(/Uses about \d+ HeyGen credits/)
      expect(fake.log.calls.map((c) => c.name)).not.toContain('create_video_from_avatar')
      await card.locator('[data-testid="approve-once"]').click()

      // 3. The render-progress card while the fake renders.
      const progress = page.locator('[data-testid="video-card"][data-status="processing"]')
      await progress.first().waitFor({ timeout: 20_000 })
      expect(await progress.first().innerText()).toContain('Launch announcement')
      expect(fake.log.calls.find((c) => c.name === 'create_video_from_avatar')?.args).toMatchObject({ avatar_id: 'lk_anna_office', voice_id: 'v_anna', aspect_ratio: '16:9', caption: { file_format: 'srt', style: 'default' } })

      // 4. Done: saved into the workspace and playing inline from the app's own file scheme.
      const player = page.locator('[data-testid="video-player"]')
      await player.waitFor({ timeout: 30_000 })
      const src = await player.getAttribute('src')
      expect(src).toMatch(/^foreman-file:\/\/local\/.*\/videos\/launch-announcement\.mp4$/)
      await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
      expect(await player.evaluate((v: HTMLVideoElement) => Math.round(v.duration))).toBe(2)
      const file = join(ws, 'videos', 'launch-announcement.mp4')
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file).equals(TINY_MP4)).toBe(true)
      // The note carries the player and the file row; the progress card turned into a compact done line.
      const note = page.locator('[data-testid="video-card"][data-status="ready"]', { has: page.locator('[data-testid="video-player"]') })
      expect(await note.innerText()).toContain('launch-announcement.mp4')
      expect(await note.locator('[data-testid="video-reveal"]').count()).toBe(1)
      await expect.poll(() => page.locator('[data-testid="video-done"]').count(), { timeout: 10_000 }).toBe(1)
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 10_000 }).toContain('rendering')
    } finally {
      await app.close()
      await fake.close()
    }
  }, 150_000)
})
