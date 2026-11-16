import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: async () => undefined }, BrowserWindow: class {} }))

// Every API here is a local fake server: no paid calls.
const oa = await import('../../src/main/apis/openai')
const { xaiImageOptions } = await import('../../src/main/apis/xai-images')
const an = await import('../../src/main/apis/anthropic')
const { ApiError, openaiError, anthropicError } = await import('../../src/main/apis/errors')
const { hookSpend, usdAsTokens } = await import('../../src/main/apis/spend')
const { spendHooks } = await import('../../src/main/llm/client')
const { cost } = await import('../../src/main/llm/budget')
const { imageTool, speechTool, transcribeTool, pngText, pngWithText, pngInfo, estimateSeconds, clock } = await import('../../src/main/agent/tools/media')
const { readDocumentImageTool, normalizeSchema, RECEIPT_SCHEMA, readReceipt } = await import('../../src/main/agent/tools/vision')
const { BatchManager, batchTool, buildRequests, estimateBatch, fill } = await import('../../src/main/agent/tools/batch')
const emb = await import('../../src/main/knowledge/embeddings')
const { officeTool } = await import('../../src/main/agent/tools/office')

type Req = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }
type Res = { status?: number; headers?: Record<string, string>; body: string | Buffer }

const servers: Array<{ close(): void }> = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  spendHooks.before = undefined
  spendHooks.after = undefined
  emb.embeddingProvider.openai = null
})

async function fake(handler: (r: Req, base: string) => Res | Promise<Res>): Promise<{ url: string; calls: Req[] }> {
  const calls: Req[] = []
  let base = ''
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const r: Req = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }
      calls.push(r)
      const out = await handler(r, base)
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', 'x-should-retry': 'false', ...out.headers })
      res.end(out.body)
    })
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  servers.push(srv)
  return { url: base, calls }
}

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'media-')))
const ctxFor = (ws: string, extra: Record<string, unknown> = {}) => ({ threadId: 't1', state: { roots: [], loaded: [], alwaysAllow: [], todos: [] }, workspaceDir: ws, signal: new AbortController().signal, askUser: async () => 'Submit', ...extra }) as never

/** A small valid PNG (RGBA when alpha). */
function png(w: number, h: number, alpha = false): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2
  const row = Buffer.alloc(1 + w * (alpha ? 4 : 3))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}

/** Records every spend hook call. */
function spy(): { before: Array<[string, number, number, string]>; after: Array<[string, number, number, string]>; usd: () => number } {
  const s = { before: [] as Array<[string, number, number, string]>, after: [] as Array<[string, number, number, string]> }
  spendHooks.before = (req, est, max, priced) => { s.before.push([req.baseUrl, est, max, priced]) }
  spendHooks.after = (req, i, o, served) => { s.after.push([req.baseUrl, i, o, served]) }
  return { ...s, usd: () => s.after.reduce((n, [, i, o, m]) => n + cost(m, i, o), 0) }
}

const access = (o: { openai?: string; anthropic?: string; cloud?: boolean }) => ({
  cloudOn: () => o.cloud !== false,
  openai: () => (o.cloud !== false && o.openai ? { baseUrl: `${o.openai}/v1`, apiKey: 'sk-test' } : undefined),
  anthropic: () => (o.cloud !== false && o.anthropic ? { baseUrl: o.anthropic, apiKey: 'sk-ant-api-test' } : undefined)
})

// ---------------------------------------------------------------- request building (from the docs)

