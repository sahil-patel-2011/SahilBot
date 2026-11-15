// "ChatGPT plan (via Codex)": SahilBot runs model steps on the user's ChatGPT plan through their own,
// signed-in Codex (OpenAI's official CLI / app-server). See docs/chatgpt-plan.md.

import { chatgptPlan } from './plan'
import { isCodexUrl, isPlanModel } from './ids'

export { chatgptPlan, ChatgptPlan } from './plan'
export { closeAll, openSessions, PlanLimitError, streamCodex } from './session'
export * from './ids'

/**
 * For routing and the spending limit: the ChatGPT plan can take requests right now (switched on,
 * Codex installed and signed in with ChatGPT, not over the plan's limit). Stable hook; cheap, no I/O.
 */
export const codexAvailable = (): boolean => chatgptPlan.available()

/**
 * How a model or endpoint is billed. 'plan': the user's ChatGPT subscription (no per-token charge;
 * SahilBot records its usage at $0, host "chatgpt-plan"). Anything else is left to budget.ts.
 */
export const billingOf = (modelOrUrl: string): 'plan' | undefined => (isPlanModel(modelOrUrl) || isCodexUrl(modelOrUrl) ? 'plan' : undefined)
