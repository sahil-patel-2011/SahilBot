// "ChatGPT plan (via Codex)": shared between the main process (src/main/llm/codex) and Settings → Models.

export interface PlanLimitWindow {
  /** 0–100. */
  usedPercent: number
  /** Window length in minutes (300 = 5 hours, 10080 = a week), when Codex says. */
  windowMins?: number
  /** When the window resets (ms since epoch), when Codex says. */
  resetsAt?: number
  /** "5-hour limit", "Weekly limit", … */
  label: string
}

export interface PlanModelEntry {
  /** SahilBot's model id (chatgpt-plan/…). */
  id: string
  /** Codex's model id. */
  codexId?: string
  label: string
  isDefault?: boolean
}

export interface ChatgptPlanStatus {
  /** The user switched the provider on (Connect). */
  enabled: boolean
  /** "Use my ChatGPT plan first": GPT work goes to the plan before the pay-per-token OpenAI API. */
  preferPlan: boolean
  /** Codex found on this Mac. */
  installed: boolean
  path?: string
  version?: string
  /** What `codex login status` reports. */
  login: 'chatgpt' | 'apikey' | 'accesstoken' | 'none' | 'unknown'
  /** Codex's own words for the sign-in (no secrets). */
  loginText?: string
  email?: string
  planType?: string
  /** Ready to run: enabled, installed and signed in with ChatGPT (not an API key). */
  connected: boolean
  /** A sign-in started from SahilBot is waiting for the browser. */
  signingIn: boolean
  models: PlanModelEntry[]
  limits: PlanLimitWindow[]
  /** Codex reported the plan's limit is reached: plan models sit out of Auto until then (ms since epoch). */
  limitedUntil?: number
  limitMessage?: string
  /** Something to tell the user (not installed, signed in with an API key, a failed check). */
  problem?: string
  checkedAt: number
  installUrl: string
}

export interface ChatgptPlanApi {
  status(refresh?: boolean): Promise<ChatgptPlanStatus>
  /** Turns the provider on; signs in through Codex's own ChatGPT login when needed (signIn: even over an API-key login). */
  connect(o?: { signIn?: boolean }): Promise<ChatgptPlanStatus>
  /** Opens Terminal running `codex login` (OpenAI's own sign-in, outside SahilBot). */
  loginInTerminal(): Promise<{ ok: boolean; error?: string }>
  disconnect(): Promise<ChatgptPlanStatus>
  setPrefs(patch: { preferPlan?: boolean; codexPath?: string | null }): Promise<ChatgptPlanStatus>
  openInstallGuide(): Promise<void>
}
