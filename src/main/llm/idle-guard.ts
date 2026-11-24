import type { ChatRequest, StreamPart } from './client'

// An idle guard for the streams that had none: OpenAI-compatible chat completions (local servers, custom endpoints),
// xAI and Ollama. Before it, a provider that accepted the request and then sent nothing sat under undici's 300 s
// timeouts, retried three times, so a stuck Grok or local server took about 20 minutes to reach another model.
// Now nothing for the first-token limit (a model still loading or thinking gets longer locally), or a gap between
// chunks past the gap limit, ends the attempt with a network-style error: retried once (withRetries caps idle
// retries at 1), then the loop hands the task to another model (switchModel).

/** The limits (tests shrink them). */
export const idleLimits = {
  /** Cloud: nothing at all for this long after sending (thinking models stream their reasoning or keepalives). */
  cloudFirstMs: 180_000,
  /** Cloud: no new chunk for this long once the reply started. */
  cloudGapMs: 90_000,
  /** This Mac (or the LAN): a big prompt's prefill or a cold model load can take minutes. */
  localFirstMs: 300_000,
  localGapMs: 120_000
}

const secs = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`)

/** The error an idle stop throws: retryable once (network), then another model takes over. */
export function idleError(who: string, ms: number): Error {
  return Object.assign(new Error(`${who} stopped responding (nothing came for ${secs(ms)}).`), { network: true, idle: true })
}

/** Runs one streamed attempt under the idle guard: `open` gets the request with the guard's signal. */
export async function* idleGuarded(req: ChatRequest, open: (req: ChatRequest) => AsyncGenerator<StreamPart>, o: { local: boolean; who?: string }): AsyncGenerator<StreamPart> {
  const first = o.local ? idleLimits.localFirstMs : idleLimits.cloudFirstMs
  const gap = o.local ? idleLimits.localGapMs : idleLimits.cloudGapMs
  const outer = req.signal
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort(outer?.reason)
  if (outer?.aborted) ctrl.abort(outer.reason)
  else outer?.addEventListener('abort', onAbort, { once: true })
  let tripped = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { tripped = ms; ctrl.abort(new DOMException('idle', 'AbortError')) }, ms)
    timer.unref?.()
  }
  arm(first)
  try {
    for await (const part of open({ ...req, signal: ctrl.signal })) {
      // Only the provider's time counts: the clock stops while the caller handles the part.
      if (timer) clearTimeout(timer)
      if (tripped) break
      yield part
      arm(gap)
    }
    if (tripped && !outer?.aborted) throw idleError(o.who ?? req.model, tripped)
  } catch (e) {
    if (tripped && !outer?.aborted) throw idleError(o.who ?? req.model, tripped)
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}
