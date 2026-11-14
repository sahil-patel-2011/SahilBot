import { retryAfterFrom } from '../llm/retry'

// One error shape for the OpenAI and Anthropic API clients, so tools can tell the user (and the model)
// exactly what went wrong: a bad or missing key, a rate limit, no credit left, a content policy block,
// a bad request, or the service being down. `billed: false` means nothing reached a paid model.

export type ApiErrorKind = 'auth' | 'permission' | 'rate_limit' | 'quota' | 'content_policy' | 'bad_request' | 'too_large' | 'not_found' | 'server' | 'network' | 'aborted'

export class ApiError extends Error {
  readonly name = 'ApiError'
  constructor(
    message: string,
    readonly provider: 'OpenAI' | 'Anthropic',
    readonly kind: ApiErrorKind,
    readonly status?: number,
    /** The provider's own error code (e.g. "moderation_blocked", "insufficient_quota"). */
    readonly code?: string,
    readonly retryAfterMs?: number,
    /** False: the request was refused before any work was done, so it isn't charged. */
    readonly billed = false
  ) {
    super(message)
  }
}

const KEY_HINT = (p: string): string => `Check the ${p} key in Settings → API Keys & Servers.`

/** Plain-English text for each kind (the provider's own message is appended when it helps). */
function explain(provider: 'OpenAI' | 'Anthropic', kind: ApiErrorKind, detail: string, retryAfterMs?: number): string {
  const d = detail ? ` (${detail.slice(0, 300)})` : ''
  switch (kind) {
    case 'auth': return `${provider} rejected the API key${d}. ${KEY_HINT(provider)}`
    case 'permission': return `This ${provider} key isn't allowed to use that model or feature${d}. Your organization may need verification or access to it.`
    case 'rate_limit': return `${provider} is rate-limiting requests right now${d}.${retryAfterMs !== undefined ? ` Try again in about ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s.` : ' Wait a minute and try again.'}`
    case 'quota': return `Your ${provider} account is out of credit or over its spending limit${d}. Add credit or raise the limit in the ${provider} console; nothing was charged here.`
    case 'content_policy': return `${provider}'s safety system blocked this request${d}. Change the prompt or input; retrying the same request will be blocked again.`
    case 'too_large': return `The request is too large for ${provider}${d}. Use a smaller or shorter input.`
    case 'not_found': return `${provider} couldn't find that${d}.`
    case 'bad_request': return `${provider} refused the request${d}.`
    case 'server': return `${provider} had a server problem${d}. Try again in a few minutes.`
    case 'network': return `Couldn't reach ${provider}${d}. Check the internet connection.`
    case 'aborted': return 'Stopped.'
  }
}

/** OpenAI error body: { error: { message, type, code, param, moderation_details? } }. */
export function openaiError(status: number, body: string, headers?: { get(name: string): string | null }): ApiError {
  let message = ''
  let type = ''
  let code = ''
  let stage = ''
  try {
    const j = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string | null; moderation_details?: { moderation_stage?: string; categories?: string[] } } }
    message = j.error?.message ?? ''
    type = j.error?.type ?? ''
    code = j.error?.code ?? ''
    const md = j.error?.moderation_details
    if (md) stage = [md.moderation_stage ? `stage: ${md.moderation_stage}` : '', md.categories?.length ? `categories: ${md.categories.join(', ')}` : ''].filter(Boolean).join('; ')
  } catch {
    message = body.slice(0, 300)
  }
  const retryAfterMs = retryAfterFrom(headers)
  let kind: ApiErrorKind
  if (code === 'moderation_blocked' || code === 'content_policy_violation' || (type === 'image_generation_user_error' && /moderat|safety|policy/i.test(message)) || /safety system|content policy/i.test(message)) kind = 'content_policy'
  else if (status === 401) kind = 'auth'
  else if (status === 403) kind = 'permission'
  else if (status === 429) kind = code === 'insufficient_quota' || /quota|billing/i.test(message) ? 'quota' : 'rate_limit'
  else if (status === 413) kind = 'too_large'
  else if (status === 404) kind = 'not_found'
  else if (status >= 500) kind = 'server'
  else kind = 'bad_request'
  const detail = [message, stage].filter(Boolean).join(' — ')
  return new ApiError(explain('OpenAI', kind, detail, retryAfterMs), 'OpenAI', kind, status, code || type || undefined, retryAfterMs)
}

/** A failed fetch (offline, DNS, refused) or a stop. */
export function networkError(provider: 'OpenAI' | 'Anthropic', e: unknown): ApiError {
  const err = e as { name?: string; message?: string; cause?: { message?: string } }
  if (err?.name === 'AbortError') return new ApiError('Stopped.', provider, 'aborted')
  if (err?.name === 'TimeoutError') return new ApiError(`${provider} took too long to answer. Try again.`, provider, 'network')
  return new ApiError(explain(provider, 'network', err?.cause?.message ?? err?.message ?? ''), provider, 'network')
}

/** Errors thrown by @anthropic-ai/sdk (APIError subclasses carry status, error body and headers). */
export function anthropicError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  const err = e as { status?: number; name?: string; message?: string; headers?: { get(name: string): string | null }; error?: { error?: { type?: string; message?: string } } }
  if (err?.name === 'APIUserAbortError' || err?.name === 'AbortError') return new ApiError('Stopped.', 'Anthropic', 'aborted')
  const status = typeof err?.status === 'number' ? err.status : undefined
  if (status === undefined) return networkError('Anthropic', e)
  const type = err.error?.error?.type ?? ''
  const message = err.error?.error?.message ?? err.message ?? ''
  const retryAfterMs = retryAfterFrom(err.headers)
  let kind: ApiErrorKind
  if (status === 401 || type === 'authentication_error') kind = 'auth'
  else if (status === 403 || type === 'permission_error') kind = 'permission'
  else if (status === 429 || type === 'rate_limit_error') kind = 'rate_limit'
  else if (status === 402 || type === 'billing_error' || /credit balance/i.test(message)) kind = 'quota'
  else if (status === 413 || type === 'request_too_large') kind = 'too_large'
  else if (status === 404 || type === 'not_found_error') kind = 'not_found'
  else if (status >= 500 || type === 'overloaded_error' || type === 'api_error') kind = 'server'
  else kind = 'bad_request'
  return new ApiError(explain('Anthropic', kind, message, retryAfterMs), 'Anthropic', kind, status, type || undefined, retryAfterMs)
}
