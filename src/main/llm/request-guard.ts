// Bounds on one model request that runs server-side tools (Claude's web search / fetch, OpenAI's built-in web
// search). Inside such a request the provider searches, reads and (for Claude's dynamic filtering) runs code on its
// own servers, so one request can stream for a long time and run up search fees with nothing on SahilBot's side in
// between. Live (2026-11-18): one Opus request with server web search streamed for many minutes. The bounds:
//   - max_uses / max_tool_calls per request (claude-native/server.ts, openai-responses.ts), and across Claude's
//     pause_turn continuations a budget for the whole turn (turnSearches / turnFetches) instead of max_uses for
//     every continuation (5 x 8 searches before);
//   - an idle limit: nothing at all streamed for idleMs (a stalled connection);
//   - a wall-clock limit for the whole request (continuations included): wallMs.
// A request stopped by a limit fails with a clear message and is never retried or handed to another model (the
// same request would run just as long); between continuations the turn ends with what it found instead.

/** The limits (tests shrink them). */
export const requestLimits = {
  /** Nothing streamed for this long: the request is stopped (thinking deltas and tool blocks all count). */
  idleMs: 6 * 60_000,
  /** One request, continuations included, never runs longer than this. */
  wallMs: 15 * 60_000,
  /** Claude: web searches / fetches for one turn across its pause_turn continuations. */
  turnSearches: 24,
  turnFetches: 30,
  /** OpenAI: built-in tool calls in one response when the account won't take max_tool_calls (it is dropped then). */
  openaiServerCalls: 24
}

export type GuardStop = 'idle' | 'wall' | 'searches'

const minutes = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(ms / 1000))} seconds`)

/** A request stopped by one of the limits: a clear message, never retried (no status, not a network error). */
export function capError(stop: GuardStop, o: { who: string; searches?: number; limit?: number }): Error {
  const found = o.searches ? ` (${o.searches} web search${o.searches === 1 ? '' : 'es'} so far)` : ''
  const message = stop === 'idle'
    ? `Stopped this request: ${o.who} sent nothing for ${minutes(requestLimits.idleMs)}, so the connection looks stuck. Try again, or ask for a smaller step.`
    : stop === 'wall'
      ? `Stopped this request after ${minutes(requestLimits.wallMs)}: ${o.who} was still working on a single reply${found}. Ask for a narrower piece, or split the task into steps.`
      : `Stopped this request: ${o.who} ran ${o.searches ?? o.limit} web searches in one reply, over the limit of ${o.limit}. Ask for a narrower search.`
  return Object.assign(new Error(message), { requestCap: stop, billed: true })
}

/**
 * One request's guard: its signal aborts on the caller's stop, on the idle limit (touch() on every streamed event)
 * or on the wall-clock limit. `stopped` says which limit fired (undefined: none, or the caller stopped it).
 */
export class RequestGuard {
  private ctrl = new AbortController()
  private idle?: ReturnType<typeof setTimeout>
  private wall?: ReturnType<typeof setTimeout>
  private start = Date.now()
  stopped?: GuardStop
  /** Built-in tool calls seen in this request so far (OpenAI). */
  serverCalls = 0
  constructor(outer?: AbortSignal, private limits: Pick<typeof requestLimits, 'idleMs' | 'wallMs'> = requestLimits) {
    if (outer?.aborted) this.ctrl.abort(outer.reason)
    else outer?.addEventListener('abort', () => this.ctrl.abort(outer.reason), { once: true })
    this.wall = setTimeout(() => this.trip('wall'), limits.wallMs)
    this.wall.unref?.()
    this.touch()
  }
  get signal(): AbortSignal { return this.ctrl.signal }
  /** Something streamed: the idle clock starts over. */
  touch(): void {
    if (this.idle) clearTimeout(this.idle)
    if (this.ctrl.signal.aborted) return
    this.idle = setTimeout(() => this.trip('idle'), this.limits.idleMs)
    this.idle.unref?.()
  }
  elapsed(): number { return Date.now() - this.start }
  /** Most of the wall-clock limit is used: don't start another continuation. */
  nearWall(): boolean { return this.elapsed() >= this.limits.wallMs * 0.8 }
  /** Stops the request for a limit of the caller's own (too many searches). */
  trip(stop: GuardStop): void {
    if (this.ctrl.signal.aborted) return
    this.stopped = stop
    this.ctrl.abort(new DOMException(`request limit: ${stop}`, 'AbortError'))
  }
  done(): void {
    if (this.idle) clearTimeout(this.idle)
    if (this.wall) clearTimeout(this.wall)
  }
}
