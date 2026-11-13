import type { StreamPart } from './client'

// Transient failures of model calls (rate limits, overloads, dropped connections) are retried with
// exponential backoff and jitter, honoring Retry-After. Shared by the local, OpenAI-compatible,
// Ollama and Claude paths.

/** How model calls are retried on transient failures (tests shrink the delays). */
export const retryPolicy = { retries: 3, baseMs: 1000, maxMs: 16_000, maxRetryAfterMs: 60_000 }

const NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const NET_TEXT = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|^terminated$/i

/** Seconds or an HTTP date, as in Retry-After; milliseconds from now. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** Retry-After from response headers (retry-after-ms first, as some providers send it). */
export function retryAfterFrom(h: { get(name: string): string | null } | undefined): number | undefined {
  if (!h) return undefined
  const ms = Number(h.get('retry-after-ms'))
  if (h.get('retry-after-ms') && Number.isFinite(ms)) return Math.max(0, ms)
  return parseRetryAfter(h.get('retry-after'))
}

/** An HTTP error with what the retry logic needs. */
export function httpError(message: string, status: number, headers?: { get(name: string): string | null }): Error {
  return Object.assign(new Error(message), { status, retryAfterMs: retryAfterFrom(headers) })
}

/**
 * Whether a failed model call is worth retrying: rate limits (429), timeouts (408), server errors (5xx)
 * and dropped connections. Never bad requests, auth failures, budget refusals or a stop.
 */
export function retryInfo(e: unknown): { retry: boolean; afterMs?: number } {
  const err = e as { name?: string; message?: string; status?: unknown; retryAfterMs?: number; network?: boolean; code?: string; cause?: { code?: string; message?: string } } | undefined
  if (!err || err.name === 'AbortError') return { retry: false }
  if (typeof err.status === 'number') {
    const s = err.status
    return s === 408 || s === 429 || (s >= 500 && s <= 599) ? { retry: true, afterMs: err.retryAfterMs } : { retry: false }
  }
  if (err.network) return { retry: true }
  const code = err.code ?? err.cause?.code
  if (code && NET_CODES.has(code)) return { retry: true }
  if (NET_TEXT.test(err.message ?? '') || NET_TEXT.test(err.cause?.message ?? '')) return { retry: true }
  return { retry: false }
}

/** Exponential backoff with jitter, or the server's Retry-After when it gave one. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const jitter = 0.8 + Math.random() * 0.4
  if (retryAfterMs !== undefined) return Math.round(retryAfterMs + retryPolicy.baseMs * 0.1 * Math.random())
  return Math.round(Math.min(retryPolicy.maxMs, retryPolicy.baseMs * 2 ** attempt) * jitter)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('stopped', 'AbortError'))
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(t); reject(new DOMException('stopped', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Runs a model call, retrying transient failures up to retryPolicy.retries times. If the failed attempt
 * already streamed something, a 'reset' goes out first so the caller discards it. A call that finished
 * is never repeated.
 */
export async function* withRetries(open: () => AsyncGenerator<StreamPart>, signal?: AbortSignal): AsyncGenerator<StreamPart> {
  for (let attempt = 0; ; attempt++) {
    let produced = false
    let finished = false
    try {
      for await (const part of open()) {
        if (part.type === 'finish') finished = true
        else if (part.type !== 'usage') produced = true
        yield part
      }
      return
    } catch (e) {
      if (signal?.aborted || finished || attempt >= retryPolicy.retries) throw e
      const r = retryInfo(e)
      if (!r.retry || (r.afterMs !== undefined && r.afterMs > retryPolicy.maxRetryAfterMs)) throw e
      if (produced) yield { type: 'reset' }
      await sleep(backoffMs(attempt, r.afterMs), signal)
    }
  }
}
