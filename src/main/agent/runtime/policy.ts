import { AsyncLocalStorage } from 'node:async_hooks'
import type { RunPhase, TaskPolicy } from './store'

export class TaskMeter {
  private apiReservations = new Map<string, Array<() => void>>()
  spentUsd = 0
  reservedUsd = 0
  calls = 0
  phase: RunPhase = 'plan'
  constructor(readonly policy: TaskPolicy, readonly now: () => number = Date.now) {}
  check(usd = 0): void {
    if (this.policy.deadlineAt && this.now() >= this.policy.deadlineAt) throw new Error('Task deadline reached. Work is checkpointed; report what remains.')
    const cap = this.policy.maxUsd
    // Keep 15% for checking the result. Verification can use the entire remaining cap.
    const usable = cap === undefined ? Infinity : this.phase === 'verify' ? cap : cap * 0.85
    if (this.spentUsd + this.reservedUsd + usd > usable + 1e-9) throw new Error('Task budget reached. Work is checkpointed; report what remains.')
  }
  beforeCall(): void {
    this.check()
    if (this.policy.maxCalls !== undefined && this.calls >= this.policy.maxCalls) throw new Error('Task tool-call limit reached. Work is checkpointed; report what remains.')
    this.calls++
  }
  reserve(usd: number): () => void {
    this.check(usd); this.reservedUsd += usd; let released = false
    return () => { if (!released) { released = true; this.reservedUsd = Math.max(0, this.reservedUsd - usd) } }
  }
  reserveApi(key: string, usd: number): void {
    const release = this.reserve(usd)
    this.apiReservations.set(key, [...(this.apiReservations.get(key) ?? []), release])
  }
  settleApi(key: string, usd: number): void {
    const pending = this.apiReservations.get(key)
    pending?.shift()?.()
    if (!pending?.length) this.apiReservations.delete(key)
    this.spentUsd += usd
  }
  parallel(desired: number, estimateUsd = 0): number {
    const left = this.policy.maxUsd === undefined ? Infinity : Math.max(0, this.policy.maxUsd * 0.85 - this.spentUsd - this.reservedUsd)
    return Math.max(1, Math.min(desired, this.policy.parallel ?? desired, estimateUsd > 0 ? Math.floor(left / estimateUsd) : desired))
  }
}
/** Children, summaries and paid tool APIs inherit the same task budget. */
export const taskScope = new AsyncLocalStorage<TaskMeter>()

export function recoveryPlan(tool: string, error: string, effect: string): { kind: string; instruction: string; retry: boolean } {
  if (/401|403|sign.?in|oauth|not connected|expired.*token|needs.auth/i.test(error)) return { kind: 'connect', instruction: 'Find this app with find_tools or connect_app to show its Connect / Sign in tile. Resume after the user connects; do not ask for credentials in chat.', retry: false }
  if (/429|rate.?limit|503|502|temporar|ECONNRESET|timed? ?out/i.test(error)) return { kind: 'transient', instruction: effect === 'read' ? 'Retry a read once; if it still fails, switch to another authorized data source.' : 'The action may have happened. Read its state or receipt before any retry.', retry: effect === 'read' }
  if (/not found|404|stale|detached|no such element/i.test(error)) return { kind: 'stale', instruction: 'Refresh the listing, page snapshot or object identity, then use the current identifier. Do not guess a replacement.', retry: false }
  return { kind: 'alternate', instruction: `Stop repeating ${tool}. Diagnose the error, then try a different authorized interface (connector, browser or computer) and verify the result.`, retry: false }
}