describe('OpenAI request building', () => {
  test('image generation body: model, n, size, quality, transparent background, format', () => {
    expect(oa.imageGenerateBody({ prompt: 'a fox', n: 2, size: '1536x1024', quality: 'low', background: 'transparent', output_format: 'png' }))
      .toEqual({ model: 'gpt-image-2.6-flare', prompt: 'a fox', n: 2, size: '1536x1024', quality: 'low', background: 'transparent', output_format: 'png' })
    expect(oa.imageGenerateBody({ prompt: 'x' })).toEqual({ model: 'gpt-image-2.6-flare', prompt: 'x' })
    expect(() => oa.imageGenerateBody({ prompt: 'x', background: 'transparent', output_format: 'jpeg' })).toThrow(/png or webp/)
  })
  test('sizes: named, multiples of 16, aspect and edge limits', () => {
    expect(oa.checkSize('auto')).toBe('auto')
    expect(oa.checkSize('2048x1152')).toBe('2048x1152')
    expect(() => oa.checkSize('1000x1000')).toThrow(/multiples of 16/)
    expect(() => oa.checkSize('4096x2048')).toThrow(/3840/)
    expect(() => oa.checkSize('3200x800')).toThrow(/aspect/)
    expect(() => oa.checkSize('big')).toThrow(/WIDTHxHEIGHT/)
  })
  test('image edit is multipart with image[] and mask, default Sunburst model', async () => {
    const f = oa.imageEditForm({ prompt: 'add a hat', images: [{ name: 'a.png', data: png(4, 4), mime: 'image/png' }], mask: { name: 'm.png', data: png(4, 4, true), mime: 'image/png' } })
    expect(f.get('model')).toBe('gpt-image-2.6-sunburst')
    expect(f.getAll('image[]')).toHaveLength(1)
    expect((f.get('mask') as File).name).toBe('m.png')
    expect(() => oa.imageEditForm({ prompt: 'x', images: [] })).toThrow(/at least one/)
  })
  test('speech body: voice, instructions (not for tts-1), format, speed range, 4096 limit', () => {
    expect(oa.speechBody({ input: 'Hi', instructions: 'cheerful', response_format: 'wav', speed: 1.2 })).toEqual({ model: 'gpt-4o-mini-tts', voice: 'marin', input: 'Hi', instructions: 'cheerful', response_format: 'wav', speed: 1.2 })
    expect(oa.speechBody({ input: 'Hi', model: 'tts-1', instructions: 'x' })).not.toHaveProperty('instructions')
    expect(() => oa.speechBody({ input: 'x'.repeat(4097) })).toThrow(/4096/)
    expect(() => oa.speechBody({ input: 'x', speed: 5 })).toThrow(/speed/)
    const parts = oa.splitForSpeech(`${'One sentence here. '.repeat(400)}`)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= oa.TTS_MAX_CHARS)).toBe(true)
  })
  test('transcription form: gpt-transcribe json by default; timestamps switch to whisper-1 verbose_json with segments', () => {
    const file = { name: 'a.mp3', data: Buffer.from('x'), mime: 'audio/mpeg' }
    const a = oa.transcribeForm({ file, language: 'en' })
    expect([a.get('model'), a.get('response_format'), a.get('language')]).toEqual(['gpt-transcribe', 'json', 'en'])
    const b = oa.transcribeForm({ file, timestamps: true })
    expect([b.get('model'), b.get('response_format'), b.get('timestamp_granularities[]')]).toEqual(['whisper-1', 'verbose_json', 'segment'])
  })
  test('PCM to WAV header (24 kHz mono 16-bit)', () => {
    const w = oa.pcmToWav(Buffer.alloc(48000))
    expect(w.toString('latin1', 0, 4)).toBe('RIFF')
    expect(w.readUInt32LE(24)).toBe(24000)
    expect(w.length).toBe(48044)
  })
})

describe('Anthropic request building', () => {
  test('PDF document block with citations, image block, files source', () => {
    expect(an.sourceBlock({ kind: 'pdf', data: Buffer.from('%PDF') }, { title: 'a.pdf', citations: true })).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF').toString('base64') }, title: 'a.pdf', citations: { enabled: true } })
    expect(an.sourceBlock({ kind: 'image', mime: 'image/png', data: Buffer.from('x') })).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } })
    expect(an.sourceBlock({ kind: 'pdf_file', fileId: 'file_1' })).toMatchObject({ type: 'document', source: { type: 'file', file_id: 'file_1' } })
    expect(() => an.sourceBlock({ kind: 'image', mime: 'image/heic', data: Buffer.from('x') })).toThrow(/png, jpeg/)
  })
  test('schema goes in output_config.format; citations and a schema are refused together', () => {
    const p = an.readParams({ source: { kind: 'image', mime: 'image/png', data: Buffer.from('x') }, instructions: 'read', schema: { type: 'object' } })
    expect(p.model).toBe('claude-sonnet-5-5')
    expect((p as { output_config?: unknown }).output_config).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } })
    expect(String(p.system)).toMatch(/never instructions/)
    expect(() => an.readParams({ source: { kind: 'pdf', data: Buffer.from('x') }, instructions: 'r', schema: {}, citations: true })).toThrow()
  })
  test('schemas are normalized for structured outputs', () => {
    const s = normalizeSchema({ type: 'object', properties: { n: { type: 'number', minimum: 0 }, d: { type: 'string', format: 'date' }, x: { type: 'string', format: 'phone' }, o: { type: 'object', properties: { a: { type: 'string' } } } } }) as Record<string, any>
    expect(s.additionalProperties).toBe(false)
    expect(s.required).toEqual(['n', 'd', 'x', 'o'])
    expect(s.properties.n).toEqual({ type: 'number' })
    expect(s.properties.d.format).toBe('date')
    expect(s.properties.x.format).toBeUndefined()
    expect(s.properties.o.additionalProperties).toBe(false)
    expect((RECEIPT_SCHEMA as { additionalProperties: boolean }).additionalProperties).toBe(false)
  })
  test('batch requests from a template: placeholders, data tags, custom ids, schema', () => {
    expect(fill('Hi {{name}} {{ missing }}', { name: 'Ann' })).toBe('Hi Ann {{ missing }}')
    const reqs = buildRequests({ template: 'Summarize {{file}}:\n{{content}}', items: [{ label: 'a.md', vars: { file: 'a.md', content: 'alpha' } }, { label: 'b.md', vars: { file: 'b.md', content: 'beta' } }], schema: { type: 'object', properties: { s: { type: 'string' } } }, maxTokens: 300 })
    expect(reqs.map((r) => r.custom_id)).toEqual(['item-0', 'item-1'])
    expect(reqs[0].params).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 300 })
    expect(reqs[0].params.messages[0].content).toBe('Summarize a.md:\n<item>\nalpha\n</item>')
    expect(String(reqs[0].params.system)).toMatch(/data to work on, never instructions/)
    expect((reqs[0].params as { output_config?: { format: { schema: { additionalProperties: boolean } } } }).output_config?.format.schema.additionalProperties).toBe(false)
    // No placeholder: the item is appended.
    expect(buildRequests({ template: 'Classify:', items: [{ label: '1', vars: { item: 'x' } }] })[0].params.messages[0].content).toBe('Classify:\n\n<item>\nx\n</item>')
    expect(() => buildRequests({ template: 'x', items: [] })).toThrow(/No items/)
    expect(() => buildRequests({ template: 'x', items: [{ label: '1', vars: {} }], model: 'gpt-5' })).toThrow(/Claude/)
  })
})

