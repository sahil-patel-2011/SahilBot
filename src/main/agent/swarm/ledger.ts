import { AsyncLocalStorage } from 'node:async_hooks'
import { cost } from '../../llm/budget'

// Spend per swarm (one Team of Experts call, helpers of helpers included) or Heavy run. Like goals'
// checkSpend/addSpend: before a paid request the ledger reserves its price and refuses one that could
// pass the cap; after it, the reservation settles to what it cost. Helpers are also priced from their
// replies' token counts (message meta), which is how the board shows live cost and how a new helper is
// held back when the ones already running could use up the rest.

/** What one helper typically uses: a handful of agent steps, mostly cached context, one compact report. */
export const TYPICAL_HELPER = { input: 25_000, output: 1_000 }
/** A Heavy attempt writes a full answer with evidence. */
export const TYPICAL_ATTEMPT = { input: 40_000, output: 3_000 }
/** Output a single request is priced at before it is sent (the monthly cap still checks the worst case). */
const REQUEST_OUTPUT = 8_000

export const estimateFor = (model: string, cloud: boolean, typical: { input: number; output: number } = TYPICAL_HELPER): number =>
  cloud ? cost(model, typical.input, typical.output) : 0

export class SwarmLedger {
  /** Actual spend per member (the larger of what its replies report and what the spend hook saw). */
  private live = new Map<string, number>()
  private hooked = new Map<string, number>()
  /** Requests sent but not yet priced (parallel helpers). */
  private inflight: number[] = []
  /** Running members and the estimate each was launched with. */
  private launched = new Map<string, number>()
  private started = 0
  /** The cap stopped something (a launch or a request). */
  hit = false

  constructor(public readonly cap: number) {}

  spent(): number {
    let s = 0
    for (const v of this.live.values()) s += v
    return s
  }

  member(id: string): number {
    return this.live.get(id) ?? 0
  }

  private held(): number {
    let h = 0
    for (const [id, est] of this.launched) h += Math.max(0, est - this.member(id))
    return h
  }

  private pending(): number {
    return this.inflight.reduce((a, b) => a + b, 0)
  }

  /** Room for one more member estimated at `est`. The first one always starts (the request check still holds). */
  canLaunch(est: number): boolean {
    if (!this.started) return true
    const ok = this.spent() + this.pending() + this.held() + est <= this.cap + 1e-9
    if (!ok && !this.launched.size) this.hit = true
    return ok
  }

  start(id: string, est: number): void {
    this.started++
    this.launched.set(id, est)
  }

  finish(id: string): void {
    this.launched.delete(id)
  }

  /** A member's cost so far, from its replies. */
  observe(id: string, usd: number): void {
    this.live.set(id, Math.max(this.live.get(id) ?? 0, usd, this.hooked.get(id) ?? 0))
  }

  /** Before a paid request by a member: throws if it could take the swarm past its cap. */
  beforeRequest(price: number): void {
    const spent = this.spent()
    const pending = this.pending()
    if (spent + pending + price > this.cap + 1e-9) {
      this.hit = true
      // "cloud budget" in the message: the run's model fallback then carries on with a local (free) model only.
      throw new Error(`Swarm cloud budget reached: this team has used $${spent.toFixed(2)}${pending > 0 ? ` (plus about $${pending.toFixed(2)} under way)` : ''} of its $${this.cap.toFixed(2)} cap, and this request could cost about $${price.toFixed(2)}. Nothing was sent. Finish with what you have.`)
    }
    this.inflight.push(price)
  }

  /** After a paid request by a member: its reservation settles to what it cost. */
  afterRequest(id: string, usd: number): void {
    this.inflight.shift()
    this.hooked.set(id, (this.hooked.get(id) ?? 0) + usd)
    this.observe(id, 0)
  }
}

/** The swarm a request belongs to (set around each helper's run). */
export const swarmScope = new AsyncLocalStorage<{ ledger: SwarmLedger; memberId: string }>()

/** Wired into the model client's spend hooks (index.ts): paid requests made inside a swarm count toward its cap. */
export const swarmSpend = {
  before(model: string, estInput: number, maxOutput: number): void {
    const s = swarmScope.getStore()
    if (s) s.ledger.beforeRequest(cost(model, estInput, Math.min(maxOutput, REQUEST_OUTPUT)))
  },
  after(model: string, input: number, output: number): void {
    const s = swarmScope.getStore()
    if (s) s.ledger.afterRequest(s.memberId, cost(model, input, output))
  }
}

/** Cost and tokens of a thread's model replies (message meta), for the board. */
export function threadCost(messages: Array<{ role: string; model?: string | null; meta?: Record<string, unknown> }>, isCloud: (model: string) => boolean): { usd: number; tokens: number } {
  let usd = 0
  let tokens = 0
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    const p = Number(m.meta?.promptTokens) || 0
    const c = Number(m.meta?.completionTokens) || 0
    if (!p && !c) continue
    tokens += p + c
    if (m.model && isCloud(m.model)) usd += cost(m.model, p, c)
  }
  return { usd, tokens }
}
