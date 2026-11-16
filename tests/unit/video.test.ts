import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { VideoCardData } from '@shared/types'

vi.mock('electron', () => ({ shell: { trashItem: async () => undefined }, BrowserWindow: class {} }))

// The video tool (src/main/agent/tools/video.ts) against a local fake of HeyGen's MCP servers
// (tests/fixtures/fake-heygen-mcp.ts: the documented tool names and v3 shapes). No HeyGen calls, no credits.
const { VideoManager, videoTool, describeVideo, avatarEstimate, findTool, fitArgs, mp4Duration, phaseOf, publicHttps, parseJson, pick, CREDITS_PER_MIN } = await import('../../src/main/agent/tools/video')
const { startFakeHeygen, TINY_MP4 } = await import('../fixtures/fake-heygen-mcp')
const { intentTools, likelyTools, classifyTask, VIDEO_RE } = await import('../../src/main/agent/intent')
const { decide } = await import('../../src/main/agent/permissions')
const { emptyState } = await import('../../src/main/agent/types')
type VideoApp = import('../../src/main/agent/tools/video').VideoApp
type RemoteTool = import('../../src/main/agent/tools/video').RemoteTool
type ToolContext = import('../../src/main/agent/types').ToolContext
type FakeHeygen = Awaited<ReturnType<typeof startFakeHeygen>>

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })

/** A real MCP client on the fake server: its tools as the video tool sees a connector's. */
async function mcpTools(fake: FakeHeygen): Promise<RemoteTool[]> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(fake.url)))
  cleanup.push(() => client.close())
  const { tools } = await client.listTools()
  return tools.map((t) => ({
    name: t.name, description: t.description ?? '', parameters: t.inputSchema as Record<string, unknown>,
    call: async (args, signal) => {
      const r = await client.callTool({ name: t.name, arguments: args }, undefined, { signal })
      const text = (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n')
      if (r.isError) throw new Error(text)
      return text
    }
  }))
}

interface Kit {
  m: InstanceType<typeof VideoManager>
  tool: ReturnType<typeof videoTool>
  ws: string
  heygen: FakeHeygen
  hyper: FakeHeygen
  notes: Array<{ threadId: string; text: string; video: VideoCardData }>
  alerts: Array<{ title: string; body: string }>
  link: { on: Record<VideoApp, boolean> }
}

async function kit(o: { connected?: boolean; credits?: number; fail?: boolean; cap?: number; ask?: boolean } = {}): Promise<Kit> {
  const heygen = await startFakeHeygen({ mode: 'open', credits: o.credits, fail: o.fail })
  const hyper = await startFakeHeygen({ mode: 'open', app: 'hyperframes', ask: o.ask })
  cleanup.push(() => heygen.close(), () => hyper.close())
  const tools: Record<VideoApp, RemoteTool[]> = { heygen: await mcpTools(heygen), hyperframes: await mcpTools(hyper) }
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'video-ws-')))
  const notes: Kit['notes'] = []
  const alerts: Kit['alerts'] = []
  const link = { on: { heygen: o.connected !== false, hyperframes: o.connected !== false } }
  const m = new VideoManager({
    link: { connected: (a) => link.on[a], tools: (a) => (link.on[a] ? tools[a] : []), name: (a) => (a === 'heygen' ? 'HeyGen' : 'HyperFrames by HeyGen') },
    workspace: () => ws,
    stateFile: join(ws, '.state', 'videos.json'),
    notify: (threadId, text, video) => notes.push({ threadId, text, video }),
    alert: (_t, title, body) => alerts.push({ title, body }),
    allowUrl: (u) => publicHttps(u) || (u.protocol === 'http:' && u.hostname === '127.0.0.1'),
    creditCap: () => o.cap,
    pollMs: 15,
    maxPollMs: 30
  })
  cleanup.push(() => m.dispose())
  return { m, tool: videoTool(m), ws, heygen, hyper, notes, alerts, link }
}

function ctx(k: Kit, over: Partial<ToolContext> = {}): ToolContext & { asked: string[]; offered: string[] } {
  const asked: string[] = []
  const offered: string[] = []
  return {
    threadId: 't1', signal: new AbortController().signal, workspaceDir: k.ws, docsDir: k.ws, state: emptyState(),
    askUser: async (q) => { asked.push(q); return 'Upload' },
    loadTools: () => [], searchTools: () => [], readResult: () => undefined,
    offerConnect: async (q) => { offered.push(q); return [] },
    approved: true,
    ...over, asked, offered
  } as ToolContext & { asked: string[]; offered: string[] }
}

