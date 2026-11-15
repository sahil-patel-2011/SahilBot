import type { ModelInfo } from '@shared/types'

// What a failed model call means for the models Auto may use next, and for how long (pure, no I/O).
//
// Every provider's errors are first made readable with a status (openai-responses openaiError, xai-client
// xaiError, anthropic.ts, codex PlanLimitError, budget.ts), and transient ones are retried with backoff
// (retry.ts withRetries: 429 honoring Retry-After, 5xx, dropped connections; never 402 / out of credit). When
// a call still fails, failureKind() names it and ModelHealth remembers it, so the rest of this run and later
// requests skip that model (or its whole provider) until the cooldown ends:
//
//   kind        scope                                cooldown                          retried first
//   rate-limit  the model                            Retry-After (5 s-15 min), else 60 s   yes
//   overloaded  the model (529 / 503)                2 min                             yes
//   server      the model (other 5xx)                1 min                             yes
//   quota       Anthropic, xAI: the provider (credit is account-wide). OpenAI: the model only (seen live: on
//               an account with no credit the cheap models still answered while the larger ones returned
//               insufficient_quota; a 402 is free and instant, so each model is tried at most once)  30 min  never
//   plan-limit  the ChatGPT plan                     until its reset time, else 1 h    never
//   auth        the provider (key refused)           5 min                             never
//   not-found   the model (404, model_not_found, deprecated / retired)   24 h          never
//   network     the provider (connection dropped)    30 s                              yes
//   context     none: a model with a bigger window answers instead      -              never
//   refusal     none: another provider answers (content policy)        -              never
//   budget      none: SahilBot's own monthly limit; only free models (plan, local) may answer  -  never

export type FailureKind = 'rate-limit' | 'overloaded' | 'server' | 'quota' | 'plan-limit' | 'auth' | 'not-found' | 'network' | 'context' | 'refusal' | 'budget' | 'other'

const NET = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|socket hang up|other side closed|closed before the reply finished|couldn'?t reach|network/i

