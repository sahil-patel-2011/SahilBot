import { networkError, openaiError } from './errors'

// Thin OpenAI REST client over fetch (no SDK in deps): Images (generate, edit), Audio (speech,
// transcription) and Embeddings, with the request shapes and prices from the official docs
// (developers.openai.com/api/reference + /api/docs/pricing, read 2026-11-14).

type Fetch = typeof fetch

export interface OpenAICreds {
  /** e.g. https://api.openai.com/v1 (Settings → OpenAI base URL). */
  baseUrl: string
  apiKey: string
}

const trim = (u: string): string => u.replace(/\/+$/, '')

async function call(creds: OpenAICreds, path: string, init: { json?: unknown; form?: FormData; signal?: AbortSignal; timeoutMs?: number }, fetchImpl: Fetch): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${creds.apiKey}` }
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 300_000)
  let res: Response
  try {
    res = await fetchImpl(`${trim(creds.baseUrl)}${path}`, {
      method: 'POST',
      headers,
      body: init.form ?? JSON.stringify(init.json),
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    })
  } catch (e) {
    throw networkError('OpenAI', e)
  }
  if (!res.ok) throw openaiError(res.status, await res.text().catch(() => ''), res.headers)
  return res
}

// ---------------------------------------------------------------- images

/** Current GPT image models (Image API): Flare for fast everyday generation, Sunburst where edit precision matters. */
export const IMAGE_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'] as const
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.6-flare'
export const DEFAULT_EDIT_MODEL = 'gpt-image-2.6-sunburst'
export type ImageQuality = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto'
export type ImageBackground = 'auto' | 'opaque' | 'transparent'
export type ImageFormat = 'png' | 'webp' | 'jpeg'

export interface ImageOptions {
  model?: string
  prompt: string
  n?: number
  /** auto, 1024x1024, 1536x1024, 1024x1536, or WIDTHxHEIGHT (multiples of 16) on the gpt-image-2 family. */
  size?: string
  quality?: ImageQuality
  background?: ImageBackground
  output_format?: ImageFormat
}

export interface ImageUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { image_tokens?: number; text_tokens?: number }
}

export interface ImageResult {
  images: Buffer[]
  usage?: ImageUsage
  size?: string
  quality?: string
  background?: string
  output_format?: string
}

/** Validates a size: the named ones, or WxH with both sides multiples of 16, aspect 1:3–3:1, at most 3840 px. */
export function checkSize(size: string | undefined): string | undefined {
  if (!size || size === 'auto') return size
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(size)
  if (!m) throw new Error(`size must be "auto" or WIDTHxHEIGHT like 1024x1024 (got "${size}").`)
  const w = Number(m[1]), h = Number(m[2])
  if (w % 16 || h % 16) throw new Error('Image width and height must both be multiples of 16.')
  if (Math.max(w, h) > 3840) throw new Error('Image sides can be at most 3840 px.')
  if (Math.max(w, h) / Math.min(w, h) > 3) throw new Error('Image aspect ratio must be between 1:3 and 3:1.')
  return size
}

/** JSON body for POST /images/generations (GPT image models always return base64). */
export function imageGenerateBody(o: ImageOptions): Record<string, unknown> {
  if (o.background === 'transparent' && o.output_format === 'jpeg') throw new Error('A transparent background needs png or webp output.')
  return {
    model: o.model ?? DEFAULT_IMAGE_MODEL,
    prompt: o.prompt,
    ...(o.n && o.n > 1 ? { n: o.n } : {}),
    ...(o.size ? { size: checkSize(o.size) } : {}),
    ...(o.quality ? { quality: o.quality } : {}),
    ...(o.background ? { background: o.background } : {}),
    ...(o.output_format ? { output_format: o.output_format } : {})
  }
}

function parseImages(j: { data?: Array<{ b64_json?: string }>; usage?: ImageUsage; size?: string; quality?: string; background?: string; output_format?: string }): ImageResult {
  const images = (j.data ?? []).map((d) => d.b64_json).filter((b): b is string => !!b).map((b) => Buffer.from(b, 'base64'))
  if (!images.length) throw new Error('OpenAI returned no images.')
  return { images, usage: j.usage, size: j.size, quality: j.quality, background: j.background, output_format: j.output_format }
}

export async function generateImages(creds: OpenAICreds, o: ImageOptions, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<ImageResult> {
  const res = await call(creds, '/images/generations', { json: imageGenerateBody(o), signal }, fetchImpl)
  return parseImages(await res.json())
}

export interface EditInput { name: string; data: Buffer; mime: string }

/** multipart/form-data for POST /images/edits: image[] (up to 16), an optional mask (PNG with alpha, same size as the first image). */
export function imageEditForm(o: ImageOptions & { images: EditInput[]; mask?: EditInput }): FormData {
  if (!o.images.length) throw new Error('An edit needs at least one input image.')
  if (o.images.length > 16) throw new Error('At most 16 input images.')
  const f = new FormData()
  const body = imageGenerateBody({ ...o, model: o.model ?? DEFAULT_EDIT_MODEL })
  for (const [k, v] of Object.entries(body)) f.append(k, String(v))
  for (const img of o.images) f.append('image[]', new Blob([new Uint8Array(img.data)], { type: img.mime }), img.name)
  if (o.mask) f.append('mask', new Blob([new Uint8Array(o.mask.data)], { type: o.mask.mime }), o.mask.name)
  return f
}

export async function editImages(creds: OpenAICreds, o: ImageOptions & { images: EditInput[]; mask?: EditInput }, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<ImageResult> {
  const res = await call(creds, '/images/edits', { form: imageEditForm(o), signal }, fetchImpl)
  return parseImages(await res.json())
}

/** $ per 1M tokens for the GPT image models: text input, image input, image output (Pricing page). */
export const IMAGE_PRICE = { text: 5, imageIn: 8, imageOut: 30 }
/**
 * Image output tokens for one 1024×1024 image by quality (from the documented per-image prices at
 * $30/M: low $0.006, medium $0.053, high $0.211). xhigh/max aren't published: priced at 2× and 3× high.
 */
const OUT_TOKENS: Record<ImageQuality, number> = { low: 200, medium: 1770, high: 7040, auto: 7040, xhigh: 14_080, max: 21_120 }

function megapixels(size: string | undefined): number {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '')
  // auto: priced as the largest standard size.
  return m ? Math.max(1, (Number(m[1]) * Number(m[2])) / (1024 * 1024)) : 1.5
}

/** Worst-case $ for an image request before it is sent. */
export function estimateImageUsd(o: { n?: number; size?: string; quality?: ImageQuality; promptChars: number; inputImages?: number }): number {
  const n = Math.max(1, o.n ?? 1)
  const out = OUT_TOKENS[o.quality ?? 'auto'] * megapixels(o.size) * n
  const text = (o.promptChars / 3) * 1.1
  const imgIn = (o.inputImages ?? 0) * 6000
  return (out * IMAGE_PRICE.imageOut + text * IMAGE_PRICE.text + imgIn * IMAGE_PRICE.imageIn) / 1e6
}

/** $ from the usage a response reported (undefined when it reported none). */
export function imageUsageUsd(u: ImageUsage | undefined): number | undefined {
  if (!u || (u.input_tokens === undefined && u.output_tokens === undefined)) return undefined
  const text = u.input_tokens_details?.text_tokens
  const img = u.input_tokens_details?.image_tokens
  // Without the split, input is priced as image input (the higher rate).
  const input = text !== undefined || img !== undefined ? (text ?? 0) * IMAGE_PRICE.text + (img ?? 0) * IMAGE_PRICE.imageIn : (u.input_tokens ?? 0) * IMAGE_PRICE.imageIn
  return (input + (u.output_tokens ?? 0) * IMAGE_PRICE.imageOut) / 1e6
}

// ---------------------------------------------------------------- speech (text to speech)

export const TTS_MODELS = ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15', 'tts-1', 'tts-1-hd'] as const
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts'
export const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const
export type SpeechFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
/** Speech API input limit per request. */
export const TTS_MAX_CHARS = 4096

export interface SpeechOptions {
  model?: string
  voice?: string
  input: string
  instructions?: string
  response_format?: SpeechFormat
  speed?: number
}

export function speechBody(o: SpeechOptions): Record<string, unknown> {
  if (!o.input.trim()) throw new Error('Give the text to speak.')
  if (o.input.length > TTS_MAX_CHARS) throw new Error(`At most ${TTS_MAX_CHARS} characters per speech request.`)
  const model = o.model ?? DEFAULT_TTS_MODEL
  if (o.speed !== undefined && (o.speed < 0.25 || o.speed > 4)) throw new Error('speed must be between 0.25 and 4.')
  return {
    model,
    voice: o.voice ?? 'marin',
    input: o.input,
    // tts-1 and tts-1-hd ignore (reject) instructions.
    ...(o.instructions && !/^tts-1/.test(model) ? { instructions: o.instructions.slice(0, 4096) } : {}),
    ...(o.response_format ? { response_format: o.response_format } : {}),
    ...(o.speed !== undefined ? { speed: o.speed } : {})
  }
}

/** POST /audio/speech: the audio bytes. */
export async function speech(creds: OpenAICreds, o: SpeechOptions, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<Buffer> {
  const res = await call(creds, '/audio/speech', { json: speechBody(o), signal, timeoutMs: 180_000 }, fetchImpl)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * $ for speech. gpt-4o-mini-tts: $0.60/M text tokens + $12/M audio tokens (~1,250 audio tokens a minute,
 * i.e. ~$0.015/min); tts-1 $15 and tts-1-hd $30 per 1M characters. Minutes from ~12.5 characters a second.
 */
export function speechUsd(model: string, chars: number, speed = 1): number {
  if (model === 'tts-1') return (chars * 15) / 1e6
  if (model === 'tts-1-hd') return (chars * 30) / 1e6
  const minutes = chars / (750 * Math.max(0.25, speed))
  return ((chars / 3) * 0.6 + minutes * 1250 * 12) / 1e6
}

/** Splits long text at sentence (else word) boundaries into pieces the Speech API accepts. */
export function splitForSpeech(text: string, max = TTS_MAX_CHARS - 96): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const slice = rest.slice(0, max)
    let cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('\n'))
    if (cut < max * 0.5) cut = slice.lastIndexOf(' ')
    if (cut < max * 0.3) cut = max - 1
    out.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) out.push(rest)
  return out
}

/** A 24 kHz, 16-bit mono WAV around raw PCM (the Speech API's pcm format). */
export function pcmToWav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

// ---------------------------------------------------------------- transcription

export const TRANSCRIBE_MODELS = ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'] as const
export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-transcribe'
/** Only whisper-1 returns timestamps (verbose_json + timestamp_granularities[]). */
export const TIMESTAMP_MODEL = 'whisper-1'
/** Upload limit per file. */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024
export const TRANSCRIBE_EXT = new Set(['.flac', '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.ogg', '.wav', '.webm'])
/** $ per minute of audio (Pricing page). */
export const TRANSCRIBE_PER_MIN: Record<string, number> = { 'gpt-transcribe': 0.0045, 'gpt-4o-transcribe': 0.006, 'gpt-4o-mini-transcribe': 0.003, 'whisper-1': 0.006 }

export interface TranscribeOptions {
  model?: string
  file: { name: string; data: Buffer; mime: string }
  language?: string
  prompt?: string
  timestamps?: boolean
}

export interface Transcript {
  text: string
  segments?: Array<{ start: number; end: number; text: string }>
  duration?: number
  language?: string
  usage?: { type?: 'tokens' | 'duration'; seconds?: number; input_tokens?: number; output_tokens?: number }
}

export function transcribeForm(o: TranscribeOptions): FormData {
  const model = o.timestamps ? TIMESTAMP_MODEL : o.model ?? DEFAULT_TRANSCRIBE_MODEL
  const f = new FormData()
  f.append('file', new Blob([new Uint8Array(o.file.data)], { type: o.file.mime }), o.file.name)
  f.append('model', model)
  if (o.language) f.append('language', o.language)
  if (o.prompt) f.append('prompt', o.prompt.slice(0, 2000))
  if (o.timestamps) {
    f.append('response_format', 'verbose_json')
    f.append('timestamp_granularities[]', 'segment')
  } else f.append('response_format', 'json')
  return f
}

export async function transcribe(creds: OpenAICreds, o: TranscribeOptions, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<Transcript> {
  if (o.file.data.length > TRANSCRIBE_MAX_BYTES) throw new Error('Audio files can be at most 25 MB per request.')
  const res = await call(creds, '/audio/transcriptions', { form: transcribeForm(o), signal, timeoutMs: 600_000 }, fetchImpl)
  const j = (await res.json()) as { text?: string; segments?: Array<{ start: number; end: number; text: string }>; duration?: number; language?: string; usage?: Transcript['usage'] }
  return {
    text: j.text ?? '',
    ...(j.segments ? { segments: j.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) } : {}),
    ...(j.duration !== undefined ? { duration: j.duration } : {}),
    ...(j.language ? { language: j.language } : {}),
    ...(j.usage ? { usage: j.usage } : {})
  }
}

/** $ for a transcription: billed seconds when reported, else token usage (gpt-4o models), else the estimated minutes. */
export function transcribeUsd(model: string, t: Pick<Transcript, 'usage' | 'duration'> | undefined, estimatedSeconds: number): number {
  const perMin = TRANSCRIBE_PER_MIN[model] ?? 0.006
  const u = t?.usage
  if (u?.type === 'duration' && typeof u.seconds === 'number') return (u.seconds / 60) * perMin
  if (u?.type === 'tokens' && (model === 'gpt-4o-transcribe' || model === 'gpt-4o-mini-transcribe')) {
    const [i, o] = model === 'gpt-4o-transcribe' ? [2.5, 10] : [1.25, 5]
    return ((u.input_tokens ?? 0) * i + (u.output_tokens ?? 0) * o) / 1e6
  }
  return ((t?.duration ?? estimatedSeconds) / 60) * perMin
}

// ---------------------------------------------------------------- embeddings

/** Default vector sizes and $ per 1M tokens. */
export const EMBEDDING_MODELS: Record<string, { dims: number; usdPerM: number }> = {
  'text-embedding-3-small': { dims: 1536, usdPerM: 0.02 },
  'text-embedding-3-large': { dims: 3072, usdPerM: 0.13 }
}
/** Per request: at most 2048 inputs, 8192 tokens each, 300,000 tokens in all. */
export const EMBED_MAX_INPUTS = 2048

export async function embeddings(creds: OpenAICreds, model: string, input: string[], signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<{ vectors: number[][]; tokens: number }> {
  if (!input.length) return { vectors: [], tokens: 0 }
  if (input.length > EMBED_MAX_INPUTS) throw new Error(`At most ${EMBED_MAX_INPUTS} inputs per embeddings request.`)
  // Empty strings are rejected.
  const res = await call(creds, '/embeddings', { json: { model, input: input.map((s) => s || ' '), encoding_format: 'float' }, signal, timeoutMs: 120_000 }, fetchImpl)
  const j = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }>; usage?: { prompt_tokens?: number; total_tokens?: number } }
  const data = [...(j.data ?? [])].sort((a, b) => a.index - b.index)
  if (data.length !== input.length) throw new Error('OpenAI returned the wrong number of embeddings.')
  return { vectors: data.map((d) => d.embedding), tokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? 0 }
}

export const embeddingsUsd = (model: string, tokens: number): number => (tokens * (EMBEDDING_MODELS[model]?.usdPerM ?? 0.13)) / 1e6