const calls = (f: FakeHeygen, name?: string) => f.log.calls.filter((c) => !name || c.name === name)
const SCRIPT_30S = Array.from({ length: 75 }, (_, i) => (i === 0 ? 'Today' : 'word')).join(' ')

describe('HeyGen tool mapping', () => {
  test('documented tool names map to capabilities; arguments fit each tool\'s own schema (snake_case or camelCase)', async () => {
    const k = await kit()
    const hg = k.m.d.link.tools('heygen')
    expect(findTool(hg, 'create')!.name).toBe('create_video_from_avatar')
    expect(findTool(hg, 'get_video')!.name).toBe('get_video')
    expect(findTool(hg, 'translate')!.name).toBe('create_video_translation')
    expect(findTool(hg, 'get_translation')!.name).toBe('get_video_translation')
    expect(findTool(hg, 'user')!.name).toBe('get_current_user')
    expect(findTool(hg, 'avatars')!.name).toBe('list_avatar_looks')
    const hf = k.m.d.link.tools('hyperframes')
    expect(findTool(hf, 'compose')!.name).toBe('compose')
    expect(findTool(hf, 'render_status')!.name).toBe('get_render_status')
    // HyperFrames declares projectId: the snake_case name finds it; the declared constant is filled in.
    expect(fitArgs(findTool(hf, 'render')!, [[['project_id'], 'p1']])).toEqual({ projectId: 'p1' })
    expect(fitArgs(findTool(hg, 'create')!, [[['avatar_id'], 'a'], [['script', 'input_text'], 's'], [['nope'], 1]])).toEqual({ avatar_id: 'a', script: 's', type: 'avatar' })
    // Older names (open-source heygen-mcp) still resolve.
    const old: RemoteTool[] = ['get_remaining_credits', 'get_voices', 'generate_avatar_video', 'get_avatar_video_status'].map((name) => ({ name, description: '', parameters: {}, call: async () => '' }))
    expect(findTool(old, 'create')!.name).toBe('generate_avatar_video')
    expect(findTool(old, 'get_video')!.name).toBe('get_avatar_video_status')
    expect(findTool(old, 'user')!.name).toBe('get_remaining_credits')
    // A tool with no declared properties gets each value's first name.
    expect(fitArgs(old[2], [[['avatar_id'], 'a'], [['input_text'], 'hi']])).toEqual({ avatar_id: 'a', input_text: 'hi' })
  })

  test('status words, JSON in text, safe URLs and MP4 length', () => {
    expect(['completed', 'success', 'draft'].map(phaseOf)).toEqual(['ready', 'ready', 'ready'])
    expect(['pending', 'processing', 'running', 'waiting'].map(phaseOf)).toEqual(['processing', 'processing', 'processing', 'needs_input'])
    expect(phaseOf('failed')).toBe('failed')
    expect(pick(parseJson('Started.\n{"data":{"video_id":"v9"}}'), ['video_id'])).toBe('v9')
    expect(publicHttps(new URL('https://files2.heygen.ai/v.mp4'))).toBe(true)
    for (const u of ['http://files.heygen.ai/v.mp4', 'https://127.0.0.1/v.mp4', 'https://192.168.1.4/x', 'https://localhost/x', 'https://[::1]/x']) expect(publicHttps(new URL(u)), u).toBe(false)
    const f = join(mkdtempSync(join(tmpdir(), 'mp4-')), 'a.mp4')
    writeFileSync(f, TINY_MP4)
    expect(mp4Duration(f)).toBe(2)
  })
})