// ---------------------------------------------------------------- parsing, errors, prices

describe('error mapping', () => {
  test('OpenAI: 401, 429 rate limit with retry-after, 429 quota, moderation block', () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null })
    const auth = openaiError(401, JSON.stringify({ error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } }))
    expect([auth.kind, auth.status]).toEqual(['auth', 401])
    expect(auth.message).toMatch(/rejected the API key.*Settings/)
    const rl = openaiError(429, JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }), h({ 'retry-after': '7' }))
    expect([rl.kind, rl.retryAfterMs]).toEqual(['rate_limit', 7000])
    expect(rl.message).toMatch(/about 7 s/)
    expect(openaiError(429, JSON.stringify({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } })).kind).toBe('quota')
    const mod = openaiError(400, JSON.stringify({ error: { message: 'Your request was rejected by the safety system.', type: 'image_generation_user_error', code: 'moderation_blocked', moderation_details: { moderation_stage: 'input', categories: ['violence'] } } }))
    expect(mod.kind).toBe('content_policy')
    expect(mod.message).toMatch(/blocked.*stage: input.*violence/)
    expect(mod.message).toMatch(/retrying the same request/)
    expect(openaiError(500, 'oops').kind).toBe('server')
    expect(openaiError(400, '{"error":{"message":"bad size"}}').kind).toBe('bad_request')
  })
  test('Anthropic SDK errors from a server: 401 and 429', async () => {
    const srv = await fake((r) => r.headers.authorization === 'Bearer bad' || r.headers['x-api-key'] === 'bad'
      ? { status: 401, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) }
      : { status: 429, headers: { 'retry-after': '3' }, body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }) })
    const run = (key: string) => an.readDocument({ baseUrl: srv.url, apiKey: key }, { source: { kind: 'image', mime: 'image/png', data: Buffer.from('x') }, instructions: 'r' }).catch((e) => e)
    const a = await run('bad')
    expect(a).toBeInstanceOf(ApiError)
    expect([a.kind, a.status]).toEqual(['auth', 401])
    const b = await run('sk-ant-api-x')
    expect([b.kind, b.retryAfterMs]).toEqual(['rate_limit', 3000])
    expect(anthropicError(Object.assign(new Error('x'), { name: 'APIUserAbortError' })).kind).toBe('aborted')
  })
})

describe('prices and estimates', () => {
  test('images: per quality and size before; from usage after', () => {
    expect(oa.estimateImageUsd({ quality: 'low', size: '1024x1024', promptChars: 0 })).toBeCloseTo(0.006, 3)
    expect(oa.estimateImageUsd({ quality: 'high', size: '1024x1024', promptChars: 0 })).toBeCloseTo(0.211, 2)
    expect(oa.estimateImageUsd({ quality: 'medium', size: '1024x1024', n: 4, promptChars: 0 })).toBeCloseTo(0.2124, 3)
    // auto quality and auto size are priced pessimistically.
    expect(oa.estimateImageUsd({ promptChars: 0 })).toBeGreaterThan(0.3)
    expect(oa.imageUsageUsd({ input_tokens: 50, output_tokens: 1000, input_tokens_details: { text_tokens: 50, image_tokens: 0 } })).toBeCloseTo((50 * 5 + 1000 * 30) / 1e6, 8)
    expect(oa.imageUsageUsd(undefined)).toBeUndefined()
  })
  test('speech, transcription, embeddings, batch (half price)', () => {
    expect(oa.speechUsd('tts-1', 1000)).toBeCloseTo(0.015, 6)
    expect(oa.speechUsd('gpt-4o-mini-tts', 750)).toBeCloseTo((250 * 0.6 + 1250 * 12) / 1e6, 6)
    expect(oa.transcribeUsd('gpt-transcribe', { usage: { type: 'duration', seconds: 600 } }, 0)).toBeCloseTo(0.045, 6)
    expect(oa.transcribeUsd('gpt-4o-transcribe', { usage: { type: 'tokens', input_tokens: 1000, output_tokens: 100 } }, 0)).toBeCloseTo((1000 * 2.5 + 100 * 10) / 1e6, 8)
    expect(oa.transcribeUsd('whisper-1', undefined, 120)).toBeCloseTo(0.012, 6)
    expect(oa.embeddingsUsd('text-embedding-3-small', 1_000_000)).toBeCloseTo(0.02, 6)
    expect(oa.embeddingsUsd('text-embedding-3-large', 1_000_000)).toBeCloseTo(0.13, 6)
    expect(an.batchCost('claude-haiku-5-5', 10_000, 1000)).toBeCloseTo(cost('claude-haiku-5-5', 10_000, 1000) / 2, 10)
    const est = estimateBatch(buildRequests({ template: '{{item}}', items: Array.from({ length: 10 }, (_, i) => ({ label: String(i), vars: { item: 'x'.repeat(300) } })), maxTokens: 100 }))
    expect(est.requests).toBe(10)
    expect(est.worstUsd).toBeGreaterThan(est.typicalUsd)
    expect(estimateSeconds(16_000 * 60, '.mp3', { pessimistic: false })).toBe(60)
    expect(clock(3725)).toBe('01:02:05')
  })
  test('dollar amounts become tokens the budget prices back to the same dollars', () => {
    for (const label of ['gpt-image-2.6-flare', 'batch:claude-haiku-5-5', 'text-embedding-3-small']) expect(cost(label, usdAsTokens(label, 0.25), 0)).toBeCloseTo(0.25, 5)
  })
})

