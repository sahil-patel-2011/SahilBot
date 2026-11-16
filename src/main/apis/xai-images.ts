import type { ImageResult, OpenAICreds } from './openai'

// https://docs.x.ai/developers/model-capabilities/images/generation
// https://docs.x.ai/developers/models/grok-imagine-image-2.0 (checked 2026-11-16)
export const XAI_IMAGE_MODEL = 'grok-imagine-image-2.0'

export function xaiImageOptions(size?: string, quality?: string): { aspect_ratio: string; resolution: '1k' | '2k'; quality: 'low' | 'medium'; unitUsd: number } {
  let aspect_ratio = 'auto', resolution: '1k' | '2k' = '1k'
  if (size && size !== 'auto') {
    const m = /^(\d{2,4})x(\d{2,4})$/.exec(size)
    if (!m || !Number(m[1]) || !Number(m[2])) throw new Error('Image size must be auto or WIDTHxHEIGHT.')
    const w = Number(m[1]), h = Number(m[2])
    const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '21:9', '5:2']
    const match = ratios.find((r) => { const [a, b] = r.split(':').map(Number); return Math.abs(w / h - a / b) < 0.001 })
    if (!match || Math.max(w, h) > 3840) throw new Error('Grok image generation needs a supported aspect ratio, such as 1024x1024, 1536x1024 or 1024x1536, with sides at most 3840.')
    aspect_ratio = match
    if (Math.max(w, h) > 1536) resolution = '2k'
  }
  // Pin auto explicitly so budget estimates cannot drift with a server-side auto default.
  const q = quality === 'medium' || quality === 'high' ? 'medium' : 'low'
  return { aspect_ratio, resolution, quality: q, unitUsd: (resolution === '2k' ? 0.06 : 0.04) + (q === 'medium' ? 0.02 : 0) }
}

export async function generateXaiImages(c: OpenAICreds, prompt: string, n: number, options: ReturnType<typeof xaiImageOptions>, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ImageResult> {
  const { unitUsd: _price, ...config } = options
  const res = await fetchImpl(`${c.baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify({ model: XAI_IMAGE_MODEL, prompt, n, response_format: 'b64_json', ...config }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
  })
  // Never return provider bodies (which may echo request data) or download provider-supplied URLs.
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Grok image generation failed (${res.status}). Check the xAI key, credits and content restrictions.`) }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('Grok returned an empty image response.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 96 * 1024 * 1024) throw new Error('Grok image response exceeded the size limit.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: Array<{ b64_json?: string; respect_moderation?: boolean }> }
  if (!Array.isArray(json.data) || !json.data.length || json.data.length > n) throw new Error('Grok returned no usable images.')
  const images = json.data.map((item) => {
    if (item.respect_moderation === false || typeof item.b64_json !== 'string' || !item.b64_json.length) throw new Error('Grok returned a filtered or empty image.')
    const image = Buffer.from(item.b64_json, 'base64')
    if (image.length < 3 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) throw new Error('Grok returned an unsupported image format; expected JPEG.')
    return image
  })
  return { images, output_format: 'jpeg', size: `${config.resolution} ${config.aspect_ratio}`, quality: config.quality }
}
