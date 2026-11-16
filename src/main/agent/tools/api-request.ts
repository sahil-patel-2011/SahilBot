import type { Vault } from '../../vault'
import type { ToolDef } from '../types'

/** A capability by name: the model never receives credentials, including from an echoed response. */
export function apiRequestTool(vault: Vault, fetcher: typeof fetch = fetch): ToolDef<{
  action: 'list' | 'request'; key?: string; url?: string; method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown
}> {
  return {
    name: 'api_request', label: 'Service API', group: 'Connected services', untrusted: true,
    effect: (a) => a.action === 'list' || !a.method || ['GET', 'HEAD'].includes(a.method) ? 'read' : 'write_external',
    hardStop: (a) => a.action === 'request' ? 'Use a saved login API key for this service request' : null,
    describe: (a) => a.action === 'list' ? 'List saved service API keys by name' : `${a.method ?? 'GET'} ${a.url} using the saved key “${a.key}”`,
    description: 'Use service REST APIs with a named API key from the encrypted Vault. list returns names, exact allowed origins and auth headers only. request needs the key name, HTTPS URL and optional method/JSON body. Each request needs approval; the backend injects the key, blocks redirects and masks echoed secrets. First read official API docs with fetch_page; never guess endpoints or put secret values into arguments, code, memory, or knowledge notes. Add keys in Settings → Privacy & Security → API Keys.',
    parameters: { type: 'object', properties: { action: { enum: ['list', 'request'] }, key: { type: 'string' }, url: { type: 'string', maxLength: 4000 }, method: { enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }, body: {} }, required: ['action'], additionalProperties: false },
    async run(a, ctx) {
      if (a.action === 'list') { const data = vault.apiKeys(); return { text: JSON.stringify(data), data, display: `${data.length} service keys` } }
      if (!ctx.approved) throw new Error('Approve the service request before using a saved API key.')
      if (!a.key || !a.url) throw new Error('Choose a saved key and service URL.')
      const method = a.method ?? 'GET'
      if (a.body !== undefined && ['GET', 'HEAD'].includes(method)) throw new Error('GET and HEAD requests cannot have a body.')
      const body = a.body === undefined ? undefined : JSON.stringify(a.body)
      if (body && body.length > 64_000) throw new Error('Keep each request body below 64 KB.')
      await vault.ensureUnlocked('Use your saved API key for this approved service request')
      return vault.withApiKey(a.key, a.url, async (header, value, redact) => {
        const response = await fetcher(a.url!, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), [header]: value }, body, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) })
        const reader = response.body?.getReader(), chunks: Uint8Array[] = []
        let length = 0
        if (reader) try {
          for (;;) { const { done, value: part } = await reader.read(); if (done) break; length += part.length; if (length > 128_000) throw new Error('Response exceeds 128 KB; use the service’s pagination or narrower fields.'); chunks.push(part) }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
        const text = redact(Buffer.concat(chunks).toString('utf8'))
        let result: unknown = text
        // JSON escapes can conceal an echoed credential from raw-text redaction. Decode first,
        // then scrub every string and object key while the credential is still in this closure.
        const scrub = (v: unknown): unknown => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, value]) => [redact(k), scrub(value)])) : v
        try { result = JSON.parse(text) } catch { /* Some service endpoints return plain text. */ }
        result = scrub(result)
        const data = { status: response.status, ok: response.ok, body: result }
        return { text: JSON.stringify(data), data, display: `${method} · ${response.status}` }
      })
    }
  }
}