// ---------------------------------------------------------------- tools against fake servers

describe('image tool', () => {
  test('xAI-only accounts generate JPEGs with a priced capability route and no OpenAI-only parameters', async () => {
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9])
    const srv = await fake(() => ({ body: JSON.stringify({ data: [{ b64_json: img.toString('base64') }] }) }))
    const ws = tmp(), s = spy()
    const acc = { ...access({}), xai: () => ({ baseUrl: `${srv.url}/v1`, apiKey: 'xai-test' }) }
    const tool = imageTool({ access: acc, workspace: () => ws, vision: () => true })
    expect(tool.available!({} as never)).toBe(true)
    const out = await tool.run({ action: 'generate', prompt: 'A lighthouse', size: '1536x1024', quality: 'high' }, ctxFor(ws))
    expect(JSON.parse(srv.calls[0].body.toString())).toEqual({ model: 'grok-imagine-image-2.0', prompt: 'A lighthouse', n: 1, response_format: 'b64_json', aspect_ratio: '3:2', resolution: '1k', quality: 'medium' })
    expect(srv.calls[0].headers.authorization).toBe('Bearer xai-test')
    expect(out.path).toMatch(/\.jpg$/)
    expect(readFileSync(out.path!)).toEqual(img)
    expect(out.images?.[0]).toMatch(/^data:image\/jpeg;base64,/)
    expect(s.usd()).toBeCloseTo(0.06, 5)
    expect(readFileSync(`${out.path}.json`, 'utf8')).toContain('A lighthouse')
    await expect(tool.run({ action: 'generate', prompt: 'A logo', background: 'transparent' }, ctxFor(ws))).rejects.toThrow(/OpenAI/)
    await expect(tool.run({ action: 'edit', prompt: 'A logo', path: 'logo.png' }, ctxFor(ws))).rejects.toThrow(/OpenAI/)
    expect(srv.calls).toHaveLength(1)
    expect(imageTool({ access: { ...acc, cloudOn: () => false }, workspace: tmp }).available!({} as never)).toBe(false)
  })
  test('Grok pins Auto quality and estimates each resolution; rejects invalid images and respects budget before network', async () => {
    expect(xaiImageOptions()).toMatchObject({ quality: 'low', unitUsd: 0.04 })
    expect(xaiImageOptions('2048x2048', 'medium')).toMatchObject({ resolution: '2k', unitUsd: 0.08 })
    expect(() => xaiImageOptions('nope')).toThrow(/size/)
    const srv = await fake(() => ({ body: JSON.stringify({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }) }))
    const acc = { ...access({}), xai: () => ({ baseUrl: srv.url, apiKey: 'test' }) }
    const tool = imageTool({ access: acc, workspace: tmp })
    await expect(tool.run({ action: 'generate', prompt: 'A fox' }, ctxFor(tmp()))).rejects.toThrow(/unsupported image format/)
    spendHooks.before = () => { throw new Error('budget reached') }
    await expect(tool.run({ action: 'generate', prompt: 'A fox' }, ctxFor(tmp()))).rejects.toThrow(/budget reached/)
    expect(srv.calls).toHaveLength(1)
  })
  test('generates, saves PNGs with the prompt in metadata, shows them to a vision model, and goes through the spend hooks', async () => {
    const img = png(8, 8)
    const srv = await fake(() => ({ body: JSON.stringify({ created: 1, data: [{ b64_json: img.toString('base64') }, { b64_json: img.toString('base64') }], size: '1024x1024', quality: 'low', usage: { input_tokens: 20, output_tokens: 400, input_tokens_details: { text_tokens: 20, image_tokens: 0 } } }) }))
    const ws = tmp()
    const s = spy()
    const tool = imageTool({ access: access({ openai: srv.url }), workspace: () => ws, vision: () => true, now: () => new Date(2026, 10, 14, 9, 30, 0) })
    const out = await tool.run({ action: 'generate', prompt: 'A red fox, watercolor', n: 2, quality: 'low', size: '1024x1024' }, ctxFor(ws))
    const body = JSON.parse(srv.calls[0].body.toString())
    expect(srv.calls[0].url).toBe('/v1/images/generations')
    expect(srv.calls[0].headers.authorization).toBe('Bearer sk-test')
    expect(body).toMatchObject({ model: 'gpt-image-2.6-flare', n: 2, quality: 'low', size: '1024x1024', output_format: 'png' })
    expect(out.images).toHaveLength(2)
    expect(out.path).toMatch(/images\/a-red-fox-watercolor-20261114-093000-1\.png$/)
    expect(pngText(readFileSync(out.path!)).Description).toBe('A red fox, watercolor')
    // Priced before (worst case) and recorded after (from usage), both through the hooks.
    expect(s.before).toHaveLength(1)
    expect(s.before[0][3]).toBe('gpt-image-2.6-flare')
    expect(cost('gpt-image-2.6-flare', s.before[0][1], 0)).toBeCloseTo(oa.estimateImageUsd({ n: 2, quality: 'low', size: '1024x1024', promptChars: 21 }), 5)
    expect(s.usd()).toBeCloseTo((20 * 5 + 400 * 30) / 1e6, 6)
  })
  test('the budget refusing stops the request before it is sent; content policy errors are clear and not recorded', async () => {
    const srv = await fake(() => ({ status: 400, body: JSON.stringify({ error: { message: 'Your request was rejected by the safety system.', type: 'image_generation_user_error', code: 'moderation_blocked' } }) }))
    const ws = tmp()
    spendHooks.before = () => { throw new Error('Cloud budget reached') }
    const tool = imageTool({ access: access({ openai: srv.url }), workspace: () => ws })
    await expect(tool.run({ action: 'generate', prompt: 'x' }, ctxFor(ws))).rejects.toThrow(/budget/)
    expect(srv.calls).toHaveLength(0)
    const s = spy()
    await expect(tool.run({ action: 'generate', prompt: 'x' }, ctxFor(ws))).rejects.toThrow(/safety system blocked/)
    expect(s.after).toHaveLength(0)
  })
  test('edit sends the image and checks the mask (alpha, same size)', async () => {
    const img = png(8, 8)
    const srv = await fake(() => ({ body: JSON.stringify({ data: [{ b64_json: img.toString('base64') }] }) }))
    const ws = tmp()
    writeFileSync(join(ws, 'room.png'), png(8, 8))
    writeFileSync(join(ws, 'mask.png'), png(8, 8, true))
    writeFileSync(join(ws, 'opaque.png'), png(8, 8))
    writeFileSync(join(ws, 'small.png'), png(4, 4, true))
    spy()
    const tool = imageTool({ access: access({ openai: srv.url }), workspace: () => ws })
    await expect(tool.run({ action: 'edit', prompt: 'add a plant', path: 'room.png', mask: 'opaque.png' }, ctxFor(ws))).rejects.toThrow(/alpha channel/)
    await expect(tool.run({ action: 'edit', prompt: 'add a plant', path: 'room.png', mask: 'small.png' }, ctxFor(ws))).rejects.toThrow(/same size/)
    const out = await tool.run({ action: 'edit', prompt: 'add a plant', path: 'room.png', mask: 'mask.png' }, ctxFor(ws))
    expect(srv.calls[0].url).toBe('/v1/images/edits')
    expect(String(srv.calls[0].headers['content-type'])).toMatch(/multipart\/form-data/)
    const raw = srv.calls[0].body.toString('latin1')
    expect(raw).toContain('name="image[]"; filename="room.png"')
    expect(raw).toContain('name="mask"; filename="mask.png"')
    expect(raw).toContain('gpt-image-2.6-sunburst')
    // No vision: no images attached.
    expect(out.images).toBeUndefined()
    expect(pngInfo(readFileSync(out.path!))).toMatchObject({ width: 8, height: 8 })
  })
  test('PNG text chunks round-trip (UTF-8)', () => {
    expect(pngText(pngWithText(png(2, 2), { Description: 'café ☕', Software: 'SahilBot' }))).toEqual({ Description: 'café ☕', Software: 'SahilBot' })
  })
})

