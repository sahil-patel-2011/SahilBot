// Names for the "ChatGPT plan (via Codex)" provider. Pure: imported by budget, endpoints and the client.
//
// A plan model is listed as "chatgpt-plan/<codex model id>" (chatgpt-plan/gpt-6.1-sol). The prefix keeps
// it apart from the same model on the pay-per-token OpenAI API ("gpt-…" goes to api.openai.com), and the
// routing table reads the part after the slash (routing-table bareId) so Auto treats it like that GPT role.

/** Prefix of every model served through the user's ChatGPT plan. */
export const PLAN_PREFIX = 'chatgpt-plan/'
/** Codex's own default model (whatever Codex picks for the signed-in plan). */
export const PLAN_DEFAULT = `${PLAN_PREFIX}default`
/** The pseudo base URL plan models live at: never fetched; llm/client routes it to the Codex runner. */
export const CODEX_URL = 'codex://chatgpt-plan'
/** Provider id (shared ProviderId). */
export const PLAN_PROVIDER = 'chatgpt' as const
export const PLAN_PROVIDER_NAME = 'ChatGPT plan (via Codex)'

export const isPlanModel = (id: string | null | undefined): boolean => !!id && id.startsWith(PLAN_PREFIX)
export const isCodexUrl = (baseUrl: string | null | undefined): boolean => !!baseUrl && baseUrl.trim().replace(/\/+$/, '') === CODEX_URL
/** "chatgpt-plan/gpt-6.1-sol" → "gpt-6.1-sol"; the default entry → undefined (Codex chooses). */
export function codexModelOf(id: string): string | undefined {
  const m = id.startsWith(PLAN_PREFIX) ? id.slice(PLAN_PREFIX.length) : id
  return !m || m === 'default' ? undefined : m
}
export const planModelId = (codexModel: string): string => `${PLAN_PREFIX}${codexModel}`

/** Official install guide (OpenAI's Codex CLI docs). */
export const CODEX_INSTALL_URL = 'https://developers.openai.com/codex/cli'
