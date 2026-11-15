import type { EffortChoice } from '@shared/types'

// "What the user selects is what happens": the rules for the user's own choices, in one place so they can be
// tested on their own (tests/unit/manual-choices.test.ts). The agent loop applies them.
//
//   model        a model picked by name is used for every step; it changes only when it can't be used (gone,
//                unavailable, erroring after retries), and the chat says so (fallbackNotice). A picked model
//                is never swapped for "making invalid tool calls" (only Auto's own picks are).
//   effort       a level picked for the chat, the bot or the app is sent exactly (auto-effort.ts resolveEffort);
//                Auto's mid-run bump (escalateEffort) never touches a picked level.
//   context      a model's "Context window" is used exactly, clamped only to the provider's maximum.

/** Why a model couldn't be used, in a few words, from the error the provider gave. */
export function unavailableReason(err?: Error | string): string {
  const m = (typeof err === 'string' ? err : err?.message ?? '').toLowerCase()
  if (/\b429\b|rate[ _-]?limit|too many requests/.test(m)) return 'rate limited'
  if (/\b529\b|overloaded|capacity/.test(m)) return 'overloaded'
  if (/cloud budget|spend(ing)? limit|monthly (cap|limit)|budget/.test(m)) return 'over the monthly spending limit'
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid (x-)?api[ _-]?key|authentication/.test(m)) return 'its API key was refused'
  if (/\b404\b|not[ _-]found|does not exist|no such model|model_not_found/.test(m)) return 'not available on this account'
  if (/timed? ?out|timeout|etimedout|econnreset|econnrefused|enotfound|network|fetch failed|socket/.test(m)) return 'not responding'
  if (/\b50[0234]\b|server error|internal error/.test(m)) return 'having a server error'
  const short = m.replace(/\s+/g, ' ').trim().slice(0, 80)
  return short ? `failed: ${short}` : 'failed'
}

/** The chat note when a fallback model answers instead of the chosen one. */
export function fallbackNotice(from: string, to: string, err?: Error | string, o: { rest?: boolean } = {}): string {
  const reason = unavailableReason(err)
  const verb = /^(rate limited|overloaded|not responding|not available)/.test(reason) || reason.startsWith('over ') || reason.startsWith('its ') ? `${from} is unavailable (${reason})` : `${from} ${reason.startsWith('failed') ? reason : `is ${reason}`}`
  return `${verb}; used ${to} for ${o.rest ? 'the rest of this task' : 'this reply'}.`
}

/** Whether the run's model may be swapped for a stronger one because it keeps making invalid tool calls. */
export const mayReplaceForInvalidCalls = (o: { manual?: boolean; local: boolean }): boolean => !o.manual && o.local

/** Whether Auto's mid-run effort bump may apply (never to a level the user picked). */
export const mayEscalateEffort = (choice: EffortChoice | null | undefined): boolean => !choice || choice === 'auto'