describe('speech and transcription tools', () => {
  test('speech saves audio (long wav text joins PCM parts) and records spend', async () => {
    const srv = await fake(() => ({ headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(480) }))
    const ws = tmp()
    const s = spy()
    const played: string[] = []
    const tool = speechTool({ access: access({ openai: srv.url }), workspace: () => ws, play: (f) => { played.push(f) } })
    const out = await tool.run({ text: 'Hello there. '.repeat(500), format: 'wav', play: true, voice: 'cedar' }, ctxFor(ws))
    expect(srv.calls.length).toBeGreaterThan(1)
    const body = JSON.parse(srv.calls[0].body.toString())
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'cedar', response_format: 'pcm' })
    const wav = readFileSync(out.path!)
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF')
    expect(wav.length).toBe(44 + 480 * srv.calls.length)
    expect(played).toEqual([out.path])
    expect(s.before).toHaveLength(1)
    expect(s.usd()).toBeGreaterThan(0)
    await expect(tool.run({ text: 'x', voice: 'nobody' }, ctxFor(ws))).rejects.toThrow(/Unknown voice/)
  })
  test('transcription with timestamps: whisper-1, segments as [hh:mm:ss] lines, saved transcript, untrusted', async () => {
    const srv = await fake(() => ({ body: JSON.stringify({ text: 'Hello. Next.', duration: 65, segments: [{ id: 0, start: 0, end: 2, text: ' Hello.' }, { id: 1, start: 62, end: 65, text: ' Next.' }], usage: { type: 'duration', seconds: 65 } }) }))
    const ws = tmp()
    writeFileSync(join(ws, 'call.mp3'), Buffer.alloc(2000))
    const s = spy()
    const tool = transcribeTool({ access: access({ openai: srv.url }), workspace: () => ws })
    expect(tool.untrusted).toBe(true)
    const out = await tool.run({ path: 'call.mp3', timestamps: true }, ctxFor(ws))
    expect(srv.calls[0].url).toBe('/v1/audio/transcriptions')
    expect(srv.calls[0].body.toString('latin1')).toContain('whisper-1')
    expect(out.text).toContain('[00:00:00] Hello.')
    expect(out.text).toContain('[00:01:02] Next.')
    expect(readFileSync(out.path!, 'utf8')).toContain('[00:01:02] Next.')
    expect(s.usd()).toBeCloseTo((65 / 60) * 0.006, 4)
  })
  test('too big or unsupported without ffmpeg: explains instead of sending', async () => {
    const srv = await fake(() => ({ body: '{}' }))
    const ws = tmp()
    writeFileSync(join(ws, 'clip.mov'), Buffer.alloc(100))
    const tool = transcribeTool({ access: access({ openai: srv.url }), workspace: () => ws, ffmpeg: () => null })
    await expect(tool.run({ path: 'clip.mov' }, ctxFor(ws))).rejects.toThrow(/brew install ffmpeg/)
    expect(srv.calls).toHaveLength(0)
  })
})