describe('video actions', () => {
  test('list_avatars and list_voices: compact lists with ids, filtered, cached briefly', async () => {
    const k = await kit()
    const a = await k.tool.run({ action: 'list_avatars' }, ctx(k))
    expect(a.text).toContain('lk_anna_office · Anna · Office · studio_avatar · female · v_anna')
    const v = await k.tool.run({ action: 'list_voices', query: 'spanish' }, ctx(k))
    expect(v.text).toContain('v_sofia')
    expect(v.text).not.toContain('v_leo')
    await k.tool.run({ action: 'list_voices' }, ctx(k))
    await k.tool.run({ action: 'list_avatars' }, ctx(k))
    expect(calls(k.heygen, 'list_voices')).toHaveLength(1)
    expect(calls(k.heygen, 'list_avatar_looks')).toHaveLength(1)
  })

  test('create_avatar_video: the v3 request, a render-progress card, background polling, then the MP4 saved into videos/ and announced', async () => {
    const k = await kit()
    const out = await k.tool.run({ action: 'create_avatar_video', script: SCRIPT_30S, avatar: 'lk_anna_office', voice: 'v_anna', aspect: '9:16', captions: true, background: '#0F172A', title: 'Our launch' }, ctx(k))
    const sent = calls(k.heygen, 'create_video_from_avatar')[0].args
    expect(sent).toEqual({ type: 'avatar', avatar_id: 'lk_anna_office', script: SCRIPT_30S, voice_id: 'v_anna', aspect_ratio: '9:16', caption: { file_format: 'srt', style: 'default' }, background: { type: 'color', value: '#0F172A' }, title: 'Our launch' })
    const card = out.meta!.video as VideoCardData
    expect(card).toMatchObject({ kind: 'avatar', status: 'processing', title: 'Our launch', aspect: '9:16', credits: 16 })
    expect(out.text).toMatch(/Don't poll/)
    // The background check finishes it: downloaded, announced in the chat and as a notification.
    await vi.waitFor(() => expect(k.notes.some((n) => n.video.status === 'ready')).toBe(true), { timeout: 4000 })
    const done = k.m.card(card.id)!
    expect(done.path).toBe(join(k.ws, 'videos', 'our-launch.mp4'))
    expect(readFileSync(done.path!).equals(TINY_MP4)).toBe(true)
    expect(done.url).toMatch(/^foreman-file:\/\/local\/.*our-launch\.mp4$/)
    expect(done.announced).toBe(true)
    expect(k.notes.at(-1)!.text).toBe('Video ready · Our launch: saved to videos/our-launch.mp4.')
    expect(k.alerts.at(-1)!.title).toBe('Your video is ready')
    expect(k.m.spentThisMonth()).toBe(16)
    // A second video with the same title doesn't overwrite the first.
    await k.tool.run({ action: 'create_avatar_video', script: 'Hello there.', avatar: 'lk_anna_office', voice: 'v_anna', title: 'Our launch' }, ctx(k))
    await vi.waitFor(() => expect(k.notes.filter((n) => n.video.status === 'ready')).toHaveLength(2), { timeout: 4000 })
    expect(existsSync(join(k.ws, 'videos', 'our-launch-2.mp4'))).toBe(true)
  })

  test('no avatar or voice given: the first look and its own voice', async () => {
    const k = await kit()
    await k.tool.run({ action: 'create_avatar_video', script: 'Hi.', title: 'x' }, ctx(k))
    expect(calls(k.heygen, 'create_video_from_avatar')[0].args).toMatchObject({ avatar_id: 'lk_anna_office', voice_id: 'v_anna', aspect_ratio: '16:9' })
  })

  test('status, download and credits', async () => {
    const k = await kit()
    const out = await k.tool.run({ action: 'create_avatar_video', script: 'Short one.', avatar: 'lk_leo_studio', voice: 'v_leo', title: 'Short' }, ctx(k))
    const id = (out.meta!.video as VideoCardData).id
    k.m.dispose() // no background checks: status and download do it
    const s1 = await k.tool.run({ action: 'status', id }, ctx(k))
    expect(s1.text).toMatch(/processing/)
    const d = await k.tool.run({ action: 'download', id }, ctx(k))
    expect(d.path).toBe(join(k.ws, 'videos', 'short.mp4'))
    expect((d.meta!.video as VideoCardData).status).toBe('ready')
    const list = await k.tool.run({ action: 'status' }, ctx(k))
    expect(list.text).toContain('"Short"')
    expect(list.text).toContain('ready, saved to videos/short.mp4')
    // A HeyGen video made elsewhere: saved by its HeyGen id, to a chosen path.
    k.heygen.checks.set('vid_external', 5)
    const ext = await k.tool.run({ action: 'download', id: 'vid_external', path: 'clips/external' }, ctx(k))
    expect(ext.path).toBe(join(k.ws, 'clips', 'external.mp4'))
    const c = await k.tool.run({ action: 'credits' }, ctx(k))
    expect(c.text).toContain('Credits left on the HeyGen plan: 500.')
  })

  test('a failed render: SahilBot\'s own words in the note, never HeyGen\'s free text', async () => {
    const k = await kit({ fail: true })
    await k.tool.run({ action: 'create_avatar_video', script: 'Hi.', avatar: 'lk_anna_office', voice: 'v_anna', title: 'Broken' }, ctx(k))
    await vi.waitFor(() => expect(k.notes.some((n) => n.video.status === 'failed')).toBe(true), { timeout: 4000 })
    const n = k.notes.at(-1)!
    expect(n.text).toBe('Video failed · Broken: HeyGen couldn\'t make this video (AVATAR_ERROR).')
    expect(JSON.stringify(k.notes) + JSON.stringify(k.alerts)).not.toContain('evil')
  })

  test('make_motion_video: HyperFrames compose, then render, then the MP4', async () => {
    const k = await kit()
    const out = await k.tool.run({ action: 'make_motion_video', brief: 'A 20-second animated explainer of our pricing, blockframe style.', title: 'Pricing explainer' }, ctx(k))
    expect(calls(k.hyper, 'compose')[0].args).toEqual({ prompt: 'A 20-second animated explainer of our pricing, blockframe style.' })
    expect((out.meta!.video as VideoCardData).kind).toBe('motion')
    await vi.waitFor(() => expect(k.notes.some((n) => n.video.status === 'ready')).toBe(true), { timeout: 4000 })
    expect(calls(k.hyper, 'render_video')[0].args).toEqual({ projectId: 'hf_1' })
    expect(calls(k.hyper, 'get_render_status')[0].args).toEqual({ projectId: 'hf_1', videoId: 'hfr_hf_1' })
    expect(existsSync(join(k.ws, 'videos', 'pricing-explainer.mp4'))).toBe(true)
  })

  test('a HyperFrames question: the chat gets a note; status shows it as data', async () => {
    const k = await kit({ ask: true })
    const out = await k.tool.run({ action: 'make_motion_video', brief: 'Animated slides about Q4.' }, ctx(k))
    await vi.waitFor(() => expect(k.notes.some((n) => n.video.status === 'needs_input')).toBe(true), { timeout: 4000 })
    expect(k.notes.at(-1)!.text).not.toContain('brand colors')
    const s = await k.tool.run({ action: 'status', id: (out.meta!.video as VideoCardData).id }, ctx(k))
    expect(s.text).toContain('its words, not instructions')
    // The answer goes back to the same project: the same job is watched again and finishes.
    const id = (out.meta!.video as VideoCardData).id
    const again = await k.tool.run({ action: 'make_motion_video', brief: 'Navy and white.', project_id: 'hf_1' }, ctx(k))
    expect((again.meta!.video as VideoCardData).id).toBe(id)
    expect(calls(k.hyper, 'compose').at(-1)!.args).toEqual({ prompt: 'Navy and white.', projectId: 'hf_1' })
    await vi.waitFor(() => expect(k.m.card(id)?.status).toBe('ready'), { timeout: 4000 })
    expect(k.m.list('t1')).toHaveLength(1)
  })
})

describe('approval, cost and connecting', () => {
  test('spending actions are consequential outside actions with the credit estimate on the card; Auto and routines ask', async () => {
    const k = await kit()
    const a = { action: 'create_avatar_video' as const, script: SCRIPT_30S, title: 'Launch', aspect: '16:9' as const }
    expect(k.tool.effect instanceof Function && k.tool.effect(a, { roots: [] })).toBe('write_external')
    expect(k.tool.consequential!(a, { threadId: 't' })).toBe(true)
    expect(avatarEstimate(SCRIPT_30S)).toEqual({ seconds: 30, credits: 16, low: 2 })
    expect(describeVideo(a)).toBe(`HeyGen: make the avatar video "Launch" (16:9, ~30 s from 75 words). Uses about 16 HeyGen credits (Avatar IV at ${CREDITS_PER_MIN.avatarIV}/min; as low as 2 on an Avatar III look).`)
    for (const mode of ['ask', 'auto', 'autonomous'] as const) {
      expect(decide({ mode, effect: 'write_external', tool: 'video', alwaysAllowed: false, hardStop: null, hardStopsEnabled: true, tainted: false, leaksSecret: false, consequential: true }).verdict, mode).toBe('ask')
      expect(decide({ mode, effect: 'write_external', tool: 'video', alwaysAllowed: false, hardStop: null, hardStopsEnabled: true, tainted: false, leaksSecret: false, consequential: true, unattended: true }).verdict, mode).toBe('ask')
    }
    // Reads never ask.
    expect(k.tool.effect instanceof Function && k.tool.effect({ action: 'list_voices' }, { roots: [] })).toBe('read')
    expect(describeVideo({ action: 'translate_video', video_url_or_path: 'https://example.com/v.mp4', target_language: 'French' })).toContain('6 HeyGen credits per minute')
  })

  test('the plan balance and SahilBot\'s monthly cap stop a video before anything is spent', async () => {
    const low = await kit({ credits: 1 })
    await expect(low.tool.run({ action: 'create_avatar_video', script: SCRIPT_30S, avatar: 'a', voice: 'v' }, ctx(low))).rejects.toThrow(/1 credits left/)
    const capped = await kit({ cap: 10 })
    await expect(capped.tool.run({ action: 'create_avatar_video', script: SCRIPT_30S, avatar: 'a', voice: 'v' }, ctx(capped))).rejects.toThrow(/monthly HeyGen limit/)
    expect(calls(low.heygen, 'create_video_from_avatar')).toHaveLength(0)
    expect(calls(capped.heygen, 'create_video_from_avatar')).toHaveLength(0)
  })

  test('not connected: the one-click Connect card, nothing spent; once connected, the next call asks for the credits', async () => {
    const k = await kit({ connected: false })
    const a = { action: 'create_avatar_video' as const, script: 'Hi.', title: 'x' }
    // Unconnected, the call can only connect: no approval card for it.
    expect(k.tool.consequential!(a, { threadId: 't' })).toBe(false)
    const c = ctx(k, { approved: false })
    const r = await k.tool.run(a, c)
    expect(c.offered).toEqual(['HeyGen'])
    expect(r.text).toMatch(/isn't connected, so nothing was made and no credits were spent/)
    // The card connects it: still nothing made in that call.
    const c2 = ctx(k, { approved: false, offerConnect: async (q) => { c2.offered.push(q); k.link.on.heygen = true; return [] } })
    const r2 = await k.tool.run(a, c2)
    expect(r2.text).toMatch(/connected now\. Nothing was made yet/)
    expect(calls(k.heygen, 'create_video_from_avatar')).toHaveLength(0)
    expect(k.tool.consequential!(a, { threadId: 't' })).toBe(true)
    // HyperFrames asks for its own app.
    k.link.on.hyperframes = false
    const c3 = ctx(k)
    await k.tool.run({ action: 'make_motion_video', brief: 'x' }, c3)
    expect(c3.offered).toEqual(['HyperFrames by HeyGen'])
  })

  test('uploading a file from the Mac: a hard stop naming the file, and its own question unless that card was approved', async () => {
    const k = await kit()
    const f = join(k.ws, 'Founder update.mp4')
    writeFileSync(f, TINY_MP4)
    const a = { action: 'translate_video' as const, video_url_or_path: f, target_language: 'Spanish' }
    expect(k.tool.hardStop!(a)).toBe('uploads Founder update.mp4 from your Mac to HeyGen')
    expect(k.tool.hardStop!({ ...a, video_url_or_path: 'https://example.com/v.mp4' })).toBeNull()
    expect(describeVideo(a, { ws: k.ws })).toBe('Upload "Founder update.mp4" from this Mac to HeyGen and translate into Spanish with lip sync. Uses about 1 HeyGen credits (2 s at 6/min).')
    // Not approved on a card (e.g. hard stops off): asked by name; "Don't upload" sends nothing.
    const no = ctx(k, { approved: false, askUser: async (q) => { no.asked.push(q); return 'Don\'t upload' } })
    const r = await k.tool.run(a, no)
    expect(no.asked[0]).toMatch(/^Upload "Founder update\.mp4" \(0\.0 MB\) from this Mac to HeyGen/)
    expect(r.text).toMatch(/Nothing was sent to HeyGen/)
    expect(k.heygen.uploads).toHaveLength(0)
    expect(calls(k.heygen, 'create_asset_upload')).toHaveLength(0)
    // Approved: uploaded (create → PUT → complete), translated from the asset, then saved.
    const yes = ctx(k)
    const out = await k.tool.run(a, yes)
    expect(yes.asked).toEqual([])
    expect(k.heygen.uploads).toEqual([{ assetId: 'as_1', bytes: TINY_MP4.length, type: 'video/mp4' }])
    expect(calls(k.heygen, 'create_asset_upload')[0].args).toEqual({ filename: 'Founder update.mp4', content_type: 'video/mp4', size_bytes: TINY_MP4.length })
    expect(calls(k.heygen, 'create_video_translation')[0].args).toEqual({ video: { type: 'asset_id', asset_id: 'as_1' }, output_languages: ['Spanish'], translate_audio_only: false })
    expect((out.meta!.video as VideoCardData).kind).toBe('translate')
    await vi.waitFor(() => expect(k.notes.some((n) => n.video.status === 'ready')).toBe(true), { timeout: 4000 })
    expect(existsSync(join(k.ws, 'videos', 'founder-update-spanish.mp4'))).toBe(true)
  })

  test('translating a link: no upload, voice-only when lip sync is off', async () => {
    const k = await kit()
    await k.tool.run({ action: 'translate_video', video_url_or_path: 'https://cdn.example.com/talk.mp4', target_language: 'French', lip_sync: false }, ctx(k))
    expect(calls(k.heygen, 'create_video_translation')[0].args).toEqual({ video: { type: 'url', url: 'https://cdn.example.com/talk.mp4' }, output_languages: ['French'], translate_audio_only: true })
    expect(k.heygen.uploads).toHaveLength(0)
    await expect(k.tool.run({ action: 'translate_video', video_url_or_path: 'http://cdn.example.com/talk.mp4', target_language: 'French' }, ctx(k))).rejects.toThrow(/https/)
  })

  test('downloads only from https on public hosts by default', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'video-dl-'))
    const m = new VideoManager({ link: { connected: () => true, tools: () => [], name: () => 'HeyGen' }, workspace: () => ws, stateFile: join(ws, 's.json'), notify: () => undefined, fetch: (async () => { throw new Error('no network in tests') }) as typeof fetch })
    await expect(m.download('http://files.heygen.ai/a.mp4', join(ws, 'a.mp4'))).rejects.toThrow(/only https/)
    await expect(m.download('https://169.254.169.254/latest', join(ws, 'a.mp4'))).rejects.toThrow(/only https/)
    await expect(m.download('https://files.heygen.ai/a.mp4', join(ws, 'a.mp4'))).rejects.toThrow(/no network/)
    m.dispose()
  })

  test('jobs survive a restart and polling resumes', async () => {
    const k = await kit()
    const out = await k.tool.run({ action: 'create_avatar_video', script: 'Hi.', avatar: 'a', voice: 'v', title: 'Resumed' }, ctx(k))
    k.m.dispose()
    const again = new VideoManager({ ...k.m.d, notify: (threadId, text, video) => k.notes.push({ threadId, text, video }) })
    cleanup.push(() => again.dispose())
    expect(again.get((out.meta!.video as VideoCardData).id)?.status).toBe('processing')
    again.resume()
    await vi.waitFor(() => expect(again.card((out.meta!.video as VideoCardData).id)?.status).toBe('ready'), { timeout: 10_000 })
  }, 15_000)
})

