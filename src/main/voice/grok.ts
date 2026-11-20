import { fromWav } from './audio'
import { OpenAISttEngine } from './stt'
import type { TtsEngine } from './tts'
import type { OpenAICreds } from '../apis/openai'

/** Grok's REST speech services use the xAI key. The conversation itself runs through the chat's agent. */
export function grokSpeech(o: {
  credentials: () => OpenAICreds | undefined
  before: (model: string, usd: number) => void
  after: (model: string, usd: number) => void
  fetch?: typeof fetch
}): { ears: OpenAISttEngine; voice: TtsEngine } {
  async function request(endpoint: string, body: FormData | string, signal: AbortSignal): Promise<Response> {
    const creds = o.credentials()
    if (!creds) throw new Error('Enable xAI and add its API key in Models & Keys to use Grok voice.')
    const headers: Record<string, string> = { Authorization: 'Bearer ' + creds.apiKey }
    if (typeof body === 'string') headers['Content-Type'] = 'application/json'
    const response = await (o.fetch ?? fetch)(creds.baseUrl + '/' + endpoint, { method: 'POST', headers, body, signal })
    if (!response.ok) throw new Error('Grok voice returned ' + response.status)
    return response
  }
  const ears = new OpenAISttEngine({
    guard: (seconds) => o.before('grok-stt', seconds * 0.1 / 3600),
    charged: (seconds) => o.after('grok-stt', seconds * 0.1 / 3600),
    transcribe: async (file, _prompt, signal) => {
      const body = new FormData()
      body.set('file', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name)
      const response = await request('stt', body, signal)
      const result = await response.json()
      if (typeof result.text !== 'string') throw new Error('Grok returned an invalid transcript.')
      return { text: result.text }
    }
  })
  const voice: TtsEngine = {
    name: 'Grok voice',
    async warm() {},
    async synth(text) {
      const usd = Array.from(text).length * 15 / 1_000_000
      o.before('grok-tts', usd)
      const response = await request('tts', JSON.stringify({ text, language: 'auto', voice_id: 'eve', output_format: { codec: 'wav' } }), AbortSignal.timeout(30_000))
      o.after('grok-tts', usd)
      const wav = response.headers.get('content-type')?.includes('application/json')
        ? Buffer.from((await response.json()).audio, 'base64') : Buffer.from(await response.arrayBuffer())
      const { samples, rate } = fromWav(wav)
      return { audio: samples, rate }
    }
  }
  return { ears, voice }
}