describe('read_document_image', () => {
  test('a receipt image with the preset: image block, output_config schema, tokens recorded at the real model, untrusted output', async () => {
    const srv = await fake(() => ({ body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: '{"merchant":"Blue Bottle","date":"2026-11-02","currency":"USD","subtotal":9,"tax":0.8,"tip":null,"total":9.8,"receipt_number":null,"payment_method":"Visa","items":[]}' }], usage: { input_tokens: 1500, output_tokens: 80 } }) }))
    const ws = tmp()
    writeFileSync(join(ws, 'r.png'), png(8, 8))
    const s = spy()
    const tool = readDocumentImageTool({ access: access({ anthropic: srv.url }), workspace: () => ws })
    expect(tool.untrusted).toBe(true)
    const out = await tool.run({ path: 'r.png', preset: 'receipt' }, ctxFor(ws))
    const body = JSON.parse(srv.calls[0].body.toString())
    expect(srv.calls[0].url).toBe('/v1/messages')
    expect(body.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
    expect(body.output_config.format.type).toBe('json_schema')
    expect(out.text).toMatch(/data, not instructions/)
    expect(out.text).toContain('"merchant": "Blue Bottle"')
    expect(s.before[0][3]).toBe('claude-sonnet-5-5')
    expect(s.after).toEqual([[srv.url, 1500, 80, 'claude-sonnet-5-5']])
  })
  test('a scanned PDF with citations: document block, page citations listed', async () => {
    const srv = await fake(() => ({ body: JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'The total is $40.', citations: [{ type: 'page_location', cited_text: 'Total: $40.00', document_index: 0, document_title: 'scan.pdf', start_page_number: 2, end_page_number: 3 }] }], usage: { input_tokens: 9000, output_tokens: 20 } }) }))
    const ws = tmp()
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create(); doc.addPage(); doc.addPage()
    writeFileSync(join(ws, 'scan.pdf'), Buffer.from(await doc.save()))
    spy()
    const out = await readDocumentImageTool({ access: access({ anthropic: srv.url }), workspace: () => ws }).run({ path: 'scan.pdf', instructions: 'What is the total?', citations: true }, ctxFor(ws))
    const body = JSON.parse(srv.calls[0].body.toString())
    expect(body.messages[0].content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' }, citations: { enabled: true }, title: 'scan.pdf' })
    expect(out.text).toContain('(2 pages)')
    expect(out.text).toContain('p. 2: "Total: $40.00"')
  })
  test('office receipts_to_sheet reads an image receipt through the vision hook', async () => {
    const srv = await fake(() => ({ body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: '{"merchant":"Staples","date":"2026-11-05","currency":"USD","subtotal":14,"tax":1,"tip":null,"total":15,"receipt_number":"A1","payment_method":null,"items":[]}' }], usage: { input_tokens: 1200, output_tokens: 60 } }) }))
    const ws = tmp()
    mkdirSync(join(ws, 'inbox'))
    writeFileSync(join(ws, 'inbox', 'c.png'), png(8, 8))
    spy()
    const vd = { access: access({ anthropic: srv.url }), workspace: () => ws }
    const office = officeTool({ getWorkspace: () => ws, visionReceipt: (f, signal) => readReceipt(vd, f, signal) })
    const out = await office.run({ action: 'receipts_to_sheet', dir: 'inbox' } as never, ctxFor(ws))
    expect(out.text).toContain('c.png: Staples · 2026-11-05 · 15.00')
    expect(out.text).not.toContain('NEEDS VISION')
  })
})

