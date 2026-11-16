import { signedHeaders } from './onshape-sign'
import { DEFAULT_ORIGIN, onshapeOrigin } from './onshape-url'

// A small Onshape REST client: HMAC-signed requests (onshape-sign.ts), JSON or binary responses, 307
// redirects signed again (credentials are only ever sent to an onshape.com host), one short retry on a
// rate limit, and errors that say what to fix.
//
// API version: the public OpenAPI spec (https://cad.onshape.com/api/openapi, checked 2026-11-14) lists
// https://cad.onshape.com/api/v17 as "Current", and the docs say to always call the latest version
// (no version means the oldest, v0). Every endpoint used here is in that spec.

export const ONSHAPE_API_VERSION = 'v17'
/** Onshape's documented JSON media type. */
export const JSON_ACCEPT = 'application/json;charset=UTF-8; qs=0.09'
export const JSON_CONTENT = 'application/json'
export const KEYS_URL = 'https://dev-portal.onshape.com/keys'

export interface OnshapeKeys { accessKey: string; secretKey: string }

export interface ClientOptions {
  keys: () => OnshapeKeys | undefined
  fetchImpl?: typeof fetch
  /** Tests only: send every request to this origin (a local fake server) instead of onshape.com. */
  testOrigin?: string
  apiVersion?: string
  /** Waits between retries and translation polls (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  now?: () => Date
}

export interface RequestOptions {
  /** The document's stack (https://cad.onshape.com or https://<company>.onshape.com). */
  origin?: string
  query?: Record<string, string | number | boolean | string[] | undefined>
  /** A raw, already-encoded query fragment to append (e.g. Onshape's own "configuration=..."). */
  rawQuery?: string
  body?: unknown
  /** 'json' (default) or 'binary' (exports, images). */
  as?: 'json' | 'binary'
  accept?: string
  signal?: AbortSignal
}

export interface OnshapeResponse<T = unknown> {
  status: number
  data: T
  bytes?: Buffer
  contentType?: string
}

export class OnshapeError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterS?: number) {
    super(message)
    this.name = 'OnshapeError'
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A message for an Onshape error status that says what to do about it. */
export function explainStatus(status: number, detail: string, retryAfterS?: number): string {
  const d = detail ? ` Onshape said: ${detail.slice(0, 400)}` : ''
  switch (status) {
    case 400: return `Onshape rejected the request (400 Bad Request).${d} Check the ids, parameter names and values (read the element first to see what it has).`
    case 401: return `Onshape did not accept the API keys (401 Unauthorized).${d} Fix: in Settings → Models & Keys → Advanced → Keys for tools (Onshape), paste a valid access key and secret key (create them at ${KEYS_URL}). Keys only work on the stack they were made on (cad.onshape.com vs a company's <name>.onshape.com), and signed requests need this Mac's clock within 5 minutes of the real time.`
    case 402: return `This Onshape account has used up its annual API call allowance (402).${d} Fix: wait for the plan's yearly reset or ask the team's Onshape admin about the limit; only successful calls count against it.`
    case 403: return `Onshape refused access (403 Forbidden).${d} Fix: make sure the document is shared with the account that owns the API keys, and that the key has the needed scope at ${KEYS_URL} (reading needs Read; changes need Write, and edit access to the document).`
    case 404: return `Onshape could not find that (404 Not Found).${d} Fix: check the document URL and ids (copy the URL from the browser with the right tab open); the element may have been deleted, belong to another workspace, or be a different kind (a Part Studio action on an assembly, for example).`
    case 409: return `Onshape reported a conflict (409).${d} Fix: re-read the element and try again with values that don't duplicate existing ones.`
    case 429: return `Onshape's rate limit was hit (429 Too Many Requests).${retryAfterS !== undefined ? ` Wait about ${retryAfterS} s before trying again.` : ' Wait a minute before trying again.'} Fix: make fewer calls (read a whole element once instead of many small calls).`
    case 500: case 502: case 503: case 504: return `Onshape had a server problem (${status}).${d} Try again in a minute; if it keeps failing, Onshape's status page may show an outage.`
    default: return `Onshape returned HTTP ${status}.${d}`
  }
}

function buildQuery(q: RequestOptions['query'], raw?: string): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q ?? {})) {
    if (v === undefined || v === '') continue
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x))
    else p.append(k, String(v))
  }
  const s = p.toString()
  const extra = (raw ?? '').replace(/^[?&]+/, '')
  return [s, extra].filter(Boolean).join('&')
}

export class OnshapeClient {
  private fetch: typeof fetch
  private sleep: (ms: number) => Promise<void>
  readonly version: string

  constructor(private o: ClientOptions) {
    this.fetch = o.fetchImpl ?? fetch
    this.sleep = o.sleep ?? defaultSleep
    this.version = o.apiVersion ?? ONSHAPE_API_VERSION
  }

  /** Keys are saved (both halves). */
  hasKeys(): boolean {
    const k = this.o.keys()
    return !!(k?.accessKey && k.secretKey)
  }

  /** The full request URL for an API path like "/documents/<did>". */
  url(path: string, opts: Pick<RequestOptions, 'origin' | 'query' | 'rawQuery'> = {}): string {
    const origin = this.o.testOrigin ?? (opts.origin && onshapeOrigin(new URL(opts.origin).hostname)) ?? DEFAULT_ORIGIN
    const q = buildQuery(opts.query, opts.rawQuery)
    return `${origin}/api/${this.version}${path.startsWith('/') ? path : `/${path}`}${q ? `?${q}` : ''}`
  }

