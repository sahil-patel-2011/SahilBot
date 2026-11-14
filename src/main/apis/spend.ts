import { priceFor } from '../llm/budget'
import { spendHooks, type ChatRequest } from '../llm/client'

// Paid API calls made by tools (images, speech, transcription, embeddings, Claude vision, batches) go
// through the same spend hooks as every chat request, so the monthly cap blocks them before anything
// is sent and Settings → Usage (and goal budgets) count them.
//
// The hooks price requests in tokens of a model (budget.ts). Calls priced per token of a Claude model
// pass their real tokens. Calls priced otherwise (per image, per minute of audio, OpenAI token rates
// the budget table doesn't list) are passed as the dollar amount expressed in input tokens of their
// label at whatever rate the budget currently uses for it, so check() and record() see the right $.

/** The request the hooks see: only baseUrl (the Usage host) and the model label matter. */
function fakeReq(baseUrl: string, label: string): ChatRequest {
  return { baseUrl, model: label, messages: [], sampling: { temperature: 0, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }, maxTokens: 0 }
}

/** Input tokens of `label` that cost `usd` at the budget's current rate for it. */
export function usdAsTokens(label: string, usd: number, round: 'up' | 'nearest' = 'nearest'): number {
  const p = priceFor(label)
  const rate = p.input > 0 ? p.input : 10
  const t = (usd * 1e6) / rate
  return Math.max(0, round === 'up' ? Math.ceil(t) : Math.round(t))
}

export interface Spend {
  /** Throws (nothing is sent) if `worstUsd` could push this month past the cap. */
  beforeUsd(baseUrl: string, label: string, worstUsd: number): void
  /** Records what the call cost. */
  afterUsd(baseUrl: string, label: string, usd: number): void
  /** Token-priced (Claude) calls: worst case before, actual after. */
  beforeTokens(baseUrl: string, model: string, input: number, maxOutput: number): void
  afterTokens(baseUrl: string, model: string, input: number, output: number): void
}

/** The app's spend hooks (llm/client.ts spendHooks, wired to the Budget and goals in index.ts). */
export const hookSpend: Spend = {
  beforeUsd(baseUrl, label, worstUsd) {
    spendHooks.before?.(fakeReq(baseUrl, label), usdAsTokens(label, worstUsd, 'up'), 0, label)
  },
  afterUsd(baseUrl, label, usd) {
    // Recorded to the nearest token of the label's rate (about $0.00001 at the default rate).
    const t = usdAsTokens(label, usd)
    if (t > 0) spendHooks.after?.(fakeReq(baseUrl, label), t, 0, label)
  },
  beforeTokens(baseUrl, model, input, maxOutput) {
    spendHooks.before?.(fakeReq(baseUrl, model), input, maxOutput, model)
  },
  afterTokens(baseUrl, model, input, output) {
    if (input || output) spendHooks.after?.(fakeReq(baseUrl, model), input, output, model)
  }
}

export const money = (usd: number): string => usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`
