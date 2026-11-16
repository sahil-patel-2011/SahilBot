import type { EffortChoice, Settings, Space, Thread } from '@shared/types'
import { isAutoModel } from '@shared/model-picker'
import { KIND_WORDS, failureKind } from '../llm/model-health'

// "What the user selects is what happens": the rules for the user's own choices, in one place so they can be
// tested on their own (tests/unit/manual-choices.test.ts). The agent loop applies them.
//
//   model        a model picked by name is used for every step; it changes only when it can't be used (gone,
//                unavailable, erroring after retries), and the chat says so (fallbackNotice). A picked model
//                is never swapped for "making invalid tool calls" (only Auto's own picks are). Where it goes
//                then is Auto's fallback for the request (llm/auto-route.ts planFallback).
//   effort       a level picked for the chat, the bot or the app is sent exactly (auto-effort.ts resolveEffort);
//                Auto's mid-run bump (escalateEffort) never touches a picked level.
//   context      a model's "Context window" is used exactly, clamped only to the provider's maximum.
//   bots         a bot chooses by itself, for the best result on each request: its chats always route as Auto
//                (model) and Auto (thinking). Stored Space.model / Space.effort (older installs) and a pick made
//                in a bot's chat are ignored. The app default's Auto variant is kept (Auto (local) / Auto (cloud)
//                stay local-only / cloud-only); a concrete default model doesn't apply to bots. Helper threads
//                keep the model their orchestrator assigned. Regular chats (SahilBot's own, projects) keep the
//                composer's pick exactly.

/** Why a model couldn't be used, in a few words, from the error the provider gave. */
export function unavailableReason(err?: Error | string): string {
  const m = (typeof err === 'string' ? err : err?.message ?? '').toLowerCase()
  const status = typeof err === 'object' ? (err as { status?: unknown } | undefined)?.status : undefined
  // Out of credit before rate limits: OpenAI sends billing limits as 429 (insufficient_quota), retrying can't help.
  if (/pay-per-use api spending is turned off|cloud budget|goal budget/.test(m)) return 'over the monthly spending limit'
  if (status === 402 || /\b402\b|insufficient_quota|credit balance|out of credits?|exceeded your current quota|won't run more requests on this account/.test(m)) return 'out of API credit'
  if ((typeof err === 'object' && (err as { planLimit?: boolean } | undefined)?.planLimit) || /chatgpt plan('s)? (usage )?limit|usagelimitexceeded/.test(m)) return 'at its ChatGPT plan limit'
  if (/context window|context_length|too long for|maximum context|prompt is too long/.test(m)) return 'too long for its context window'
  if (/usage polic|content[_ ]policy|declined this request|invalid_prompt|flagged/.test(m)) return 'declined under its usage policy'
  if (/\b429\b|rate[ _-]?limit|too many requests/.test(m)) return 'rate limited'
  if (/\b529\b|overloaded|capacity/.test(m)) return 'overloaded'
  if (/cloud budget|spend(ing)? limit|monthly (cap|limit)|budget/.test(m)) return 'over the monthly spending limit'
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid (x-)?api[ _-]?key|authentication/.test(m)) return 'its API key was refused'
  if (/\b404\b|not[ _-]found|does not exist|no such model|model_not_found/.test(m)) return 'not available on this account'
  if (/timed? ?out|timeout|etimedout|econnreset|econnrefused|enotfound|network|fetch failed|socket/.test(m)) return 'not responding'
  if (/\b50[0234]\b|server error|internal error/.test(m)) return 'having a server error'
  // What the status says when the words don't (an Anthropic 404 reads "Claude rejected the request: model: …").
  const kind = typeof err === 'object' ? failureKind(err) : 'other'
  if (kind !== 'other') return KIND_WORDS[kind]
  const short = m.replace(/\s+/g, ' ').trim().slice(0, 80)
  return short ? `failed: ${short}` : 'failed'
}

/** The chat note when a fallback model answers instead of the chosen one. */
export function fallbackNotice(from: string, to: string, err?: Error | string, o: { rest?: boolean } = {}): string {
  const reason = unavailableReason(err)
  const verb = reason === 'declined under its usage policy' ? `${from} declined the request under its usage policy`
    : /^(rate limited|overloaded|not responding|not available|out of api credit|at its chatgpt|too long)/i.test(reason) || reason.startsWith('over ') || reason.startsWith('its ') ? `${from} is unavailable (${reason})`
      : `${from} ${reason.startsWith('failed') ? reason : `is ${reason}`}`
  return `${verb}; used ${to} for ${o.rest ? 'the rest of this task' : 'this reply'}.`
}

/** Whether the run's model may be swapped for a stronger one because it keeps making invalid tool calls. */
export const mayReplaceForInvalidCalls = (o: { manual?: boolean; local: boolean }): boolean => !o.manual && o.local

/** Whether Auto's mid-run effort bump may apply (never to a level the user picked). */
export const mayEscalateEffort = (choice: EffortChoice | null | undefined): boolean => !choice || choice === 'auto'

/** A chat that belongs to a bot (not SahilBot's own chats or a project): a bot, or a group of bots. */
export const isBotSpace = (space: Pick<Space, 'kind' | 'isMain'> | null | undefined): boolean =>
  !!space && ((space.kind === 'bot' && !space.isMain) || space.kind === 'group')

/** What a bot routes with: the app default when it is an Auto variant (local or cloud only), else Auto. */
export const botModel = (defaultModel: string | null | undefined): string => (defaultModel && isAutoModel(defaultModel) ? defaultModel : 'auto')

/**
 * The model a run asks for (llm/router.ts resolves Auto). Bots: always Auto. Helpers: the model they were given.
 * Regular chats: the chat's pick, else the app default.
 */
export function requestedModel(o: { thread?: Pick<Thread, 'model' | 'parentId'> | null; space?: Pick<Space, 'kind' | 'isMain'> | null; speaker?: Pick<Space, 'kind' | 'isMain'> | null; settings: Pick<Settings, 'defaultModel'> }): string {
  if (o.thread?.parentId && o.thread.model) return o.thread.model
  if (o.speaker || isBotSpace(o.space)) return botModel(o.settings.defaultModel)
  return o.thread?.model || o.settings.defaultModel
}

/**
 * The thinking a run asks for. Bots: always Auto. A chat on Auto (any Auto variant): Auto too, since SahilBot
 * picks the model and the thinking together; a level stored on the chat or as the app default (older installs,
 * or picked for a model the chat later left) never applies there. Otherwise the chat's pick, else the app's.
 */
export function requestedEffort(o: { thread?: Pick<Thread, 'effort'> & Partial<Pick<Thread, 'model' | 'parentId'>> | null; space?: Pick<Space, 'kind' | 'isMain'> | null; speaker?: Pick<Space, 'kind' | 'isMain'> | null; settings: Pick<Settings, 'thinking'> & Partial<Pick<Settings, 'defaultModel'>> }): EffortChoice {
  if (o.speaker || isBotSpace(o.space)) return 'auto'
  const model = requestedModel({ thread: o.thread ? { model: o.thread.model ?? null, parentId: o.thread.parentId ?? null } : null, space: o.space, settings: { defaultModel: o.settings.defaultModel ?? 'auto' } })
  if (isAutoModel(model)) return 'auto'
  const pick = o.thread?.effort ?? o.settings.thinking
  return pick && ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(pick) ? pick : 'auto'
}

/** Auto picks the model and the thinking: an effort stored with an Auto model means nothing and is cleared. */
export const effortFor = (model: string | null | undefined, effort: EffortChoice | null | undefined): EffortChoice | null =>
  isAutoModel(model) ? null : effort ?? null