describe('batch lifecycle (fake Message Batches server)', () => {
  test('estimate, submit (approval above $1 is asked), poll until ended, results to CSV/JSONL, chat note, spend at half price', async () => {
    let state: 'in_progress' | 'ended' = 'in_progress'
    const batch = (base: string) => ({ id: 'msgbatch_1', type: 'message_batch', processing_status: state, request_counts: state === 'ended' ? { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 } : { processing: 3, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, ended_at: state === 'ended' ? '2026-11-14T10:00:00Z' : null, created_at: '2026-11-14T09:00:00Z', expires_at: '2026-11-15T09:00:00Z', cancel_initiated_at: null, archived_at: null, results_url: state === 'ended' ? `${base}/v1/messages/batches/msgbatch_1/results` : null })
    const msg = (text: string) => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } })
    const srv = await fake((r, base) => {
      if (r.method === 'POST' && r.url === '/v1/messages/batches') return { body: JSON.stringify(batch(base)) }
      if (r.url === '/v1/messages/batches/msgbatch_1') return { body: JSON.stringify(batch(base)) }
      if (r.url === '/v1/messages/batches/msgbatch_1/results') return { headers: { 'content-type': 'application/binary' }, body: [
        JSON.stringify({ custom_id: 'item-1', result: { type: 'succeeded', message: msg('Summary of b') } }),
        JSON.stringify({ custom_id: 'item-0', result: { type: 'succeeded', message: msg('Summary of a') } }),
        JSON.stringify({ custom_id: 'item-2', result: { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'too long' } } } })
      ].join('\n') }
      return { status: 404, body: '{}' }
    })
    const ws = tmp()
    mkdirSync(join(ws, 'notes'))
    for (const n of ['a', 'b', 'c']) writeFileSync(join(ws, 'notes', `${n}.md`), `# ${n}\nSome notes about ${n}.`)
    writeFileSync(join(ws, 'notes', 'skip.bin'), Buffer.alloc(4))
    const notes: string[] = []
    const s = spy()
    const m = new BatchManager({ access: access({ anthropic: srv.url }), workspace: () => ws, stateFile: join(ws, 'state', 'batches.json'), notify: (_t, text) => notes.push(text), pollMs: 60_000_000 })
    const tool = batchTool(m, { access: access({ anthropic: srv.url }), workspace: () => ws })
    expect(tool.untrusted).toBe(true)
    expect(typeof tool.effect === 'function' && tool.effect({ action: 'estimate' } as never, { roots: [] })).toBe('read')

    const est = await tool.run({ action: 'estimate', dir: 'notes', ext: '.md', template: 'Summarize {{file}}:\n{{content}}' }, ctxFor(ws))
    expect(est.text).toMatch(/^3 request\(s\) to claude-haiku-5-5 at batch prices/)
    expect(srv.calls).toHaveLength(0)

    let asked = 0
    const sub = await tool.run({ action: 'submit', dir: 'notes', ext: '.md', template: 'Summarize {{file}}:\n{{content}}', title: 'Note summaries' }, ctxFor(ws, { askUser: async () => { asked++; return 'Submit' } }))
    // Under $1: no approval card.
    expect(asked).toBe(0)
    expect(sub.text).toContain('Submitted batch msgbatch_1')
    const created = JSON.parse(srv.calls[0].body.toString())
    expect(created.requests).toHaveLength(3)
    expect(created.requests[0]).toMatchObject({ custom_id: 'item-0', params: { model: 'claude-haiku-5-5', max_tokens: 1024 } })
    expect(s.before[0][3]).toBe('batch:claude-haiku-5-5')
    expect(existsSync(join(ws, 'state', 'batches.json'))).toBe(true)

    expect((await m.check('msgbatch_1')).status).toBe('in_progress')
    expect(notes).toHaveLength(0)
    state = 'ended'
    const done = await m.check('msgbatch_1')
    expect(done.status).toBe('collected')
    const csv = readFileSync(done.csv, 'utf8')
    expect(csv.split('\n')[0]).toBe('item,status,output,error')
    expect(csv).toContain('notes/a.md,succeeded,Summary of a')
    expect(csv).toContain('notes/c.md,errored,,invalid_request_error: too long')
    expect(readFileSync(done.jsonl, 'utf8').trim().split('\n')).toHaveLength(3)
    expect(notes[0]).toMatch(/Batch finished · Note summaries: 2 of 3 succeeded \(1 errored\)/)
    // Half price: 2 × (1000 in, 100 out) recorded as half the tokens of the real model.
    expect(s.after).toEqual([[srv.url, 1000, 100, 'claude-haiku-5-5']])
    expect(s.usd()).toBeCloseTo(2 * cost('claude-haiku-5-5', 1000, 100) / 2, 8)
    // Collected once; a restart reads the record back.
    expect((await m.check('msgbatch_1')).status).toBe('collected')
    expect(new BatchManager({ access: access({ anthropic: srv.url }), workspace: () => ws, stateFile: join(ws, 'state', 'batches.json'), notify: () => undefined }).get('msgbatch_1')?.status).toBe('collected')
    m.dispose()
  })
  test('above $1 the user is asked, and "Cancel" submits nothing; cancel action calls the API', async () => {
    const srv = await fake((r, base) => ({ body: JSON.stringify({ id: 'msgbatch_2', type: 'message_batch', processing_status: r.url.endsWith('/cancel') ? 'canceling' : 'in_progress', request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, ended_at: null, created_at: '', expires_at: '', cancel_initiated_at: null, archived_at: null, results_url: null, base }) }))
    const ws = tmp()
    spy()
    const m = new BatchManager({ access: access({ anthropic: srv.url }), workspace: () => ws, stateFile: join(ws, 'b.json'), notify: () => undefined, pollMs: 60_000_000 })
    const tool = batchTool(m, { access: access({ anthropic: srv.url }), workspace: () => ws })
    const big = { action: 'submit' as const, items: Array.from({ length: 400 }, (_, i) => `row ${i} ${'x'.repeat(50)}`), template: 'Classify: {{item}}', model: 'claude-opus-5-5', max_tokens: 1000 }
    const no = await tool.run(big, ctxFor(ws, { askUser: async (q: string) => { expect(q).toMatch(/at most \$/); return 'Cancel' } }))
    expect(no.text).toMatch(/Not submitted/)
    expect(srv.calls).toHaveLength(0)
    await tool.run(big, ctxFor(ws, { askUser: async () => 'Submit' }))
    const c = await tool.run({ action: 'cancel', id: 'msgbatch_2' }, ctxFor(ws))
    expect(c.text).toMatch(/Canceling msgbatch_2/)
    expect(srv.calls.at(-1)!.url).toBe('/v1/messages/batches/msgbatch_2/cancel')
    m.dispose()
  })
})