  /** May this URL carry our signed credentials? Only an onshape.com host (or the test server). */
  private trusted(url: string): boolean {
    const u = new URL(url)
    if (this.o.testOrigin) return u.origin === new URL(this.o.testOrigin).origin
    return u.protocol === 'https:' && !!onshapeOrigin(u.hostname)
  }

  async request<T = unknown>(verb: 'GET' | 'POST' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<OnshapeResponse<T>> {
    let method = verb
    const keys = this.o.keys()
    if (!keys?.accessKey || !keys.secretKey) {
      throw new OnshapeError(`Onshape API keys aren't set up yet. Ask the user to create an API key pair at ${KEYS_URL} (Read scope to look at CAD; Write scope too for changes) and paste the access key and secret key in Settings → Models & Keys → Advanced → Keys for tools (Onshape), then press Test.`, 0)
    }
    let url = this.url(path, opts)
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const accept = opts.accept ?? (opts.as === 'binary' ? 'application/octet-stream' : JSON_ACCEPT)
    let retried = false
    for (let hop = 0; hop < 5; hop++) {
      const signal = AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(this.o.timeoutMs ?? 90_000)])
      const headers: Record<string, string> = { Accept: accept }
      if (this.trusted(url)) Object.assign(headers, signedHeaders({ method, url, contentType: JSON_CONTENT, accessKey: keys.accessKey, secretKey: keys.secretKey, now: this.o.now?.() }))
      else if (body !== undefined) headers['Content-Type'] = JSON_CONTENT
      let res: Response
      try {
        res = await this.fetch(url, { method, headers, body: method === 'POST' ? body : undefined, redirect: 'manual', signal })
      } catch (e) {
        if (opts.signal?.aborted) throw new OnshapeError('Stopped.', 0)
        const msg = (e as Error).message || String(e)
        throw new OnshapeError(/timeout|aborted/i.test(msg) ? 'Onshape took too long to answer. Try again; for big exports or assemblies, try one Part Studio at a time.' : `Could not reach Onshape (${msg}). Check the internet connection.`, 0)
      }
      // Redirects (exports, images): sign again for the new URL, as Onshape's docs require.
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url).toString()
        if (res.status === 303) method = 'GET'
        continue
      }
      if (res.status === 429 && !retried) {
        const after = Number(res.headers.get('retry-after'))
        if (Number.isFinite(after) && after >= 0 && after <= 5) {
          retried = true
          await this.sleep(after * 1000)
          continue
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let detail = text
        try { const j = JSON.parse(text) as { message?: string }; if (j && typeof j.message === 'string') detail = j.message } catch { /* not JSON */ }
        const ra = Number(res.headers.get('retry-after'))
        throw new OnshapeError(explainStatus(res.status, detail.replace(/\s+/g, ' ').trim(), Number.isFinite(ra) && res.headers.get('retry-after') ? ra : undefined), res.status, Number.isFinite(ra) ? ra : undefined)
      }
      const contentType = res.headers.get('content-type') ?? undefined
      if (opts.as === 'binary') {
        const bytes = Buffer.from(await res.arrayBuffer())
        return { status: res.status, data: undefined as T, bytes, contentType }
      }
      const text = await res.text()
      let data: unknown = undefined
      if (text) { try { data = JSON.parse(text) } catch { throw new OnshapeError(`Onshape sent a reply that isn't JSON (${text.slice(0, 120)}).`, res.status) } }
      return { status: res.status, data: data as T, contentType }
    }
    throw new OnshapeError('Onshape redirected too many times.', 0)
  }

  get<T = unknown>(path: string, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('GET', path, opts).then((r) => r.data)
  }

  post<T = unknown>(path: string, body: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('POST', path, { ...opts, body }).then((r) => r.data)
  }

  /** DELETE (a feature or a tab); the tools only call it after the user approved that exact deletion. */
  del<T = unknown>(path: string, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('DELETE', path, opts).then((r) => r.data)
  }

  /** Waits for a translation (export) to finish: polls GET /translations/{id} with a gentle backoff. */
  async waitForTranslation(id: string, opts: { origin?: string; signal?: AbortSignal; timeoutMs?: number; onPoll?: (state: string, n: number) => void } = {}): Promise<TranslationInfo> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
    let delay = 1000
    for (let n = 1; ; n++) {
      const t = await this.get<TranslationInfo>(`/translations/${encodeURIComponent(id)}`, { origin: opts.origin, signal: opts.signal })
      opts.onPoll?.(t.requestState ?? '?', n)
      if (t.requestState === 'DONE') return t
      if (t.requestState === 'FAILED') throw new OnshapeError(`Onshape could not export it: ${t.failureReason || 'no reason given'}. Fix the model's errors (red features) or try another format.`, 0)
      if (Date.now() > deadline) throw new OnshapeError(`The export is still running after ${Math.round((opts.timeoutMs ?? 300_000) / 60_000)} minutes. Try again later or export a smaller element.`, 0)
      if (opts.signal?.aborted) throw new OnshapeError('Stopped.', 0)
      await this.sleep(delay)
      delay = Math.min(5000, Math.round(delay * 1.5))
    }
  }
}

export interface TranslationInfo {
  id: string
  requestState?: 'ACTIVE' | 'DONE' | 'FAILED'
  failureReason?: string
  resultExternalDataIds?: string[]
  resultElementIds?: string[]
  resultDocumentId?: string
  documentId?: string
  name?: string
}