/** The kind of a failed model call, from the error the provider client threw. */
export function failureKind(e: unknown): FailureKind {
  const err = (e ?? {}) as { name?: string; message?: string; status?: unknown; code?: unknown; type?: unknown; planLimit?: boolean; network?: boolean; cause?: { code?: string } }
  if (err.planLimit || err.name === 'PlanLimitError') return 'plan-limit'
  const msg = `${err.message ?? ''} ${typeof err.code === 'string' ? err.code : ''} ${typeof err.type === 'string' ? err.type : ''}`
  const s = typeof err.status === 'number' ? err.status : undefined
  // SahilBot's own limits (budget.ts, goals): nothing reached a provider.
  if (/cloud budget reached|goal budget reached|pay-per-use api spending is turned off/i.test(msg)) return 'budget'
  if (s === 402 || /insufficient_quota|credit balance|credit_balance|out of credits?|exceeded your current quota|billing_hard_limit|won't run more requests on this account/i.test(msg)) return 'quota'
  if (/usage ?limit|usageLimitExceeded|plan limit/i.test(msg) && /chatgpt|codex|plan/i.test(msg)) return 'plan-limit'
  if (s === 401 || s === 403 || /rejected the (api )?key|invalid (x-)?api[ _-]?key|unauthori[sz]ed|refused access/i.test(msg)) return 'auth'
  if (s === 404 || /model_not_found|doesn'?t offer|does not exist|no such model|deprecated|has been retired|decommissioned|doesn't know the \w+ model/i.test(msg)) return 'not-found'
  if (/context window|context_length|too long for|maximum context|prompt is too long|too many tokens/i.test(msg)) return 'context'
  if (/usage polic|content[_ ]policy|declined this request|invalid_prompt|flagged|safety system/i.test(msg)) return 'refusal'
  if (s === 429 || /rate[- _]?limit|too many requests/i.test(msg)) return 'rate-limit'
  if (s === 529 || s === 503 || /overload|capacity/i.test(msg)) return 'overloaded'
  if (s !== undefined && s >= 500) return 'server'
  if (err.network || NET.test(msg) || (err.cause?.code && /^E[A-Z]+$/.test(err.cause.code))) return 'network'
  return 'other'
}

/** What a kind blocks: one model, its whole provider, or nothing (the request itself was the problem). */
export function scopeOf(kind: FailureKind, provider: string): 'model' | 'provider' | 'none' {
  switch (kind) {
    case 'rate-limit': case 'overloaded': case 'server': case 'not-found': return 'model'
    case 'quota': return provider === 'openai' ? 'model' : 'provider'
    case 'plan-limit': case 'auth': case 'network': return 'provider'
    default: return 'none'
  }
}

/** Never worth retrying the same model: the answer would be the same. */
export const HARD: ReadonlySet<FailureKind> = new Set<FailureKind>(['quota', 'plan-limit', 'auth', 'not-found'])

const MIN = 60_000
export const COOLDOWN_MS: Record<FailureKind, number> = {
  'rate-limit': MIN, overloaded: 2 * MIN, server: MIN, quota: 30 * MIN, 'plan-limit': 60 * MIN, auth: 5 * MIN,
  'not-found': 24 * 60 * MIN, network: 30_000, context: 0, refusal: 0, budget: 0, other: 0
}

/** The cooldown for one failure (Retry-After for a rate limit, the plan's reset time for its limit). */
export function cooldownFor(kind: FailureKind, e: unknown, now: number): number {
  const err = (e ?? {}) as { retryAfterMs?: number; resetsAt?: number }
  if (kind === 'rate-limit' && typeof err.retryAfterMs === 'number') return Math.min(15 * MIN, Math.max(5_000, err.retryAfterMs))
  if (kind === 'plan-limit' && typeof err.resetsAt === 'number') {
    // resetsAt: seconds or milliseconds since the epoch, as Codex reports it.
    const at = err.resetsAt < 1e12 ? err.resetsAt * 1000 : err.resetsAt
    if (at > now) return Math.min(7 * 24 * 60 * MIN, at - now)
  }
  return COOLDOWN_MS[kind]
}

/** In words, for notes and errors. */
export const KIND_WORDS: Record<FailureKind, string> = {
  'rate-limit': 'rate limited', overloaded: 'overloaded', server: 'having a server error', quota: 'out of API credit',
  'plan-limit': 'at its ChatGPT plan limit', auth: 'its API key was refused', 'not-found': 'not available on this account',
  network: 'not responding', context: 'too long for its context window', refusal: 'declined under its usage policy',
  budget: 'over the monthly spending limit', other: 'failed'
}

interface Mark { kind: FailureKind; until: number; scope: 'model' | 'provider'; provider: string }
type Ref = Pick<ModelInfo, 'id' | 'provider'>

/** Remembered failures with cooldowns, per model and per provider. */
export class ModelHealth {
  private models = new Map<string, Mark>()
  private providers = new Map<string, Mark>()

  /** Records a failure; returns what it blocks (scope 'none': nothing remembered). */
  mark(m: Ref, e: unknown, now = Date.now()): { kind: FailureKind; scope: 'model' | 'provider' | 'none'; until?: number } {
    const kind = failureKind(e)
    const scope = scopeOf(kind, m.provider)
    if (scope === 'none') return { kind, scope }
    const until = now + cooldownFor(kind, e, now)
    const mark: Mark = { kind, until, scope, provider: m.provider }
    if (scope === 'provider') this.providers.set(m.provider, mark)
    else this.models.set(m.id, mark)
    return { kind, scope, until }
  }

  /** Why the model can't be used right now (undefined: it can). */
  blocked(m: Ref, now = Date.now()): Mark | undefined {
    const p = this.providers.get(m.provider)
    if (p && p.until > now) return p
    const x = this.models.get(m.id)
    if (x && x.until > now) return x
    return undefined
  }

  /**
   * The models that may be tried now. When every one is cooling down, the soft cooldowns (rate limits,
   * overloads, server errors, dropped connections) are ignored: the limit may well have passed. Hard ones
   * (out of credit, plan limit, key refused, model gone) always hold.
   */
  filter(models: ModelInfo[], now = Date.now()): ModelInfo[] {
    const ok = models.filter((m) => !this.blocked(m, now))
    if (ok.length || !models.length) return ok
    return models.filter((m) => { const b = this.blocked(m, now); return !b || !HARD.has(b.kind) })
  }

  /** "Claude Opus 5.5 is out of API credit, …" for the models that are blocked (undefined: none is). */
  explain(models: ModelInfo[], now = Date.now()): string | undefined {
    const parts = new Map<string, string>()
    for (const m of models) {
      const b = this.blocked(m, now)
      if (!b) continue
      const who = b.scope === 'provider' ? providerWords(m.provider) : m.label || m.id
      parts.set(who, `${who} is ${KIND_WORDS[b.kind]} (until ${new Date(b.until).toTimeString().slice(0, 5)})`)
    }
    return parts.size ? [...parts.values()].join('; ') : undefined
  }

  /** Forget everything (a key changed, or tests). */
  clear(provider?: string): void {
    if (!provider) { this.models.clear(); this.providers.clear(); return }
    this.providers.delete(provider)
    for (const [id, x] of this.models) if (x.provider === provider) this.models.delete(id)
  }
}

const providerWords = (p: string): string => ({ anthropic: 'Anthropic (Claude)', openai: 'OpenAI', xai: 'xAI (Grok)', chatgpt: 'the ChatGPT plan', openrouter: 'OpenRouter' } as Record<string, string>)[p] ?? p

/** The app's registry (the agent loop marks failures; Auto's routing reads it). */
export const modelHealth = new ModelHealth()