describe('availability gating and untrusted marking', () => {
  test('tools are listed only with the key and cloud on', () => {
    const state = { loaded: [], alwaysAllow: [], todos: [] }
    const cases: Array<[ReturnType<typeof access>, boolean, boolean]> = [
      [access({ openai: 'http://x', anthropic: 'http://y' }), true, true],
      [access({ openai: 'http://x' }), true, false],
      [access({ anthropic: 'http://y' }), false, true],
      [access({ openai: 'http://x', anthropic: 'http://y', cloud: false }), false, false]
    ]
    for (const [acc, openai, claude] of cases) {
      const m = new BatchManager({ access: acc, workspace: () => tmp(), stateFile: join(tmp(), 'b.json'), notify: () => undefined })
      for (const t of [imageTool({ access: acc, workspace: tmp }), speechTool({ access: acc, workspace: tmp }), transcribeTool({ access: acc, workspace: tmp })]) expect(t.available!(state)).toBe(openai)
      for (const t of [readDocumentImageTool({ access: acc, workspace: tmp }), batchTool(m, { access: acc, workspace: tmp })]) expect(t.available!(state)).toBe(claude)
    }
    expect(imageTool({ access: access({}), workspace: tmp }).untrusted).toBeFalsy()
    expect(imageTool({ access: access({}), workspace: tmp }).core).toBeFalsy()
  })
  test('a call without a key explains what is missing', async () => {
    const ws = tmp()
    await expect(imageTool({ access: access({}), workspace: () => ws }).run({ action: 'generate', prompt: 'x' }, ctxFor(ws))).rejects.toThrow(/No OpenAI API key/)
    await expect(imageTool({ access: access({ openai: 'http://x', cloud: false }), workspace: () => ws }).run({ action: 'generate', prompt: 'x' }, ctxFor(ws))).rejects.toThrow(/switched off/)
  })
})

describe('OpenAI embeddings for the knowledge base (opt-in)', () => {
  test('off: Ollama detection as before; on: the OpenAI model wins, embeds in order and records spend', async () => {
    const ollama = await fake(() => ({ body: JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }) }))
    expect(await emb.detectEmbedModel(ollama.url)).toBe('nomic-embed-text:latest')
    const srv = await fake((r) => {
      const n = (JSON.parse(r.body.toString()) as { input: string[] }).input.length
      return { body: JSON.stringify({ object: 'list', data: Array.from({ length: n }, (_, i) => ({ object: 'embedding', index: n - 1 - i, embedding: [n - 1 - i, 0.5] })), model: 'text-embedding-3-small', usage: { prompt_tokens: 12, total_tokens: 12 } }) }
    })
    let on = true
    emb.embeddingProvider.openai = { creds: () => (on ? { baseUrl: `${srv.url}/v1`, apiKey: 'sk-test' } : null) }
    expect(await emb.detectEmbedModel(ollama.url)).toBe('openai:text-embedding-3-small')
    const s = spy()
    const e = emb.ollamaEmbedder(ollama.url, 'openai:text-embedding-3-small')
    expect(e.model).toBe('openai:text-embedding-3-small')
    const v = await e.embed(['first', 'second'], 'document')
    expect(Array.from(v[0])).toEqual([0, 0.5])
    expect(Array.from(v[1])).toEqual([1, 0.5])
    const body = JSON.parse(srv.calls[0].body.toString())
    expect(body).toEqual({ model: 'text-embedding-3-small', input: ['first', 'second'], encoding_format: 'float' })
    expect(srv.calls[0].url).toBe('/v1/embeddings')
    expect(s.before[0][3]).toBe('text-embedding-3-small')
    expect(Math.abs(s.usd() - 12 * 0.02 / 1e6)).toBeLessThanOrEqual(0.00001)
    on = false
    expect(await emb.detectEmbedModel(ollama.url)).toBe('nomic-embed-text:latest')
  })
})

test('hookSpend is a no-op without hooks (tests, other processes)', () => {
  expect(() => hookSpend.beforeUsd('https://api.openai.com/v1', 'x', 1)).not.toThrow()
})