describe('intent loading', () => {
  const known = new Set(['video', 'code', 'git', 'jobs', 'create_page', 'update_page', 'research', 'read_result'])
  test('video requests load the video tool; others don\'t; it is never preloaded', () => {
    for (const t of [
      'make a 30-second avatar video about our launch', 'Make a HeyGen video for our onboarding', 'can you dub this video into Spanish?',
      'translate my video to French with lip sync', 'create an explainer video for the pricing page', 'I need motion graphics for the keynote',
      'a talking-head clip of our CEO', 'Render a 60 second product video', 'use hyperframes for animated slides'
    ]) expect(intentTools(t, known), t).toContain('video')
    for (const t of ['what time is it in Tokyo?', 'summarize this video transcript', 'watch this youtube video and tell me the gist', 'fix the failing unit test']) expect(intentTools(t, known), t).not.toContain('video')
    expect(likelyTools(known)).not.toContain('video')
    // Making a video is agent work (credits, a file), so the tool is listed from the first step.
    expect(classifyTask('make a 30-second avatar video about our launch').kind).toBe('agent')
    expect(classifyTask('Dub this video into Spanish').kind).toBe('agent')
    expect(classifyTask('what is an avatar video?').kind).toBe('chat')
    expect(VIDEO_RE.test('heygen')).toBe(true)
  })
})
