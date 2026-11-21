// Types shared by the main process, preload bridge and renderer.

export type Role = 'system' | 'user' | 'assistant' | 'tool'
/**
 * How much a chat may do on its own. 'ask': every change asks. 'auto' (the default): local changes, routine
 * outside steps, project commands (installs from the lockfile, git fetch/pull) and backed-up overwrites in your
 * folders run; hard stops (money, credentials, deleting your data, mass sends, public posts, your "always ask"
 * exceptions) and outside actions steered by web or email content ask. 'bypass': everything runs, except
 * purchases, saved logins and one-time codes. 'autonomous' is Auto's old name (read as Auto).
 */
export type PermissionMode = 'ask' | 'auto' | 'autonomous' | 'bypass'
export type ToolEffect = 'read' | 'write_local' | 'write_external' | 'destructive'
export type MessageStatus = 'streaming' | 'done' | 'error' | 'stopped'
export type MessageKind = 'normal' | 'compacted' | 'error' | 'notice'

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string exactly as the model produced it. */
  arguments: string
  /**
   * Set when Claude called one of its native tool types (llm/claude-native): the member it called, and
   * an error when that call can't be expressed with SahilBot's tool (answered without running anything).
   */
  native?: { kind: 'computer' | 'editor' | 'bash' | 'alias'; member: string; error?: string }
}

export interface Message {
  id: string
  threadId: string
  role: Role
  content: string
  reasoning?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  kind: MessageKind
  /** data: URLs for images attached by the user or produced by tools (screenshots). */
  images?: string[]
  model?: string
  status: MessageStatus
  createdAt: number
  meta?: Record<string, unknown>
}

export type BotShape = 'mascot' | 'blob' | 'drop' | 'square' | 'pebble' | 'star' | 'triangle' | 'circle' | 'hex'

/** A Space is a bot: its own personality, look and conversation. Groups hold several bots. */
export interface Space {
  id: string
  name: string
  color: string
  shape: BotShape
  kind: 'bot' | 'group' | 'project'
  isMain: boolean
  /** Projects: the folder the project works in. */
  folder: string | null
  pinned: boolean
  hidden: boolean
  /** For groups: member bot ids, in speaking order. */
  members: string[]
  /** Model override for this bot; null = the app default. */
  model: string | null
  /** Thinking override for this bot ('auto' or a level); null = the app default. */
  effort?: EffortChoice | null
  /** One-line label under the bot's name ("Add a label"). */
  label?: string | null
  /** Desktop notifications when this bot finishes or needs you (default on). */
  notify?: boolean
  createdAt: number
  /** Derived for the sidebar. */
  lastPreview?: string
  lastAt?: number
  unread?: boolean
  /** Replies you haven't seen across the bot's chats (capped at 99; see shared/read-state.ts). */
  unreadCount?: number
  /** Where this bot executes. A pending move keeps this copy inactive. */
  placement?: { label: string; moving?: boolean; inactive?: boolean }
}

export interface Thread {
  id: string
  spaceId: string
  title: string
  pinned: boolean
  unread: boolean
  permissionMode: PermissionMode
  model: string | null
  /** Thinking chosen for this chat ('auto' or a level); null = the bot's, else the app default. */
  effort?: EffortChoice | null
  createdAt: number
  updatedAt: number
  lastPreview?: string
  /** Set on a helper agent's thread: the chat that started it. */
  parentId?: string | null
  /** Read up to here (ms, the main process's clock): replies after it are unread. Same on every device. */
  lastReadAt?: number
  /** Replies after lastReadAt (capped at 99). `unread` is also true when you marked the chat unread. */
  unreadCount?: number
  /** How the agent runs here: 'chat' (only conversation so far) or 'full' (it has done real work); unset = never ran / older chat. */
  toolMode?: 'chat' | 'full'
}

export interface Sampling {
  temperature: number
  top_p: number
  top_k: number
  min_p: number
  presence_penalty: number
  repeat_penalty: number
}

/** Model servers that can be on at the same time; each model is routed to the one that serves it. */
export type ProviderId = 'ollama' | 'lmstudio' | 'custom' | 'anthropic' | 'openai' | 'openrouter' | 'chatgpt' | 'xai' | 'grok-plan'

export interface ProviderSettings {
  ollama: { enabled: boolean; baseUrl: string }
  lmstudio: { enabled: boolean; baseUrl: string }
  /** Any other OpenAI-compatible server (llama.cpp, vLLM, another Mac). */
  custom: { enabled: boolean; baseUrl: string; name: string }
  /** Override for OpenAI-compatible gateways; empty = api.openai.com. */
  openai: { baseUrl: string }
}

export interface Appearance {
  /** compact: steps collapse into one line; detailed: steps open by default. */
  density: 'compact' | 'detailed'
  /** Max width of the conversation column, px. */
  chatWidth: number
  codeWrap: boolean
  /** Tint hue 0-360 and how strongly it is applied, 0-100. */
  hue: number
  tint: number
  reduceTransparency: boolean
  /** Base UI font size, px. */
  fontSize: number
}

/** Models for jobs other than the main conversation. '' = pick automatically. */
export interface TaskModels {
  /** Real-time voice conversations: a light, fast model. */
  voice: string
  /** Chat titles and other tiny background jobs. */
  background: string
}

export interface CustomRule {
  id: string
  /** Plain words matched against the action, e.g. "send email", "run npm install", "click Buy". */
  when: string
  action: 'allow' | 'ask'
}

export type CollaborationStatus = 'queued' | 'working' | 'done' | 'unavailable' | 'stopped'
export type CollaborationRole = 'lead' | 'planner' | 'partner' | 'reviewer' | 'specialist'
export interface CollaborationStep {
  id: string
  role: CollaborationRole
  model: string
  status: CollaborationStatus
}

export interface Settings {
  /** Fallback endpoint for models no provider claims (and the legacy single-server setting). */
  baseUrl: string
  /** Stored encrypted; the renderer only ever sees `hasApiKey` / `keys`. */
  hasApiKey: boolean
  providers: ProviderSettings
  /** Which providers can be used: a key saved in the Keychain and the provider not switched off. */
  keys: Record<Exclude<ProviderId, 'chatgpt' | 'xai' | 'grok-plan'>, boolean> & Partial<Record<'chatgpt' | 'xai' | 'grok-plan', boolean>>
  /** Which providers have a key saved, switched on or off (Settings → Models & Keys shows these as saved). */
  keysSaved?: Partial<Record<ProviderId, boolean>>
  /** Cloud providers switched off in Settings: their models aren't used, and their keys stay saved. */
  disabledProviders?: ProviderId[]
  grokPlan?: { enabled: boolean; preferSubscriptions: boolean }
  /**
   * Hybrid compute (Settings → Privacy & Security → Hybrid compute): off until the user turns it on, on a Mac
   * with 32 GB memory and 50 GB free disk. Then the Privacy Gate (PII-Tracer on this Mac) checks every cloud
   * request in chats that have local and cloud models.
   */
  /**
   * Hybrid compute and the Privacy Gate. mode: 'ask' pauses on a card (default); 'auto' protects on its own
   * (stand-ins for the cloud, the Mac keeps the details) and says so. (Details the user said aren't personal are
   * kept by main under their own key, never in Settings, which windows and a paired phone can read.)
   */
  hybridCompute?: { enabled: boolean; mode?: 'ask' | 'auto' }
  /** A Cursor API key is saved: Cursor is connected (Cloud Agents). */
  hasCursorKey: boolean
  /** Also run Cursor's agent through its CLI on this Mac (off by default: Cursor connects by API key, for Cloud Agents). */
  cursorLocalAgent?: boolean
  /** The Blue Alliance read key (FRC scouting), kept in the Keychain. */
  hasTbaKey?: boolean
  /** An NCBI API key (PubMed, faster and steadier medical research), kept in the Keychain. */
  hasNcbiKey?: boolean
  /** 'auto' routes each request to the right model for how hard it is. */
  defaultModel: string
  /** Models switched off on the Models page (hidden from the picker and from Auto). */
  hiddenModels: string[]
  /** Models added by name on the Models page. */
  customModels: string[]
  taskModels: TaskModels
  appearance: Appearance
  /** Bots pinned to the top of the sidebar; null = just the main bot. */
  pinnedBots: string[] | null
  /** Read every reply aloud. */
  speakReplies: boolean
  /** Global shortcut for Quick Ask ('' = off). */
  quickKey: string
  /** Thinking level (Low, Medium, High, Extra, Max). Medium by default; adapts to each problem. */
  /** Thinking for chats that don't choose their own: 'auto' (default) picks per request; a level is used exactly. */
  thinking: EffortChoice
  /**
   * Cloud models: on/off without removing keys. Hybrid: a local model may consult a cloud model for a
   * plan, best practices, or when it's stuck (capped per request; the monthly budget still applies).
   */
  cloud: {
    enabled: boolean; hybrid: boolean
    /** Hybrid advisor: '' = best Opus, 'opus' / 'sonnet' = best of that family, or a model id. */
    advisorModel: string
    maxConsultsPerRequest: number
    /** Auto: 'local' (default) tries local models first at each tier; 'cloud' tries cloud models first (Haiku → Sonnet → Opus). */
    prefer?: 'local' | 'cloud'
    /** Claude: how much of the model's 1M window a chat uses before compacting ('balanced' = 400K by default). */
    contextStrategy?: 'max' | 'balanced' | 'economy'
    /** Claude: present SahilBot's tools through Claude's native tool types (default on). */
    nativeTools?: boolean
    /** Auto may use Claude Fable for the hardest tier (default off: Fable only when picked by name). */
    fableForHardest?: boolean
    /** What Auto aims for (Settings → Models): 'best' (default) the strongest model for each task, 'balanced' the cheapest strong enough, 'cheapest' one step cheaper (docs/model-routing.md). */
    autoPrefers?: 'best' | 'balanced' | 'cheapest'
  }
  /** 0 = Auto: the largest window that fits this Mac's memory with the model (agents get more room). */
  contextWindow: 0 | 16384 | 32768 | 65536 | 131072
  /** Models switched on by hand even though they're tight on memory. */
  shownModels: string[]
  /** Per-model overrides. Missing keys fall back to the model-card preset. */
  sampling: Record<string, Partial<Sampling>>
  theme: 'system' | 'light' | 'dark'
  userName: string
  /** The user's own email addresses and phone numbers (Settings → General): bots may always message them without asking. */
  me?: { emails: string[]; phones: string[] }
  workspaceDir: string
  search: { provider: 'auto' | 'none' | 'brave' | 'searxng' | 'duckduckgo'; searxngUrl: string; hasBraveKey: boolean }
  advanced: {
    /** A password, API key or card pasted into a chat is saved to the vault by itself (default on). */
    autoSaveSecrets?: boolean
    hardStopsEnabled: boolean
    /** Offer Bypass (Full access) in the composer's autonomy picker (default off). */
    allowBypass?: boolean
    /** Run terminal commands under a macOS sandbox that refuses writes outside your folders unless you approved the command (default on). */
    sandboxCommands?: boolean
    /** Developer mode: the chat shows the model behind each reply, thinking, every step, tokens and cost (default off). */
    devMode?: boolean
    /** Animate clicks in SahilBot's browser when its panel is visible. */
    animateBrowser?: boolean
    /** Files anywhere: SahilBot reads and edits files anywhere in your home folder without asking (default on). Deleting still asks; system, private and secret places stay off limits. */
    filesAnywhere?: boolean
  }
  /** First-run setup finished. */
  onboarded: boolean
  /** Hard monthly cap (USD) on cloud model spending; local models are free and unaffected. */
  cloudBudgetUsd: number
  /** The user's own approval rules: "When SahilBot wants to …, it should allow automatically / ask first". Ask first wins. */
  customRules?: CustomRule[]
  // ---- Always on (Settings → General). Optional so older saved settings and test fixtures still type-check;
  // SettingsStore.get() always fills them in.
  /** Menu bar icon with what's working and who needs you (default on). */
  menuBarIcon?: boolean
  /** Open SahilBot when you log in, with its window hidden (default off). */
  openAtLogin?: boolean
  /** Keep the Mac from idle-sleeping while a chat or routine is running (default on). */
  keepAwakeWhileWorking?: boolean
  /**
   * Keep working with the lid closed (off by default): while a chat, bot or routine runs and 5 minutes after,
   * the Mac doesn't sleep even with the lid shut (main/lid-awake.ts; needs an administrator once).
   */
  lidAwake?: boolean
  /** Routines missed while SahilBot was closed or the Mac slept run once on launch/wake if due within this many hours (0 = never catch up). */
  catchUpHours?: number
  /** "Pause all routines" from the menu bar icon: no routine fires until resumed. */
  routinesPaused?: boolean
  /** How long a local model stays loaded after a message (Ollama keep_alive: '30m', '2h', or seconds; '-1' = always). */
  localKeepAlive?: string
  /** Learning while the app is open and idle (Settings → Memory → Learned). */
  learning?: LearningSettings
  /** Autonomy level new chats start in (never 'bypass'). Default 'auto'. */
  defaultMode?: PermissionMode
  /** Per-bot autonomy level for its new chats (bot id → level; never 'bypass'). */
  botModes?: Record<string, PermissionMode>
}

/** Always-on status for Settings → General (main process view). */
export interface AlwaysOnStatus {
  /** macOS login item state: 'requires-approval' means the user must allow it in System Settings → General → Login Items. */
  loginItem: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found' | 'unsupported'
  /** This launch was started by logging in (the window stayed hidden). */
  openedAtLogin: boolean
  /** Chats running right now (routines included). */
  working: number
  /** The Mac is being kept awake for that work. */
  keepingAwake: boolean
  /** The menu bar icon is showing. */
  menuBarIcon: boolean
  routinesPaused: boolean
}

/** A chat whose run was cut off by SahilBot closing or crashing (it shows a Continue button on its notice). */
export interface InterruptedRun {
  threadId: string
  /** The notice message carrying meta.interrupted (render a Continue button on it while meta.resumable is true). */
  noticeId: string
  startedAt: number
  at: number
}

export type Tier = 0 | 1 | 2 | 3

/** How hard the model thinks. Adaptive: the level is a center point that shifts with how hard the request is. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** A thinking level, or 'auto': the app picks one for each request from the task (llm/auto-effort.ts). */
export type EffortChoice = Effort | 'auto'

export interface ModelInfo {
  id: string
  provider: ProviderId
  providerName: string
  /** Shown in the picker and used by Auto (not switched off on the Models page). */
  enabled: boolean
  /** On this Mac / available from the provider. Recommended models not yet downloaded are false. */
  installed: boolean
  /** How capable it is, for Auto: 0 instant, 1 light, 2 standard, 3 heavy. */
  tier: Tier
  /** Quality within its tier (higher is better). */
  rank?: number
  /** One line for the Models page. */
  blurb?: string
  /** Ollama tag to download it with. */
  pull?: string
  tools?: boolean
  /** Bytes of weights on disk, when the server reports it. */
  sizeBytes?: number
  /** Human label from the catalog, if known. */
  label?: string
  vision: boolean
  /** RAM needed at the configured context window, in GB. */
  requiredGB: number
  /** Largest context window (from the 16k/32k/64k/128k set) that fits; 0 = does not fit at all. */
  maxFittingWindow: number
  fits: boolean
  note?: string
  /** Cloud models: the model's real context window and output cap, in tokens (when known). */
  contextTokens?: number
  maxOutputTokens?: number
  /** Cloud models: $ per 1M tokens (what the budget estimator charges). */
  price?: { input: number; output: number; cacheRead?: number }
  /** The price is an estimate (a model newer than SahilBot's table, or a provider without published rates here). */
  priceEstimated?: boolean
}

export interface ModelList {
  ok: boolean
  error?: string
  models: ModelInfo[]
  /** Which servers answered, for Settings. */
  providers?: Array<{ id: ProviderId; name: string; ok: boolean; error?: string; count: number }>
  budgetGB: number
  totalGB: number
}

export interface SystemInfo {
  totalGB: number
  chip: string
  platform: string
  appVersion: string
}

export interface PendingRequest {
  id: string
  threadId: string
  kind: 'approval' | 'question' | 'connect' | 'questions' | 'plan' | 'purchase' | 'otp' | 'privacy'
  /** For 'privacy': personal details PII-Tracer found before a cloud request (the Privacy Gate card). */
  privacy?: import('./privacy').PrivacyGateInfo
  /** For 'otp': which one-time code is about to be filled where (never the code itself). */
  otp?: OtpInfo
  /** For 'purchase': what the browser is about to buy, read by main from the page (never from the model). */
  purchase?: PurchaseInfo
  /** For 'questions': several clarifying questions answered together. */
  questions?: Array<{ question: string; options?: string[] }>
  /** For 'plan': the plan waiting for approval. */
  plan?: { goal: string; steps: string[]; assumptions?: string[]; risks?: string[] }
  /** For connect requests: the catalog entry to offer. */
  preset?: ConnectorPreset
  tool?: string
  label?: string
  effect?: ToolEffect
  /** Pretty-printed arguments for the approval card. */
  args?: string
  /** What the call will do, in words. */
  summary?: string
  reason?: string
  question?: string
  options?: string[]
  /** A file outside your folders: the folder "Always allow" opens for this chat (approvals). */
  folder?: string
}

export type ApprovalAnswer = 'once' | 'always' | 'deny'

/** What a memory is: about the user (profile, preference, person, location…), a decision they made, a rule to follow, or a dated work-log entry. */
export type MemoryKind = 'profile' | 'work' | 'preference' | 'person' | 'location' | 'project' | 'trip' | 'link' | 'date' | 'rule' | 'fact' | 'worklog' | 'decision'

export interface MemoryItem {
  id: string
  category: MemoryKind
  content: string
  /** null = shared (about you, every bot sees it); otherwise the bot or project it belongs to. */
  spaceId: string | null
  /** Same as spaceId (older name). */
  projectId: string | null
  /** 'chat' = saved by a bot while talking, 'you' = added in Settings, 'import' = imported from another assistant, 'learned' = learned while the app was idle. */
  source: 'chat' | 'you' | 'import' | 'learned'
  /** 'untrusted': saved after reading outside content (a web page, email, another app or bot); kept with that bot only. */
  provenance?: 'trusted' | 'untrusted'
  createdAt: number
  updatedAt: number
}

/** Import preview: one candidate memory per entry of the pasted export (src/main/memory-import.ts). */
export interface MemoryImportPreview {
  items: Array<{
    content: string
    category: MemoryKind
    /** The export section it came from: instructions, identity, career, projects, preferences, other. */
    section?: import('./memory-import').ImportSection
    /** The source date (YYYY-MM-DD), or null when the other assistant didn't know it. */
    date?: string | null
    /** From the Instructions section: saved as a rule every chat follows. */
    asRule?: boolean
  }>
  duplicates: number
  skipped: number
  /** Left out for safety (secrets redacted from the text), with the reason. */
  dropped?: Array<{ text: string; why: string }>
  /** What the other assistant said: complete (true), not complete (false), or nothing (null). */
  complete?: boolean | null
  structured?: boolean
  truncated?: boolean
}

/** A procedure the agent learned (or you wrote): when to use it and the steps that work. */
export interface Skill {
  name: string
  description: string
  body: string
  /** 'learned' = saved by SahilBot after a task; 'you' = written or edited by you; 'builtin' = ships with the app. */
  source: 'learned' | 'you' | 'builtin'
  updatedAt: number
  uses: number
  category?: string
  /** Learned from a run with outside content nearby: not in the skill index or usable until you approve it. */
  untrusted?: boolean
}

/** A standing instruction the agent always follows. */
export interface Rule {
  name: string
  text: string
  /** 'everywhere', 'bot:<id>' or 'project:<id>'. */
  scope: string
  category: string
  enabled: boolean
  source: 'builtin' | 'you' | 'learned'
}

export interface BrowserState {
  tabs: Array<{ index: number; url: string; title: string; loading: boolean }>
  active: number
  canGoBack: boolean
  canGoForward: boolean
  /** The agent is acting right now: show the overlay. */
  controlling: boolean
  /** The user took over; agent browser actions are refused until they hand back. */
  takenOver: boolean
  /** "Teach a task": a recording of the user's own browser steps, while one is running or awaiting Done. */
  teach?: TeachState
  /** "Save login for <site> to Vault?" after the user signed in (or paid) by hand. Metadata only. */
  saveOffer?: VaultSaveOffer
}

/** One recorded step of "Teach a task" (values of secret fields are never recorded: text is ‹secret›). */
export interface TeachStep {
  kind: 'navigate' | 'history' | 'click' | 'type' | 'select' | 'key' | 'tab' | 'download'
  /** ms since the recording started */
  at: number
  /** 1-based tab number */
  tab?: number
  url?: string
  /** navigate: typed in the address bar, caused by the previous action, or by the page itself */
  cause?: 'address' | 'action' | 'page'
  inPage?: boolean
  /** history: back | forward | reload; tab: new | switch | close */
  op?: 'back' | 'forward' | 'reload' | 'new' | 'switch' | 'close'
  role?: string
  /** accessible name of the element, or the field's label */
  name?: string
  /** a stable CSS-ish selector hint (for the bot to cross-check; refs are found by snapshot) */
  selector?: string
  /** typed text or chosen option */
  text?: string
  secret?: boolean
  checked?: boolean
  key?: string
  title?: string
  filename?: string
  /** host of the iframe the step happened in (absent for the main page) */
  frame?: string
  inputType?: string
  autocomplete?: string
}

export interface TeachState {
  status: 'recording' | 'stopped'
  /** who started it: the Teach button, or a bot through the browser tool */
  by: 'user' | 'agent'
  startedAt: number
  stoppedAt?: number
  steps: number
  /** the last few steps, human-readable */
  recent: string[]
  /** set when the recording stopped itself at a cap */
  limit?: 'time' | 'steps'
  /** agent recordings: what the bot asked to be shown, and its chat */
  name?: string
  threadId?: string
}

// ---- Site playbooks (src/main/sites): what SahilBot learned about a website, per registrable domain.
// Derived from the agent's own browser actions and Teach recordings; page text is data, never steps.
// Never holds secrets or personal data (typed values, codes, card numbers, emails are never stored).

/** A named page of a site and how it was reached. */
export interface SitePage { name: string; path: string; how?: string; seen: number; lastSeen: number }
/** A reliable element locator: role + accessible name (never CSS), where it was used, how often. */
export interface SiteLocator { role: string; label: string; page?: string; uses: number; lastUsed: number }
/** A step list that worked (or was shown in a Teach recording), with success and failure counts. */
export interface SiteFlow {
  name: string
  steps: string[]
  successes: number
  failures: number
  firstSeen: number
  lastSuccess?: number
  lastFailure?: number
  /** 'model' = written by SahilBot with the sites tool (shown as "added by SahilBot"); 'user' = the user's own. */
  source: 'run' | 'teach' | 'user' | 'model'
}
export type SitePitfallKind = 'cookie' | 'popup' | 'covered' | 'human_check' | 'rate_limit' | 'error' | 'stale' | 'disabled' | 'no_change' | 'tip'
export interface SitePitfall { kind: SitePitfallKind; text: string; count: number; lastSeen: number; source: 'run' | 'teach' | 'user' | 'model' }
export interface SiteLogin {
  /** password (a saved login), sso (another site signs you in), none, or unknown */
  method: 'password' | 'sso' | 'none' | 'unknown'
  /** The saved login's name in Settings > Vault (never the secret itself). */
  savedLogin?: string
  /** SSO provider, e.g. "Google". */
  sso?: string
  twoFactor?: 'authenticator' | 'email' | 'sms' | 'unknown'
  loginPath?: string
  /** Where the signed-in session lives: SahilBot's browser panel, or the user's own browser. */
  where?: 'sahilbot' | 'user-browser'
  verified?: number
  /** Set by SahilBot with the sites tool (not learned from a run or written by the user). */
  by?: 'model'
}
export interface SitePlaybook {
  version: 1
  /** Registrable domain (eTLD+1, Public Suffix List), or an IP / single-label host. */
  domain: string
  /** The site's own name as its pages title it ("Acme Portal"). */
  siteName?: string
  /** What the user uses this site for (set by the user, or summarized from flows). */
  purpose?: string
  hosts: string[]
  login?: SiteLogin
  pages: SitePage[]
  locators: SiteLocator[]
  flows: SiteFlow[]
  pitfalls: SitePitfall[]
  /** The user's own notes (or SahilBot's, when notesBy is 'model'). */
  notes?: string
  /** Who wrote the purpose and notes: 'model' = SahilBot with the sites tool. Unset = the user. */
  purposeBy?: 'user' | 'model'
  notesBy?: 'user' | 'model'
  visits: number
  /** Last time a flow on this site worked end to end. */
  lastVerified?: number
  createdAt: number
  updatedAt: number
}
export interface SitePlaybookSummary { domain: string; siteName?: string; purpose?: string; flows: number; pages: number; visits: number; lastVerified?: number; updatedAt: number }

export interface VaultEntry {
  name: string
  origin: string
  username: string
  /** An authenticator (TOTP) key is saved with this login (the key itself stays in the Keychain). */
  hasTotp?: boolean
  /** Issuer from the otpauth link, for Settings. */
  totpIssuer?: string
  /** Also type this login on the site's subdomains (opt-in; never across a public suffix like github.io). */
  subdomains?: boolean
}

/** A one-time code about to be typed into a sign-in page; the card never shows the code. */
export interface OtpInfo {
  /** The page's origin (scheme + host): grants are kept per origin. */
  site: string
  source: 'authenticator' | 'email' | 'sms'
  login?: string
  /** For codes from email or texts: who sent the message the code comes from, and a snippet (code hidden). */
  sender?: string
  snippet?: string
  /** The sender isn't the site's own domain: approving also confirms this sender for this site. */
  unverifiedSender?: boolean
  nonce: string
  readyAt: number
  expiresAt: number
}

/** A saved payment card as Settings sees it. The number, CVV, expiry and name live in the Keychain. */
export interface CardEntry {
  id: string
  nickname: string
  brand: string
  last4: string
  /** Read from the Keychain for Settings only (never sent to a model). */
  expMonth: number
  expYear: number
  holder: string
  /** Id of a saved address used as the billing address. */
  billing?: string
  hasCvc: boolean
}

/** Saving a card: number and cvc are only sent when typed (left out on edit = keep the saved one). */
export interface CardInput {
  id?: string
  nickname: string
  number?: string
  cvc?: string
  expMonth: number | string
  expYear: number | string
  holder: string
  billing?: string
  /** Forget the saved security code (the default is not to keep one: SahilBot asks for it each time). */
  clearCvc?: boolean
}

/** A saved shipping or billing address (stored encrypted; the model only sees its nickname). */
export interface AddressEntry {
  id: string
  nickname: string
  name: string
  line1: string
  line2?: string
  city: string
  region?: string
  postal: string
  country: string
  phone?: string
  email?: string
  /** Settings list: "City, Region, Country" (the full address is shown only on Reveal). */
  summary?: string
}

// ---------------------------------------------------------------- secrets vault (src/main/secure)

export type VaultItemType = 'login' | 'card' | 'identity' | 'note' | 'address'

/** What Settings may know about a vault item: never a secret value. */
export interface VaultItemSummary {
  apiHeader?: string
  apiScheme?: 'bearer' | 'raw'
  id: string
  type: VaultItemType
  name: string
  /** Sites it may be filled on (logins: one; IDs: an optional allow-list). */
  sites?: string[]
  subdomains?: boolean
  /** Standing rule: sign in on this site without an approval card. */
  autoFill?: boolean
  usernameHint?: string
  hasTotp?: boolean
  totpIssuer?: string
  brand?: string
  last4?: string
  expMonth?: number
  expYear?: number
  hasCvc?: boolean
  billing?: string
  kind?: string
  summary?: string
  updated: number
}

/** Saving any item from Settings. Secret fields are sent once, straight to main; empty on edit = keep. */
export interface VaultItemInput {
  apiHeader?: string
  apiScheme?: 'bearer' | 'raw'
  id?: string
  type: VaultItemType
  name: string
  site?: string
  /** IDs: sites (comma-separated) it may be typed on. */
  sites?: string
  subdomains?: boolean
  autoFill?: boolean
  username?: string
  password?: string
  totp?: string
  clearTotp?: boolean
  notes?: string
  number?: string
  cvc?: string
  clearCvc?: boolean
  expMonth?: number | string
  expYear?: number | string
  holder?: string
  billing?: string
  kind?: string
  fullName?: string
  issuer?: string
  country?: string
  body?: string
  address?: Omit<AddressEntry, 'id' | 'nickname' | 'summary'>
}

export interface VaultPrefs {
  autoLockMinutes: number
  lockOnSleep: boolean
  reauthPasswords: boolean
  touchId: boolean
}

/**
 * "Save to Vault?": a login or card the user typed into a page in the browser panel, or a password, API
 * key, card or ID number they typed into the composer. The values stay in main until the user clicks
 * Save; this is all the window gets (the site, a masked username, brand and last 4).
 */
export interface VaultSaveOffer {
  id: string
  source: 'browser' | 'chat'
  kind: 'login' | 'card' | 'api_key' | 'id_number'
  /** "Save login for example.com to Vault?" */
  title: string
  /** The site as shown ("example.com"), '' when unknown. */
  site: string
  /** The site it will be saved for ("https://example.com"), '' when unknown (chat: the user adds it). */
  origin: string
  /** Suggested item name (editable). */
  name: string
  /** Browser: masked ("sa•••@example.test"). Chat: the username typed next to the password. */
  username?: string
  /** A saved login for this site and username has a different password: "Update saved password?". */
  update?: boolean
  /** The saved login an update changes. */
  updates?: string
  /** "Password", "Visa ending 4242", "OpenAI API key", "Social Security number". */
  label: string
  brand?: string
  last4?: string
  expMonth?: number
  expYear?: number
  holder?: string
  /** The page had a security code (saved only when the user ticks "Remember the security code"). */
  hasCvc?: boolean
  idKind?: string
  /** What the user must fill in before saving. */
  needs?: Array<'site' | 'expiry' | 'holder'>
  /** Chat: which placeholder in the message this value replaced (0-based). */
  ordinal?: number
  status?: 'pending' | 'saved' | 'dismissed'
  /** The vault item it was saved as. */
  savedAs?: string
}

/** What the user changed on a "Save to Vault?" card. */
export interface VaultSaveEdits {
  name?: string
  site?: string
  username?: string
  expMonth?: string | number
  expYear?: string | number
  holder?: string
  rememberCvc?: boolean
}

export interface VaultStatus {
  exists: boolean
  locked: boolean
  masterPassword: boolean
  /** Touch ID can unlock while a master password is set. */
  bio: boolean
  touchIdAvailable: boolean
  /** No master password and no Touch ID: unlocking is a click (Keychain protection only). */
  presenceOnly: boolean
  kdf?: { alg: string; cost: string; ms?: number }
  counts: Record<VaultItemType, number>
  tampered: boolean
  retryInMs: number
  prefs: VaultPrefs
  keychain: boolean
  /** The pre-upgrade copies (Keychain-only format) still on this Mac, and what migration did. */
  legacy: { present: boolean; migrated: number; unreadable: string[]; rolledBack?: boolean }
}

export interface VaultAuditEntry {
  id: number
  at: number
  event: string
  item?: string
  site?: string
  outcome: 'ok' | 'denied' | 'failed' | 'blocked'
  detail?: string
}

/** Main asks the window to unlock or confirm (the window never decides; it only sends what was typed). */
export interface VaultAuthRequest {
  id: string
  kind: 'unlock' | 'reauth'
  needs: 'password' | 'confirm'
  title: string
  reason: string
  touchId: boolean
  purpose?: string
}

/** Shown to the user after Touch ID or the master password, hidden again after hideAfterMs. Never sent to a model. */
export interface VaultReveal {
  id: string
  type: VaultItemType
  fields: Array<{ key: string; label: string; value: string; secret?: boolean }>
  hideAfterMs: number
}

/**
 * A purchase waiting for the user's click. Built in main from the live page and the vault, never from
 * model text: merchant is the page's host, total and items are parsed from the page.
 */
export interface PurchaseInfo {
  /** fill = putting a saved card into the page; submit = placing the order / paying. */
  step: 'fill' | 'submit'
  merchant: string
  url: string
  secure: boolean
  /** What will happen, e.g. 'Click "Place order"' (the label is the page's own text). */
  action: string
  items: Array<{ name: string; price?: string }>
  total: { amount: number; currency: string; display: string } | null
  payment: string
  shipping: string
  reasons: string[]
  /** Re-asking because the page or total changed after an earlier approval. */
  changed?: boolean
  /** Fields SahilBot already typed in this step (field label and value; secrets show as dots). */
  typed?: Array<{ field: string; value: string }>
  nonce: string
  /** Approvals arriving before this time are ignored (no accidental double-click approvals). */
  readyAt: number
  expiresAt: number
}

export type ChatEvent =
  | { threadId: string; type: 'message'; message: Message }
  | { threadId: string; type: 'delta'; messageId: string; content?: string; reasoning?: string }
  | { threadId: string; type: 'run'; status: 'started' | 'finished' | 'stopped' | 'error'; error?: string; spaceId?: string; title?: string }
  | { threadId: string; type: 'thread'; thread: Thread }
  | { threadId: string; type: 'pending'; request: PendingRequest }
  | { threadId: string; type: 'resolved'; id: string }
  /** Steering messages waiting for the agent's next step (0 = delivered). */
  | { threadId: string; type: 'steer'; pending: number }
  /** Live progress of a Team of Experts call (callId = the agents tool call). */
  | { threadId: string; type: 'team'; callId: string; members: TeamMember[] }
  /** step = model turns so far; plan = position in the agent's own plan, when it wrote one. */
  | { threadId: string; type: 'progress'; step: number; actions: number; plan?: { at: number; of: number }; used: number; window: number; model?: string; routed?: { tier: Tier; why: string }; cost?: { usd: number; estimated: boolean } }
  /** The model is writing a tool call (shown as "Preparing to …" before it runs). */
  | { threadId: string; type: 'drafting'; tool: string | null }
  /** Bots or groups changed (renamed, recolored by a bot): reload the sidebar. */
  | { threadId: string; type: 'spaces' }
  /** Live progress from a running tool call (latest test output line, what a Cursor agent is doing). */
  | { threadId: string; type: 'tool_progress'; callId: string; tool: string; text: string }

export interface Attachment {
  path: string
  name: string
  kind: 'file' | 'folder' | 'image'
  size?: number
  /** Images only, for the model's vision input and the bubble. */
  dataUrl?: string
}

/** A Page (an interactive HTML artifact made with create_page), for the panel and Open in window. */
/** How the side-panel page is isolated (reported by main, so the UI and tests can check it). */
export interface PagePanelStatus { isolation: 'webcontentsview'; partition: string; webrtc: string; guard: boolean }

export interface PageInfo {
  path: string
  name: string
  title: string
  /** foreman-file: URL; the pages session serves it with a strict CSP and `sandbox allow-scripts`. */
  url: string
  size: number
  updatedAt: number
}

export interface FilePreview {
  path: string
  name: string
  size: number
  url: string
  kind: 'pdf' | 'image' | 'html' | 'markdown' | 'text' | 'sheets' | 'slides' | 'video' | 'unsupported'
  html?: string
  text?: string
  sheets?: Array<{ name: string; rows: Array<Array<string | number | boolean | null>> }>
  slides?: Array<{ n: number; texts: string[]; notes: string }>
  note?: string
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  needsKey: boolean
  /** A key is accepted but not required (LM Studio with "Require API key" turned on). */
  optionalKey?: boolean
  keyHint?: string
  /** Where to get a key. */
  keyUrl?: string
  defaultModel: string
}

export interface ConnectorPreset {
  id: string
  name: string
  url: string
  color: string
  description: string
  category: string
  /**
   * oauth: one click (the server registers SahilBot itself, OAuth dynamic client registration); none: open server;
   * oauth-static: the provider needs a one-time setup (the user creates an OAuth app there and pastes its client ID, see `setup`);
   * google: Google's MCP servers (SahilBot's built-in Google client, or your own from "Use your own app");
   * browser: web automation, you sign in once inside SahilBot's own browser; app: built into SahilBot;
   * apikey: the vendor's server takes your own API key.
   */
  auth: 'oauth' | 'none' | 'oauth-static' | 'google' | 'browser' | 'app' | 'apikey'
  /**
   * Set (by main, never in the catalog source) when SahilBot ships its own OAuth app registration for
   * this oauth-static or Google app (resources/oauth-clients.json): it then connects in one click, and
   * the setup steps are only for "Use your own app". The client itself never leaves main.
   */
  builtinClient?: boolean
  /** The app's own site, for its icon, when the server URL's host doesn't map to it (gmailmcp.googleapis.com → mail.google.com/mail/). */
  domain?: string
  /** One-time setup for oauth-static apps: exact steps with links, and the redirect URL to register. */
  setup?: ConnectorSetup
  /**
   * How the user's own API key is sent and where they get it (the key itself lives in the Keychain): an
   * apikey app's only sign-in, or on a one-click OAuth app whose vendor also documents a key, the
   * "Use an API key instead" alternative (a saved key is then used instead of OAuth).
   */
  apiKey?: ConnectorApiKey
  /**
   * Set when the app's server can't be used right now (it stopped answering, or moved without an
   * official new address): why, in plain words. The entry stays in the catalog but doesn't connect.
   */
  unavailable?: string
}

/**
 * How an official MCP server takes the user's own API key. The key is kept in the Keychain and added
 * to each request when it's made: never to the saved URL, settings, logs or error text.
 */
export interface ConnectorApiKey {
  /** A request header, or a query parameter added to the URL at request time only. */
  in: 'header' | 'query'
  /** Header name (Authorization, x-api-key) or query parameter name. */
  name: string
  /** Header value with {key} where the key goes (default "{key}"), e.g. "Bearer {key}". */
  format?: string
  /** The vendor's page where the user creates a key. */
  getKeyUrl: string
  /** Where on that page, e.g. "Account Settings → API Keys → Create API Key". */
  hint: string
  /** What a key looks like, for the paste box. */
  placeholder?: string
  /** Light format check (a regex source); main checks again. */
  pattern?: string
}

/** A provider-specific "create an OAuth app once" guide (oauth-static presets and custom servers). */
export interface ConnectorSetup {
  /** About how long it takes. */
  minutes: number
  steps: Array<{ title: string; text: string; links?: Array<[label: string, href: string]> }>
  /** The exact redirect (callback) URL to register with the provider. */
  redirectUri: string
  /** The provider issues a client secret that must be pasted too. */
  needsSecret: boolean
  /** Where the client ID is shown, e.g. "Basic Information → App Credentials". */
  idHint?: string
  /** The provider's own setup doc. */
  docs?: string
}

export interface ConnectorConfig {
  id: string
  name: string
  kind: 'remote' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Static auth header instead of OAuth (value kept in the Keychain). */
  headerName?: string
  /** Pre-registered OAuth client (Google, oauth-static apps, custom servers); its secret, if any, is kept in the Keychain. */
  clientId?: string
  preset?: string
  enabled: boolean
  /** Tool names (as the server names them) the user switched off; they aren't offered to the agent. */
  disabledTools?: string[]
}

/**
 * A bot shared as a file (".sahilbot.json"): its look, job and suggested routines. Never chats,
 * memories, secrets, connector tokens, file paths or chat ids.
 */
export interface SharedBotFile {
  format: 'sahilbot.bot'
  version: 1
  name: string
  color: string
  shape: BotShape
  label?: string
  description?: string
  /** The bot's instructions (its system prompt, without the parts SahilBot adds). */
  instructions: string
  /** Names of skills it leans on. */
  skills: string[]
  /** Suggested routines: created paused on import. */
  routines: Array<{ title: string; prompt: string; schedule: Schedule }>
}

/** What an import would create, shown for the user to read and confirm. */
export interface BotImportPreview {
  /** Pass to bots.importConfirm to create it (valid for 30 minutes, once). */
  token: string
  fileName: string
  name: string
  color: string
  shape: BotShape
  label: string | null
  description: string | null
  instructions: string
  routines: Array<{ title: string; prompt: string; schedule: Schedule }>
  /** Skills this Mac has (kept) and ones it doesn't (dropped). */
  skills: string[]
  unknownSkills: string[]
  /** Things cleaned up while reading the file (hidden characters removed, …). */
  warnings: string[]
}

/** Usage for one day, bot and model. where: local model server or paid cloud endpoint. */
export interface UsageRow {
  day: string
  spaceId: string | null
  model: string
  where: 'local' | 'cloud'
  requests: number
  input: number
  output: number
  usd: number
}

/** Settings → Usage. Breakdowns cover the last `days` days; spent/cap are this month's cloud spend. */
export interface UsageReport {
  month: string
  spent: number
  cap: number
  monthRequests: number
  days: number
  byModel: Array<{ model: string; where: 'local' | 'cloud'; requests: number; input: number; output: number; usd: number }>
  byBot: Array<{ spaceId: string | null; name: string; color: string | null; cloudRequests: number; localRequests: number; input: number; output: number; usd: number }>
  byDay: Array<{ day: string; usd: number; cloudRequests: number; localRequests: number }>
  totals: { cloudRequests: number; localRequests: number; input: number; output: number; usd: number }
}

/** The opt-in morning check-in: a daily routine on the main bot. */
export interface CheckinSettings {
  enabled: boolean
  /** HH:MM, local time. */
  time: string
}

/** A ready-made bot from packs/templates (Connect apps → Bot templates). */
export interface BotTemplate {
  id: string
  name: string
  color: string
  shape: BotShape
  description: string
  /** The bot's job: becomes its instructions (system.md). */
  instructions: string
  /** What the bot says first in its chat. */
  starterMessage: string
  /** Suggested routines; created paused until the user turns them on. */
  routines: Array<{ title: string; prompt: string; schedule: Schedule }>
  /** Names of built-in skills (packs/skills) this bot leans on. */
  skills?: string[]
  /** Apps it reads (connector preset ids, e.g. "gmail", "hubspot"; a name when there's no preset yet). */
  sources?: string[]
  /** Things to ask it first: shown on its card and as suggestion chips under its first message. */
  starterTasks?: string[]
  /** "function": a business-function bot wired to your brain (Accounting, Marketing…), shown as its own group. */
  group?: 'function'
}

/** How Google is connected (Connect apps → Google): no secrets, just the way and the address. */
export interface GoogleConnectLink { method: 'oauth' | 'mail' | 'app-password'; address?: string; at: number }
export interface GoogleConnectStatus {
  link: GoogleConnectLink | null
  oauth: { builtin: boolean; ownClient: boolean; connected: boolean; configId?: string }
  mail: Array<{ account: string; address: string }>
  mailOpen: boolean
}

export interface ConnectorStatus {
  id: string
  state: 'off' | 'disconnected' | 'connecting' | 'signing_in' | 'needs_auth' | 'connected' | 'error' | 'reconnecting'
  tools: number
  toolNames?: string[]
  error?: string
  /** Last successful health check (tools/list) and how long it took. */
  checkedAt?: number
  latencyMs?: number
  /** While reconnecting: which try this is and when the next one starts. */
  attempt?: number
  retryAt?: number
  /**
   * Why it isn't connected, when that's known: expired (a sign-in that worked before was refused or
   * revoked: one click on Reconnect signs in again), setup (a one-time setup or key is missing),
   * unavailable (the app's server isn't answering, or the catalog marks it unavailable).
   */
  reason?: 'expired' | 'setup' | 'unavailable'
}

export interface VoiceStatus {
  binary: boolean
  whisper: boolean
  vad: boolean
  kokoro: boolean
  voice: string
  active: 'off' | 'voice' | 'dictation'
  sizes: { whisper: number; vad: number; kokoro: number }
}

/** Work a bot started from a voice conversation, running in its own chat while you keep talking. */
export interface VoiceTask {
  threadId: string
  bot: string
  botId: string
  title: string
  status: 'working' | 'needs-you' | 'done' | 'failed' | 'stopped'
  startedAt: number
  /** The result's first sentences, as said aloud. */
  summary?: string
}

export type VoiceUiEvent =
  | { type: 'state'; state: 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking' }
  | { type: 'partial'; text: string }
  | { type: 'transcript'; text: string }
  | { type: 'reply'; text: string }
  /** Said on its own between turns: a bot's work started in this voice chat finished or needs you. */
  | { type: 'announce'; text: string }
  /** The work started in this voice chat, for the voice screen. */
  | { type: 'tasks'; tasks: VoiceTask[] }
  | { type: 'audio'; audio: Float32Array; rate: number }
  | { type: 'stop-audio' }
  | { type: 'metric'; name: string; ms: number }
  | { type: 'error'; message: string }
  | { type: 'download'; kind: string; progress: number; done?: boolean; error?: string; /** Started on its own (not a click): a toast says when it's ready. */ auto?: boolean; model?: string; label?: string }

export type Schedule =
  | { type: 'once'; at: string }
  | { type: 'every'; minutes: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; days: string[]; time: string }
  | { type: 'cron'; expr: string }

export interface ScheduledTask {
  id: string
  title: string
  prompt: string
  schedule: Schedule
  spaceId: string
  threadId: string | null
  enabled: boolean
  nextRun: number | null
  lastRun: number | null
  lastStatus: string | null
  createdAt: number
}

/** One run of a routine (scheduled task); the last 20 per routine are kept. */
export interface RoutineRun {
  id: string
  taskId: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'succeeded' | 'failed'
  reason: string | null
  threadId: string | null
  /** Started with Test (Run now) rather than by the schedule. */
  test: boolean
}

/** A file or link from a bot's chats (bot details → Library). */
export interface LibraryItem {
  kind: 'file' | 'link'
  title: string
  path?: string
  url?: string
  at: number
  threadId: string
}

export interface SendInput {
  /** Per-task resource limits, inherited by helpers and paid tool APIs. */
  taskPolicy?: import('../main/agent/runtime/store').TaskPolicy
  threadId: string
  text: string
  images?: string[]
  /** Extra context for the model only (not shown in the bubble). */
  note?: string
  /** Stored on the message for display, e.g. attached files and folders. */
  meta?: Record<string, unknown>
  /** Files and folders picked or dropped by the user; they become readable/editable for this thread. */
  attachments?: Attachment[]
  /** Sent from voice mode for short spoken-style answers. */
  voice?: boolean
  /** Team of Experts: the agent splits the work across many helper agents, then finishes the task. */
  team?: boolean
  /** Plan first: ask clarifying questions, propose a plan, and wait for approval before changing anything. */
  planFirst?: boolean
  /** Deep Research: a team researches, then the agent writes a cited report saved as a PDF. */
  deepResearch?: boolean
}

/** One helper agent in a Team of Experts run, as shown in the chat. */
export interface TeamMember {
  id: string
  title: string
  status: 'queued' | 'working' | 'done' | 'failed' | 'stopped'
  /** What it's doing now, or its final report's first line. */
  detail?: string
  model?: string
  depth: number
}

export interface SahilBotApi {
  system: { info(): Promise<SystemInfo> }
  /** ChatGPT plan (via Codex): Settings → Models. */
  chatgptPlan: import('./chatgpt-plan').ChatgptPlanApi & { onChanged(cb: () => void): () => void }
  grokPlan: import('./grok-plan').GrokPlanApi
  privacy: import('./privacy').PrivacyApi
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings> & { apiKey?: string | null; braveKey?: string | null; cursorKey?: string | null; tbaKey?: string | null; ncbiKey?: string | null; setKeys?: Partial<Record<ProviderId, string | null>> }): Promise<Settings>
  }
  models: {
    list(): Promise<ModelList>
    /** The three best models for this Mac, for first-run setup. */
    setupPicks(): Promise<Array<{ pull: string; label: string; blurb: string; sizeGB: number; tier: number; installed: boolean; role: string }>>
    /** GPU memory limit (macOS default is about 75% of RAM). setLimit asks for the admin password. */
    gpu(): Promise<{ totalGB: number; limitMB: number }>
    setGpuLimit(percent: number, keep: boolean): Promise<{ limitMB: number }>
    /** How many helper agents this Mac can run with a model ('auto' = the strongest usable). */
    teamCapacity(model: string): Promise<{ parallel: number; maxAgents: number; heavy: boolean; why: string }>
    /** Downloads a model through Ollama; progress arrives as 'pull' events on onPull. */
    pull(tag: string): Promise<void>
    /** Deletes a downloaded Ollama model (frees its disk space). The UI asks first. */
    remove(tag: string): Promise<{ ok: boolean; error?: string }>
    onPull(cb: (e: { tag: string; status: string; completed?: number; total?: number; done?: boolean; error?: string }) => void): () => void
    /** Checks an endpoint without saving anything. Leave apiKey empty to use the key saved for that endpoint. */
    test(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; count: number; error?: string }>
  }
  spaces: {
    /** A "New bot" that sets itself up with you in its chat (or the one still being set up). */
    startSetup(): Promise<{ space: Space; threadId: string }>
    list(): Promise<Space[]>
    create(input: { name?: string; color?: string; shape?: BotShape; kind?: 'bot' | 'group' | 'project'; members?: string[]; intro?: boolean; folder?: string }): Promise<{ space: Space; threadId: string }>
    update(id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'shape' | 'pinned' | 'hidden' | 'members' | 'model' | 'folder' | 'label' | 'notify' | 'effort'>>): Promise<Space>
    /** Files and links from this bot's chats, newest first. */
    library(spaceId: string): Promise<LibraryItem[]>
    markUnread(id: string): Promise<void>
    remove(id: string): Promise<void>
    getPrompt(id: string): Promise<string>
    setPrompt(id: string, text: string): Promise<void>
    promptPath(id: string): Promise<string>
  }
  threads: {
    list(spaceId?: string): Promise<Thread[]>
    search(query: string): Promise<Thread[]>
    create(spaceId: string): Promise<Thread>
    update(id: string, patch: Partial<Pick<Thread, 'title' | 'pinned' | 'unread' | 'permissionMode' | 'model' | 'spaceId' | 'effort'>>): Promise<Thread>
    /** You've seen the chat up to `upTo` (the newest message on screen; default: now). Idempotent; only moves forward. */
    markRead(id: string, upTo?: number): Promise<Thread>
    remove(id: string): Promise<void>
    messages(id: string): Promise<Message[]>
    react(messageId: string, emoji: string | null): Promise<Message>
  }
  files: {
    pick(kind: 'files' | 'folder'): Promise<Attachment[]>
    /** Resolves dropped File objects to paths (preload only; the renderer can't fake these). */
    fromDrop(files: File[]): Promise<Attachment[]>
    preview(path: string): Promise<FilePreview>
    /** Home's starter tiles, personalized from the user's habits (ideas.ts). */
    ideas(): Promise<HomeIdea[]>
    /** The first lines of a document SahilBot made (PDF, Word, PowerPoint), for thumbnails. */
    snippet(path: string): Promise<string>
    /** Files SahilBot made, newest first. */
    recent(limit?: number): Promise<Array<{ path: string; name: string; size: number; threadId: string; threadTitle: string; createdAt: number; tool: string }>>
    /** Artifacts: every file agents made (documents, decks, sheets, PDFs, images, audio), newest first. */
    artifacts(limit?: number): Promise<Array<{ path: string; name: string; size: number; threadId: string; threadTitle: string; createdAt: number; tool: string }>>
    open(path: string): Promise<void>
    reveal(path: string): Promise<void>
  }
  /** Pages (create_page): only files directly in the pages folder; anything else is refused. */
  pages: {
    info(path: string): Promise<PageInfo>
    /** Opens the page full-size in its own locked-down window (isolated pages session: no app API, no network, no WebRTC). */
    openWindow(path: string): Promise<void>
    /** Saves "<name>.pdf" next to the page, reveals it in Finder, and returns its path. */
    exportPdf(path: string): Promise<string>
    /**
     * Shows the page in the side panel: a native view in the isolated pages session laid over `bounds`
     * (window coordinates; null = keep it loaded but hidden, e.g. under a modal). A new `rev` reloads it.
     * show(null) closes it.
     */
    show(path: string | null, rev?: string, bounds?: { x: number; y: number; width: number; height: number } | null): Promise<PagePanelStatus | null>
    /** A PNG data: URL of the page's top, for chat cards (null if it couldn't be rendered). */
    thumbnail(path: string): Promise<string | null>
  }
  providers(): Promise<ProviderPreset[]>
  /** Quick Ask (the floating ⌥Space bar). */
  quick: {
    ask(text: string, opts: { screen?: boolean; clipboard?: boolean }): Promise<string>
    hide(): Promise<void>
    resize(height: number): Promise<void>
    open(threadId: string): Promise<void>
    onShown(cb: () => void): () => void
  }
  /** Main window: open a chat (from Quick Ask). */
  onOpenThread(cb: (threadId: string) => void): () => void
  /** Computer use: the window shrank to a corner (on) or came back (off). */
  onMini(cb: (e: { on: boolean; threadId?: string }) => void): () => void
  exitMini(): Promise<void>
  /** Menu bar commands (File > New Chat, SahilBot > Settings…). */
  onMenu(cb: (action: string) => void): () => void
  budget(): Promise<{ month: string; spent: number; cap: number; requests: number; mode?: SpendingMode }>
  /** Cloud spend was recorded: refresh budget(). */
  onBudgetChanged(cb: () => void): () => void
  /** Finds local model servers already running and the best model on each that fits this Mac. */
  detectProviders(): Promise<Array<{ id: string; name: string; baseUrl: string; models: number; best: string | null }>>
  /** Local models in one click: installs Ollama if needed (checked by Apple's notarization) and runs it in the background. */
  ollama: {
    setup(): Promise<void>
    installed(): Promise<boolean>
    onSetup(cb: (e: { phase: 'download' | 'verify' | 'install' | 'start' | 'done' | 'error'; pct?: number; error?: string }) => void): () => void
  }
  schedules: {
    list(): Promise<ScheduledTask[]>
    create(t: { title: string; prompt: string; schedule: Schedule; spaceId: string }): Promise<ScheduledTask>
    update(id: string, patch: { enabled?: boolean; title?: string; prompt?: string; schedule?: Schedule }): Promise<ScheduledTask>
    remove(id: string): Promise<void>
    /** Test: runs it now without moving its schedule; progress arrives through onChange and runs(). */
    runNow(id: string): Promise<void>
    /** Run history, newest first (last 20). */
    runs(taskId: string): Promise<RoutineRun[]>
    onChange(cb: () => void): () => void
  }
  pickFolder(): Promise<string | null>
  voice: {
    openNative(): Promise<boolean>
    status(): Promise<VoiceStatus>
    download(kind: 'whisper' | 'vad' | 'kokoro'): Promise<void>
    setVoice(v: string): Promise<void>
    /** Starts hands-free voice mode in a thread (created when threadId is null); returns the thread id. */
    start(threadId: string | null, spaceId: string): Promise<string>
    stop(): Promise<void>
    dictateStart(): Promise<void>
    dictateStop(): Promise<string>
    /** Read text aloud with the chosen voice; audio arrives as 'audio' events. */
    speak(text: string): Promise<void>
    stopSpeaking(): Promise<void>
    /** Work started in the open voice chat (running, waiting on you, done). */
    tasks(): Promise<VoiceTask[]>
    /** The voice bar's settings: voices for the engine speaking now, speed and language. */
    options?(): Promise<VoiceBarOptions>
    setStyle?(patch: { voice?: string; speed?: number; language?: string; provider?: 'openai' | 'xai' }): Promise<VoiceBarOptions>
    /** Says a short sample in that voice (doesn't choose it). */
    preview?(voice: string): Promise<void>

    frame(samples: Float32Array): void
    onEvent(cb: (e: VoiceUiEvent) => void): () => void
  }
  connectors: {
    presets(): Promise<ConnectorPreset[]>
    list(): Promise<{ configs: ConnectorConfig[]; statuses: ConnectorStatus[]; /** Connector ids with an API key saved (the keys never leave main). */ keys?: string[] }>
    save(c: Omit<ConnectorConfig, 'id'> & { id?: string; headerValue?: string; clientSecret?: string }): Promise<ConnectorConfig>
    remove(id: string): Promise<void>
    connect(id: string): Promise<ConnectorStatus>
    /** One-click connect for a catalog entry (OAuth opens the browser). */
    connectPreset(id: string): Promise<ConnectorStatus>
    disconnect(id: string): Promise<void>
    /** App icons as data: URLs by preset id: cached ones now; onIcons fires when more have been fetched. */
    icons(): Promise<Record<string, string>>
    onIcons(cb: () => void): () => void
    /** Switch one of a connector's tools on or off (persisted; off tools aren't offered to the agent). */
    setToolEnabled(id: string, tool: string, on: boolean): Promise<ConnectorConfig>
    onChange(cb: () => void): () => void
    /** Test connection: a tools/list round trip (connects without opening the browser if it isn't live). */
    test(id: string): Promise<ConnectorStatus>
    /** The Google OAuth client shared by Gmail, Calendar and Drive (ID only; the secret stays in the Keychain). */
    googleClient(): Promise<{ clientId: string; hasSecret: boolean } | null>
    setGoogleClient(clientId: string, clientSecret: string): Promise<{ clientId: string; hasSecret: boolean }>
    clearGoogleClient(): Promise<void>
    /** Saves an API key for an apikey catalog app (Keychain), adds the app if needed, and connects. */
    setApiKey(presetId: string, key: string): Promise<ConnectorStatus>
    /** "Check all": re-tests every switched-on app (live ones list their tools; others reconnect without opening the browser). */
    checkAll(): Promise<ConnectorStatus[]>
    /** "Use SahilBot's app": forget this connector's own OAuth client and sign in with the built-in one. */
    useBuiltinClient(id: string): Promise<ConnectorConfig>
    /** Forget the API key of a one-click app that was using "Use an API key instead" (it signs in with OAuth again). */
    clearApiKey(id: string): Promise<void>
    /** "Paste key": main reads the Mac's clipboard (only now), checks the key's shape, saves and verifies it. The clipboard never comes back. */
    pasteApiKey(presetId: string): Promise<ConnectorStatus>
  }
  /** Connect apps → Google: Sign in with Google, the Mac's Mail app, or an app password (main/mail/google-connect.ts). */
  google: {
    /** withMail: also look for Google accounts in Apple Mail (the Google panel; Connect apps' list doesn't). */
    status(withMail?: boolean): Promise<GoogleConnectStatus>
    useMail(address: string): Promise<GoogleConnectLink>
    useAppPassword(address: string, password: string): Promise<GoogleConnectLink>
    useOauth(): Promise<GoogleConnectLink>
    disconnect(): Promise<void>
  }
  vault: {
    list(): Promise<VaultEntry[]>
    set(entry: VaultEntry & { password?: string; totp?: string; clearTotp?: boolean }): Promise<VaultEntry[]>
    remove(name: string): Promise<VaultEntry[]>
    /** The live authenticator code, only after the user clicks Reveal in Settings. */
    totpCode(name: string): Promise<{ code: string; remaining: number } | null>
    /** Sites allowed to fill one-time codes without asking ("Always for this site"). */
    otpGrants(): Promise<string[]>
    revokeOtpGrant(site: string): Promise<string[]>
    cards(): Promise<CardEntry[]>
    setCard(c: CardInput): Promise<CardEntry[]>
    removeCard(id: string): Promise<CardEntry[]>
    addresses(): Promise<AddressEntry[]>
    setAddress(a: Omit<AddressEntry, 'id'> & { id?: string }): Promise<AddressEntry[]>
    removeAddress(id: string): Promise<AddressEntry[]>
    // The envelope vault (Settings → Privacy & Security → Passwords). Replies carry metadata only, except reveal (after Touch ID or the master password).
    status(): Promise<VaultStatus>
    items(): Promise<VaultItemSummary[]>
    saveItem(input: VaultItemInput): Promise<VaultItemSummary[]>
    removeItem(id: string): Promise<VaultItemSummary[]>
    unlock(): Promise<VaultStatus>
    lock(): Promise<VaultStatus>
    reveal(id: string): Promise<VaultReveal | null>
    setPrefs(p: Partial<VaultPrefs>): Promise<VaultStatus>
    setMasterPassword(next: string, current?: string): Promise<VaultStatus>
    removeMasterPassword(current: string): Promise<VaultStatus>
    setTouchIdUnlock(on: boolean): Promise<VaultStatus>
    audit(limit?: number): Promise<VaultAuditEntry[]>
    exportBackup(password: string): Promise<{ ok: boolean; path?: string; count?: number; error?: string }>
    importBackup(password: string): Promise<{ ok: boolean; added?: number; skipped?: number; error?: string }>
    importCsv(): Promise<{ ok: boolean; added?: number; skipped?: number; path?: string; error?: string }>
    purgeLegacy(): Promise<VaultStatus>
    rollback(): Promise<VaultStatus>
    resign(): Promise<VaultStatus>
    authPending(): Promise<VaultAuthRequest[]>
    /** "Save to Vault?": the user's click on Save (asks for Touch ID or the master password when locked). */
    offerSave(id: string, edits?: VaultSaveEdits, messageId?: string): Promise<{ ok: boolean; name: string }>
    /** "Not now": the value is forgotten. */
    offerDismiss(id: string, messageId?: string): Promise<{ ok: boolean }>
    /** "Never for this site": forgotten, and never asked on that site again. Returns the never-list. */
    offerNever(id: string): Promise<string[]>
    /** Which of these offers SahilBot still holds the value for (a restart forgets them). */
    offerAlive(ids: string[]): Promise<string[]>
    /** Sites "Never for this site" was chosen on. */
    neverSave(): Promise<string[]>
    removeNeverSave(origin: string): Promise<string[]>
    authRespond(id: string, answer: { password?: string; cancel?: boolean; touchId?: boolean }): Promise<{ ok: boolean; error?: string; retryInMs?: number }>
    onAuth(cb: (e: VaultAuthRequest | { id: string; done: true }) => void): () => void
    onChanged(cb: () => void): () => void
  }
  /** The Purchase approval card: only a click in the main window approves, once, for that exact card. */
  purchase: {
    /** 'always' is only accepted on one-time-code cards (a per-site grant); purchases are always single-use. */
    respond(threadId: string, id: string, nonce: string, answer: 'approve' | 'deny' | 'always'): Promise<{ ok: boolean; error?: string }>
  }
  browser: {
    state(): Promise<BrowserState>
    setBounds(b: { x: number; y: number; width: number; height: number } | null): Promise<void>
    navigate(url: string): Promise<void>
    back(): Promise<void>
    forward(): Promise<void>
    reload(): Promise<void>
    newTab(): Promise<void>
    switchTab(i: number): Promise<void>
    closeTab(i: number): Promise<void>
    takeOver(on: boolean): Promise<void>
    /** Teach a task: record the user's steps in the browser panel. */
    teachStart(): Promise<void>
    /** Stops recording and keeps the steps for teachCompose. */
    teachStop(): Promise<{ steps: number; text: string }>
    teachCancel(): Promise<void>
    /** The chat message (text shown, note for the model) for the stopped recording; clears it. */
    teachCompose(name: string, goal?: string): Promise<{ text: string; note: string; threadId?: string }>
    onState(cb: (s: BrowserState) => void): () => void
    onOpenRequest(cb: () => void): () => void
  }
  /** Site playbooks: what SahilBot learned about each website (src/main/sites). */
  sites: {
    list(): Promise<SitePlaybookSummary[]>
    get(domain: string): Promise<SitePlaybook | null>
    forget(domain: string): Promise<boolean>
  }
  memory: {
    list(): Promise<MemoryItem[]>
    remove(id: string): Promise<void>
    /** spaceId null = shared (about you). The kind is guessed from the wording unless given. */
    add(content: string, spaceId: string | null, category?: MemoryKind): Promise<MemoryItem>
    update(id: string, content: string, patch?: { category?: MemoryKind; spaceId?: string | null }): Promise<void>
    /** Parses text exported from another assistant; nothing is saved yet. */
    importPreview(text: string): Promise<MemoryImportPreview>
    /** Saves the chosen lines as shared memories; returns how many were added. */
    importCommit(items: Array<{ content: string; category?: MemoryKind; date?: string | null; asRule?: boolean }>): Promise<number>
    /** Same as importCommit, with counts: memories added, rules added (from Instructions), skipped. */
    importSave(items: Array<{ content: string; category?: MemoryKind; date?: string | null; asRule?: boolean }>): Promise<{ memories: number; rules: number; skipped: number }>
    /** Puts the import prompt (src/shared/memory-import.ts) on the clipboard. */
    copyImportPrompt(): Promise<boolean>
    getEnabled(): Promise<boolean>
    setEnabled(on: boolean): Promise<void>
    /** Undo a delete: puts that memory back as it was (Settings → Memory). */
    restore(m: MemoryItem): Promise<MemoryItem | null>
  }
  rules: {
    list(): Promise<Rule[]>
    save(r: { name: string; text: string; scope?: string; category?: string }): Promise<Rule>
    setEnabled(name: string, on: boolean): Promise<void>
    remove(name: string): Promise<void>
  }
  /** Ready-made bots (Connect apps → Bot templates). */
  templates: {
    list(): Promise<BotTemplate[]>
    /** Creates the bot, its routines (paused) and a chat that opens with the bot's intro. */
    add(id: string): Promise<{ spaceId: string; threadId: string }>
  }
  /** Share, import and duplicate bots. */
  bots: {
    /** Saves the bot as a .sahilbot.json file (save dialog); null if cancelled. redacted: secrets/paths removed. */
    exportFile(spaceId: string): Promise<{ path: string; redacted: number } | null>
    /** Opens a .sahilbot.json file (open dialog) and checks it; null if cancelled. Nothing is created yet. */
    importPick(): Promise<BotImportPreview | null>
    /** Creates the previewed bot (routines paused) and opens its chat. */
    importConfirm(token: string): Promise<{ spaceId: string; threadId: string }>
    /** Copies a bot's name, look, label, instructions and routines (paused); not its chats or memories. */
    duplicate(spaceId: string): Promise<{ spaceId: string; threadId: string }>
    /** Each bot's status (Working / Pulling context / Done / Idle) and the model its last reply ran on. */
    status(): Promise<import('./bot-status').BotStatusMap>
  }
  /** The morning check-in routine on the main bot (off by default). */
  checkin: {
    get(): Promise<CheckinSettings>
    set(c: CheckinSettings): Promise<CheckinSettings>
  }
  usage: {
    /** Last 30 days by model, bot and day, plus this month's spend against the cap. */
    report(): Promise<UsageReport>
    /** Saves the last 30 days as CSV (save dialog); null if cancelled. */
    exportCsv(): Promise<string | null>
    /** Tokens and cloud cost of one run: a chat's model replies (and its helper agents') since `since`. */
    forRun(threadId: string, since: number, until?: number): Promise<RunUsage>
    /** Settings → Usage: month against the limit, 30 days / 12 weeks of tokens, lifetime, per model / provider / bot. */
    dashboard(): Promise<UsageDashboard>
    /** The compact card (profile menu, ⌘K "Usage"). */
    glance(): Promise<UsageGlance>
  }
  skills: {
    list(): Promise<Skill[]>
    save(s: { name: string; description: string; body: string }): Promise<Skill>
    remove(name: string): Promise<void>
  }
  /** Always on: menu bar icon, open at login, keep awake, missed routines. */
  alwaysOn: {
    status(): Promise<AlwaysOnStatus>
    /** Pause or resume every routine at once (same as the menu bar icon's item). */
    pauseRoutines(paused: boolean): Promise<AlwaysOnStatus>
    /** Turns working with the lid closed on (asks macOS for an administrator the first time) or off. */
    setLidAwake(on: boolean): Promise<{ ok: boolean; error?: string }>
  }
  chat: {
    /**
     * Continue a chat that was cut off by SahilBot closing: re-runs from the current history with a hidden
     * note to check what's already done first. Clears the Continue button (the notice's meta.resumable).
     */
    resume(threadId: string): Promise<void>
    /** Chats still showing a Continue button from an interrupted run. */
    interrupted(): Promise<InterruptedRun[]>
    send(input: SendInput): Promise<void>
    stop(threadId: string): Promise<void>
    /** Message a running agent: it takes it into account from its next step (or sends normally if idle). */
    steer(threadId: string, text: string): Promise<'steered' | 'sent'>
    respond(threadId: string, requestId: string, answer: string): Promise<void>
    /** Drops the last reply and asks again. */
    retry(threadId: string): Promise<void>
    /** Replaces your last message and asks again. */
    editLast(threadId: string, text: string): Promise<void>
    /** Saves the conversation as a Markdown file (save dialog). */
    exportThread(threadId: string): Promise<string | null>
    pending(threadId: string): Promise<PendingRequest[]>
    /** Chats waiting on the user, with their open request ids. */
    allPending(): Promise<Record<string, string[]>>
    /** Chats working right now and the bot each belongs to (a reopened window or web tab picks up runs already going). */
    running(): Promise<Array<{ threadId: string; spaceId: string }>>
    onEvent(cb: (e: ChatEvent) => void): () => void
  }
}

// ---------------------------------------------------------------------------- markets
/** Stock data a market tool attaches to its result (tool message meta.stock) so the chat can show a card. */
export interface StockCardData {
  symbol: string
  name?: string
  currency?: string
  /** Last close (or live price when a real-time provider is set) and when it's from (ms). */
  price: number
  asOf: number
  /** Day change as a FRACTION of the previous close (0.012 = +1.2%). */
  change1d?: number
  /** Daily closes, oldest first: [time ms, close]. Up to ~1 year. */
  series: Array<[number, number]>
  /**
   * Key stats. Prices in the card's currency; volume in shares. FRACTIONS (0.012 = 1.2%): volatility (annualized,
   * last year), return1m, return1y, maxDrawdown (negative, last year: -0.25 = fell 25% from a high), dividendYield.
   * Plain numbers: pe, eps, beta (vs SPY, last year), rsi14 (0-100), sma50/sma200 (price), marketCap (currency units).
   */
  stats?: Partial<Record<'open' | 'high52' | 'low52' | 'volume' | 'avgVolume' | 'marketCap' | 'pe' | 'eps' | 'dividendYield' | 'beta' | 'volatility' | 'rsi14' | 'sma50' | 'sma200' | 'maxDrawdown' | 'return1m' | 'return1y', number>>
  /** Probabilistic forecast: percentile paths over the horizon (trading days), from the model ensemble. */
  forecast?: {
    horizonDays: number
    dates: number[]
    p5: number[]
    p25: number[]
    p50: number[]
    p75: number[]
    p95: number[]
    /** Probability the price ends above today's close at the horizon. */
    probUp: number
    model: string
    /** Walk-forward backtest of this forecaster on this stock: honest skill vs a naive baseline. */
    skill?: { coverage90: number; pinballVsNaive: number; directionalAccuracy: number; samples: number }
  }
  source: string
  disclaimer: string
}

// ---------------------------------------------------------------------------- watchlist
/** One symbol on the stock watchlist, with the last values the app saw for it (a stock card or a refresh). */
export interface WatchlistItem {
  symbol: string
  name?: string
  currency?: string
  price?: number
  /** Day change, absolute (price units) and percent (e.g. 1.25 = +1.25%), worked out by the app. */
  changeAbs?: number
  changePct?: number
  /** When price is from (ms). */
  asOf?: number
  /** Recent daily closes for the sparkline, oldest first (≤ 60). */
  spark?: number[]
}

export interface SahilBotApi {
  /** The stock watchlist, in the user's order (kept in settings). set() returns the cleaned list it saved. */
  watchlist: {
    get(): Promise<WatchlistItem[]>
    set(items: WatchlistItem[]): Promise<WatchlistItem[]>
  }
}

// ---------------------------------------------------------------------------- markets engine (main/markets)
/**
 * Optional detail the markets engine adds to a stock card (merged into StockCardData; every field is
 * optional, so the contract above is unchanged). forecast arrays (dates, p5..p95) start at index 0 with
 * the last close (dates[0] = asOf of the last daily bar), then one entry per trading day to the horizon.
 * All probabilities and skill numbers are fractions (0..1); pinballVsNaive is a ratio (below 1 = better).
 */
export interface StockCardData {
  /** Which tool made the card. */
  kind?: 'quote' | 'analysis' | 'forecast' | 'compare' | 'backtest' | 'alert'
  /** Day change in price units. */
  changeAbs1d?: number
  /** True: price is a live or delayed intraday quote (a keyed provider). False: the last daily close. */
  live?: boolean
  /** Forecast details beyond the contract: per-model skill, ensemble weights, verdict in words. */
  forecastDetail?: {
    verdict: string
    rangeSkill: boolean
    directionSkill: boolean
    baseRateUp: number
    naiveCoverage90: number
    models: Array<{ id: string; label: string; weight: number; coverage90: number; pinballVsNaive: number; directionalAccuracy: number; p5: number; p50: number; p95: number; probUp: number }>
    ensemble: { coverage90: number; pinballVsNaive: number; directionalAccuracy: number; samples: number; effectiveSamples: number }
    volatility: { ewma: number; garchNow: number; garchLongRun: number; historical1y: number }
  }
  /** P(price vs a target) at the forecast horizon, from the ensemble. */
  target?: { price: number; date: number; probAboveAtEnd: number; probBelowAtEnd: number; probTouch: number }
  /** stock_compare: every symbol's numbers plus the correlation matrix (same order as symbols). */
  compare?: {
    symbols: string[]
    rows: Array<{ symbol: string; name?: string; price: number; return1m?: number; return1y?: number; volatility?: number; maxDrawdown?: number; beta?: number; sharpe1y?: number }>
    correlation: number[][]
    /** Normalized growth of 1 over the compared window, per symbol: [time ms, value]. */
    growth: Array<{ symbol: string; points: Array<[number, number]> }>
    days: number
  }
  /** stock_backtest results (fractions except sharpe/sortino/trades). */
  backtest?: {
    strategy: string
    params: Record<string, number>
    from: number
    to: number
    equity: Array<[number, number]>
    buyHoldEquity: Array<[number, number]>
    metrics: { cagr: number; vol: number; sharpe: number; sortino: number; maxDrawdown: number; trades: number; exposure: number; totalReturn: number }
    buyHold: { cagr: number; vol: number; sharpe: number; sortino: number; maxDrawdown: number; totalReturn: number }
    warnings: string[]
  }
  /** Company financials from SEC EDGAR (USD; margins and growth are fractions). */
  fundamentals?: { revenueTtm?: number; revenueGrowthYoY?: number; netIncomeTtm?: number; epsTtm?: number; grossMargin?: number; operatingMargin?: number; cash?: number; totalDebt?: number; freeCashFlowTtm?: number; sharesOutstanding?: number; fiscalYearEnd?: string }
  /** Recent SEC filings, newest first. */
  filings?: Array<{ form: string; filed: string; description: string; url: string }>
  /** Recent headlines (only with a news-capable API key). */
  news?: Array<{ title: string; url: string; publishedAt: number; source: string }>
  /** Technical readings for the analysis view. */
  technicals?: { macd?: number; macdSignal?: number; bollPercentB?: number; atr14?: number; sma20?: number; return3m?: number; return6m?: number; returnYtd?: number; sharpe1y?: number; sortino1y?: number; vol1m?: number }
  /** price_alert: the condition being watched. */
  alert?: { condition: string; schedule: string; repeat: boolean; routineId?: string }
}

export type MarketKeyProvider = 'tiingo' | 'polygon' | 'alphavantage' | 'finnhub'

/** Settings → Markets. Keys live in the Keychain (Secrets); the renderer sees only whether each is saved. */
export interface MarketsSettings {
  /** Live/delayed quote source: 'auto' = the first provider with a key; 'none' = always the last daily close. */
  quoteProvider: 'auto' | 'none' | MarketKeyProvider
  /** Contact sent in the User-Agent to SEC EDGAR, as its fair-access policy asks (a generic one is used when empty). */
  secContact: string
  /** Read-only: which provider keys are saved. */
  keys?: Record<MarketKeyProvider, boolean>
}

export interface Settings {
  markets?: MarketsSettings
}

export interface SahilBotApi {
  /** Market data for the watchlist and cards (no model calls). */
  markets: {
    /** Latest price, day change (percent), sparkline and name for each symbol, from cached daily data. */
    quotes(symbols: string[]): Promise<WatchlistItem[]>
    /** A full stock card for one symbol (forecast: adds the model range, which takes a few seconds). */
    card(symbol: string, opts?: { forecast?: boolean; horizonDays?: number }): Promise<StockCardData>
    /** Ticker lookup by symbol or company name (US listings, SEC list). */
    search(query: string): Promise<Array<{ symbol: string; name: string }>>
  }
}

// ---- Privacy & Permissions (main: permissions-center.ts)

export type PermissionKind = 'accessibility' | 'screen' | 'microphone' | 'fullDisk' | 'automation' | 'notifications'
/** 'unknown': macOS doesn't tell apps (notifications), or it depends on the app (automation). */
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

export interface PermissionRow {
  kind: PermissionKind
  title: string
  state: PermissionState
  /** What it lets SahilBot do, in plain words. */
  enables: string
  /** Where to turn it on. */
  how: string
  /** The exact System Settings pane (opened by permissions.open). */
  settingsUrl: string
  detail?: string
}

/** The in-app updater (main/updater.ts). */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'installing' | 'error' | 'unsupported'
  /** The newer release: "0.1.0 (build 131)". */
  version?: string
  /** This app: "0.1.0 (build 128)". */
  current?: string
  notes?: string
  /** Download progress, 0-100. */
  progress?: number
  /** The download's size in bytes. */
  size?: number
  detail?: string
  checkedAt?: number
}

/** Settings → Backups: where copies go, the newest one, and whether keys are restorable on another Mac. */
export interface BackupStatus {
  folders: Array<{ kind: 'main' | 'mirror' | 'extra'; path: string }>
  last?: { at: number; path: string; bytes: number; label: string; includes: string[] }
  running: boolean
  /** A recovery password is set: each backup carries keys.sbrecovery. */
  recoveryPassword: boolean
  note?: string
  error?: string
}

export interface SahilBotApi {
  /** Updates: status, check now, and install (backs up the data, quits, swaps the app, reopens it). */
  update: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    install(): Promise<UpdateStatus>
    /** Published versions with the size of each download (newest first). */
    history(): Promise<Array<{ version: string; build: number; size: number; date: string }>>
    /** "0.1.0-128" when this is the first start after updating from it, else null. */
    upgradedFrom(): Promise<string | null>
    onStatus(cb: (s: UpdateStatus) => void): () => void
  }
  /** Settings → Privacy & Security → Backups (main/backup.ts). Key values never come back to the window. */
  backups: {
    status(): Promise<BackupStatus>
    now(): Promise<{ ok: boolean; path?: string; error?: string }>
    setRecoveryPassword(password: string): Promise<{ ok: boolean; error?: string }>
    clearRecovery(): Promise<{ ok: boolean }>
    /** Asks for a .sbrecovery file, opens it with the password and saves the keys (existing ones kept unless replace). */
    restoreKeys(password: string, replace?: boolean): Promise<{ ok: boolean; canceled?: boolean; restored?: number; kept?: number; error?: string }>
    chooseExtraFolder(): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
    clearExtraFolder(): Promise<{ ok: boolean }>
    /** Opens one of the backup folders (or the newest backup) in Finder. */
    open(path: string): Promise<boolean>
  }
  /** macOS permissions: status (never prompts) and the System Settings pane for each. Nothing is granted from here. */
  permissions: {
    status(): Promise<PermissionRow[]>
    /** Opens the exact System Settings pane for a permission. */
    open(kind: PermissionKind): Promise<void>
    /** Asks for a permission: macOS's own prompt where it has one ('granted' / 'denied' / 'prompted'), else the pane ('opened'). */
    request(kind: PermissionKind): Promise<'granted' | 'denied' | 'prompted' | 'opened'>
    /** Whether SahilBot may control one app (Automation). May show macOS's one-time prompt; doesn't launch the app. */
    automation(app: string): Promise<{ app: string; state: PermissionState; detail?: string }>
  }
}

// ---- Long-running goals (main: goals/; renderer: TasksView)

/**
 * active: being pursued (wakes itself up); paused: by the user, "Pause all routines" or its end date;
 * waiting_user: needs the user (an approval was queued, it's stalled, or it asked a question);
 * blocked: hit its spend cap; done; abandoned (by the user).
 */
export type GoalStatus = 'active' | 'paused' | 'waiting_user' | 'blocked' | 'done' | 'abandoned'

export interface GoalMilestone {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'done' | 'skipped'
  doneAt?: number
  /** When it was first marked done (never changes after): stall detection counts only these. */
  firstDoneAt?: number
}

/** A dated line of what was done or learned. kind: 'note' (the bot's), 'milestone', 'status', 'system'. */
export interface GoalJournalEntry {
  at: number
  text: string
  kind?: 'note' | 'milestone' | 'status' | 'system'
  /** Written by a run that had read outside content (web, email, another bot or app): data, not instructions. */
  tainted?: boolean
}

/** Something an unattended wake-up wanted to do that needs the user's OK (queued, never done). */
export interface GoalAsk {
  id: string
  at: number
  tool: string
  label: string
  summary: string
}

export interface Goal {
  id: string
  /** The bot pursuing it (a space id). */
  botId: string
  /** The chat its wake-ups run in. */
  threadId: string | null
  title: string
  /** Definition of done, in the user's words. */
  doneWhen: string
  milestones: GoalMilestone[]
  /** Oldest first; capped (the oldest entries are dropped). */
  journal: GoalJournalEntry[]
  status: GoalStatus
  /** Why it is paused, waiting or blocked (shown on the Tasks board). */
  statusReason: string | null
  /** Next one-time wake-up (null = none scheduled). */
  nextWakeAt: number | null
  /** What the bot told itself to do at that wake-up. */
  nextWakeNote: string | null
  /** That note was written by a run that had read outside content: the wake-up treats it as untrusted. */
  nextWakeTainted?: boolean
  /** After this the goal pauses itself. */
  endAt: number | null
  /** Cloud spend cap for this goal, in USD. */
  maxUsd: number
  maxRunsPerDay: number
  /** Cloud spend so far for this goal, in USD. */
  spentUsd: number
  /** Wake-up runs so far. */
  wakes: number
  lastWakeAt: number | null
  /** Wake-ups in a row with no milestone progress. */
  stall: number
  /** Queued approvals from unattended wake-ups. */
  asks: GoalAsk[]
  createdAt: number
  updatedAt: number
  /** Derived: a wake-up (or a "Continue now") is running right now. */
  running?: boolean
}

/** What the user can change from the Tasks board or the bot details panel. */
export interface GoalPatch {
  status?: 'active' | 'paused' | 'abandoned'
  maxUsd?: number
  maxRunsPerDay?: number
  endAt?: number | null
}

export interface SahilBotApi {
  /** Long-running goals across all bots (Tasks board, bot details). */
  goals: {
    list(): Promise<Goal[]>
    /** Pause, resume or abandon; change the spend cap, daily run cap or end date. */
    update(id: string, patch: GoalPatch): Promise<Goal>
    /** Works on it now in its chat, with the user there to approve anything queued. */
    runNow(id: string): Promise<void>
    onChange(cb: () => void): () => void
  }
}

// ---- Connected apps: SahilBot's local MCP server (main: mcp-server/)

/** Settings → Connected apps → Let apps on this Mac use SahilBot. Off by default; the port is kept so app configs keep working. */
export interface McpServerSettings {
  enabled: boolean
  /** 0 = pick a free port the first time the server starts (then saved here). */
  port: number
}

export interface Settings {
  mcpServer?: McpServerSettings
}

/** An app connected to SahilBot's MCP server. Its token is stored only as a hash. */
export interface McpClientInfo {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  /** Bots this app has chatted with (each in its own chat). */
  bots: number
  /** What of the user's brain it may read (the brain tools). */
  scope: import('./brain-access').BrainScope
}

/** One call to the MCP server (message text is never logged). */
export interface McpActivity {
  at: number
  clientId: string | null
  client: string
  tool: string
  ok: boolean
  detail?: string
  ms?: number
}

export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  /** http://127.0.0.1:<port>/mcp while running. */
  url: string | null
  error: string | null
  /** The saved port is held by another program: the server stayed off until the user picks a new port. */
  portInUse?: number
  clients: McpClientInfo[]
  activity: McpActivity[]
  /** The stdio bridge for apps that only run commands (Claude Desktop). */
  shimPath: string | null
}

/** "Connect an app": the token is shown once, with ready-to-paste configs. */
export interface McpNewClient {
  client: McpClientInfo
  token: string
  snippets: { cursor: string; claudeCode: string; claudeDesktop: string; curl: string; codex?: string; chatgpt?: string }
}

export interface SahilBotApi {
  /** Connected apps (MCP). Changes are only accepted from the main window. */
  mcp: {
    status(): Promise<McpStatus>
    /** newPort: start on a fresh free port (after the saved one was in use); apps then need the new URL. */
    setEnabled(on: boolean, opts?: { newPort?: boolean }): Promise<McpStatus>
    createClient(name: string): Promise<McpNewClient>
    revokeClient(id: string): Promise<McpStatus>
    /** What of the user's brain an app may read (sources, people and clients, topics, sensitive categories). */
    setScope(id: string, scope: Partial<import('./brain-access').BrainScope>): Promise<McpStatus>
    /** People, clients and projects the scope pickers can list. */
    brainNames(): Promise<Array<{ id: string; name: string; type: string; role: string }>>
    /** Fires when the server starts or stops, a client is added or removed, or an app makes a call. */
    onChange(cb: () => void): () => void
  }
}

// ---- Knowledge base: local search over the user's own files (main: src/main/knowledge)

export type KnowledgeSourceKind = 'workspace' | 'project' | 'folder' | 'attached'

export interface KnowledgeSource {
  path: string
  kind: KnowledgeSourceKind
  /** "Workspace", the project's name, or the folder's name. */
  label: string
  spaceId: string | null
  files: number
  chunks: number
  /** Files found but not indexed (too large, no text, secrets). */
  skipped: number
  lastIndexed: number | null
  /** Folders added in Settings or from a chat can be removed; the workspace and project folders can't. */
  removable: boolean
  /** Hit the per-folder file limit. */
  truncated?: boolean
  /** Why this folder isn't indexed (missing, a system folder). */
  problem?: string
}

export interface KnowledgeStatus {
  sources: KnowledgeSource[]
  totals: { files: number; chunks: number; skipped: number }
  /** The Ollama embedding model in use, or null: keyword search only. */
  embedModel: string | null
  /** Passages with an embedding from embedModel. */
  embedded: number
  paused: boolean
  indexing: boolean
  queued: number
  current: string | null
  /** The keyword index: SQLite FTS5, or BM25 over SahilBot's own term table. */
  keyword: 'fts5' | 'terms'
  lastScan: number | null
  /** The model to suggest installing for meaning search. */
  suggestedModel: string
  /** Folders attached to chats that aren't in the knowledge base (opt in with addAttached). */
  attached: string[]
}

export interface KnowledgeHit {
  path: string
  /** path#L12-L30, path#page=3, or the path alone. */
  citation: string
  heading: string | null
  page: number | null
  startLine: number | null
  endLine: number | null
  snippet: string
  score: number
  /** File modification time (ms). */
  modified: number
  kind: string
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[]
  /** 'hybrid': keyword and meaning results fused; 'keyword': BM25 only. */
  mode: 'hybrid' | 'keyword'
}

export interface SahilBotApi {
  /** Settings → Advanced → Knowledge folders and the project home's Knowledge block. */
  knowledge: {
    status(): Promise<KnowledgeStatus>
    /** Opens a folder picker; null when cancelled. */
    addFolder(): Promise<KnowledgeStatus | null>
    /** Opt-in for a folder attached to a chat ("Add to knowledge"). */
    addAttached(path: string): Promise<KnowledgeStatus>
    removeFolder(path: string): Promise<KnowledgeStatus>
    setPaused(paused: boolean): Promise<KnowledgeStatus>
    /** Forgets the index and reads every folder again. */
    rebuild(): Promise<KnowledgeStatus>
    search(query: string, opts?: { folder?: string; k?: number }): Promise<KnowledgeSearchResult>
    /** Shows an indexed file in Finder. */
    reveal(path: string): Promise<void>
    /** Opens an indexed file with its default app. */
    open(path: string): Promise<void>
    onChanged(cb: () => void): () => void
  }
}

// ---------------------------------------------------------------- learning (learning/: while the app is open and idle)

export interface LearningSettings {
  /**
   * "Remember things automatically" (Settings → Memory): bots save what you tell them without being asked,
   * and SahilBot learns while it's open and idle. Default on (unset counts as on).
   */
  enabled?: boolean
  /** May use a cloud model when no local one is available (default on, within the daily cap and the monthly limit). */
  cloudAllowed: boolean
  /** Keys the user set themselves ('enabled', 'cloudAllowed'): migrations to new defaults leave them alone. */
  explicit?: string[]
  /** Daily cap (USD) on cloud spending for learning. */
  dailyUsd: number
}

/** What a learned item is: a memory, a skill, a lesson from a mistake, or memory housekeeping. */
export type LearnedKind = 'memory' | 'skill' | 'lesson' | 'merge' | 'stale' | 'trim'

/** One entry in the learning log (Settings → Memory → Learned). */
export interface LearnedItem {
  id: string
  at: number
  kind: LearnedKind
  /** One line for the list, e.g. the memory's text or the skill's name. */
  title: string
  detail?: string
  /** The chat it was learned from (when there was one). */
  threadId?: string | null
  threadTitle?: string
  /** The bot or project it belongs to (null = shared, about you). */
  spaceId?: string | null
  /** Its source text came from tool output, a web page, another app or another bot: never a rule, and tagged. */
  untrusted: boolean
  /** Where the chat came from when it wasn't the user typing: 'app' (a connected app), 'handoff', 'routine'. */
  origin?: string
  undone: boolean
  /** Undo is still possible (the item hasn't been changed or removed since). */
  canUndo: boolean
  /** Waiting for the user's OK (Approve / Dismiss): a rule from a chat with outside content, or an unverified skill. */
  pending?: boolean
}

export interface LearningStatus {
  /** The setting, with the default worked out. */
  enabled: boolean
  /** Why it isn't learning right now, when it can't ('No local model…', 'Memory is off'…). */
  blocked?: string
  running: boolean
  job?: string
  lastRunAt?: number
  lastSummary?: string
  nextRunAt?: number
  /** The model it will use, and whether that's a cloud model. */
  model?: string
  cloud: boolean
  localAvailable: boolean
  spentTodayUsd: number
  settings: LearningSettings
}

export interface SahilBotApi {
  /** Settings → Memory → Learned. */
  learning: {
    status(): Promise<LearningStatus>
    list(limit?: number): Promise<LearnedItem[]>
    undo(id: string): Promise<LearnedItem[]>
    /** An item waiting for your OK: Approve saves it (then Undo works), Dismiss drops it for good. */
    approve(id: string): Promise<LearnedItem[]>
    dismiss(id: string): Promise<LearnedItem[]>
    /** Starts a pass now (if nothing is running). */
    runNow(): Promise<LearningStatus>
    openChat(threadId: string): Promise<void>
    onChanged(cb: () => void): () => void
  }
}

// ---------- background jobs (dev servers, watchers, long builds) ----------

export type JobStatus = 'starting' | 'running' | 'ready' | 'exited' | 'failed' | 'stopped'

export interface JobInfo {
  id: string
  /** The chat the job belongs to (a helper agent's jobs belong to the chat that started it). */
  threadId: string
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  status: JobStatus
  exitCode: number | null
  signal?: string | null
  pid?: number
  /** Local addresses seen in its output, e.g. http://localhost:5173/ (first = main). */
  urls: string[]
  ports: number[]
  /** Output lines seen so far (the buffer keeps the last ~2000). */
  lines: number
  restarts: number
  /** A warning to show: CPU runaway, very noisy output. */
  warning?: string
  /** Last sampled CPU use of its process group, percent of one core. */
  cpu?: number
}

export type JobEvent =
  | { kind: 'job'; job: JobInfo }
  | { kind: 'lines'; id: string; threadId: string; lines: string[]; total: number }
  | { kind: 'removed'; id: string; threadId: string }

export interface RunUsageModel { model: string; cloud: boolean; calls: number; input: number; output: number; usd: number }
export interface RunUsage { input: number; output: number; usd: number; cloud: boolean; calls: number; models: RunUsageModel[] }

export interface SahilBotApi {
  /** Background jobs started with run_command background: true (Jobs tab). */
  jobs: {
    list(threadId?: string): Promise<JobInfo[]>
    output(id: string, opts?: { tail?: number; grep?: string }): Promise<{ lines: string[]; total: number }>
    stop(id: string): Promise<JobInfo | null>
    restart(id: string): Promise<JobInfo | null>
    /** Forgets a finished job. */
    remove(id: string): Promise<void>
    onEvent(cb: (e: JobEvent) => void): () => void
  }
}

// ---- "Know what I'm working on": opt-in activity awareness (main: src/main/activity)

/** Settings → Privacy & Security → Activity → Know what I'm working on. Off by default; kept only on this Mac. */
export interface ActivitySettings {
  enabled: boolean
  /** Front window titles (needs Accessibility, and System Events once). */
  windowTitles: boolean
  /** The front browser tab's title and address (needs Automation for each browser). */
  browserTabs: boolean
  /** "Let SahilBot learn from my activity": the learning pass may read the timeline. Separate, on by default. */
  learn: boolean
  /** How long the session timeline is kept, 1–72 hours (raw samples: at most 2 hours). */
  retentionHours: number
  /** Apps never recorded (names or bundle ids). */
  excludedApps: string[]
  /** Sites never recorded (domains; subdomains included). */
  excludedDomains: string[]
  /** "Pause for 1 hour": nothing is collected or shared until then. */
  pausedUntil: number | null
  /** "Also share with cloud models": off by default, so only local models get the activity section. */
  shareWithCloud: boolean
}

export interface ActivityPermissionInfo {
  accessibility: boolean
  /** System Events answered (front window titles work). null = not checked yet. */
  systemEvents: boolean | null
  /** Browsers SahilBot may read the front tab of (from the user's last check). */
  browsers: Array<{ app: string; state: PermissionState; detail?: string }>
}

export interface ActivityTimelineItem {
  start: number
  end: number
  label: string
}

export interface ActivityStatus {
  settings: ActivitySettings
  /** Collecting right now (on, not paused, SahilBot running). */
  collecting: boolean
  /** Why it isn't collecting, in words. */
  reason?: string
  permissions: ActivityPermissionInfo
  lastSampleAt: number | null
  samples: number
  sessions: number
  /** Exactly what a bot's next run would get (the whole section), or '' when nothing would be added. */
  preview: string
  /** The last hours of the timeline, newest first. */
  timeline: ActivityTimelineItem[]
  /** The built-in lists, for "what's never recorded". */
  builtIn: { passwordManagers: string[]; messaging: string[]; sensitiveDomains: number }
}

export interface SahilBotApi {
  /** Know what I'm working on. Changes are only accepted from the main window. */
  activity: {
    status(): Promise<ActivityStatus>
    set(patch: Partial<Omit<ActivitySettings, 'pausedUntil'>>): Promise<ActivityStatus>
    /** Pause for `minutes` (default 60); 0 resumes. */
    pause(minutes?: number): Promise<ActivityStatus>
    /** Deletes every sample and the timeline now. */
    clear(): Promise<ActivityStatus>
    /** User-initiated permission check (macOS may show its one-time prompt for System Events or a browser). */
    checkPermissions(): Promise<ActivityStatus>
    onChange(cb: () => void): () => void
  }
}

// ---------------------------------------------------------------- CAD (Onshape)

/** Interface merging (append-only): the Onshape API key pair is saved (Settings → Models & Keys → Advanced → Keys for tools (Onshape)). */
export interface Settings {
  hasOnshapeKeys?: boolean
  /** Which half of the Onshape key pair is saved. */
  onshapeKeyParts?: { access: boolean; secret: boolean }
}

/** Result of Settings → Onshape → Test (GET /users/sessioninfo with the saved keys). */
export interface OnshapeTestResult {
  ok: boolean
  /** The Onshape account the keys belong to. */
  name?: string
  error?: string
}

export interface SahilBotApi {
  /** CAD helpers for Settings. Optional so older preloads still type-check. */
  cad?: {
    onshapeTest(): Promise<OnshapeTestResult>
  }
}

// ---------------------------------------------------------------- Docs (live document workspace)
// A two-way document beside the chat (src/main/docspace): the bot creates and edits it with doc_* tools,
// the user edits it in the Document tab, and every change is a version. Interface merging, append-only.

export type DocBlockType = 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'numbered' | 'check' | 'quote' | 'code' | 'table' | 'divider' | 'image' | 'callout'
export type DocCalloutTone = 'info' | 'tip' | 'warn' | 'danger'

/** One block of a document. Text is inline Markdown (**bold**, *italic*, `code`, [link](url), ~~strike~~). */
export interface DocBlock {
  /** Stable id, e.g. "b7kq": the bot addresses blocks by it. */
  id: string
  type: DocBlockType
  text?: string
  /** List nesting, 0 to 5 (bullet, numbered, check). */
  indent?: number
  checked?: boolean
  /** Code block language. */
  lang?: string
  /** Table cells (inline Markdown), row by row. */
  rows?: string[][]
  /** The table's first row is a header row. */
  header?: boolean
  /** Image: a local file path. */
  src?: string
  alt?: string
  tone?: DocCalloutTone
}

/** A spreadsheet: raw cell inputs by address ("A1": "12", "B3": "=SUM(B1:B2)"). Values are computed locally. */
export interface DocSheet {
  rows: number
  cols: number
  cells: Record<string, string>
  /** Row 1 is a header row. */
  header?: boolean
}

export type DocType = 'doc' | 'sheet'

export interface DocContent {
  title: string
  blocks: DocBlock[]
  sheet?: DocSheet
  /** How the document looks, in the editor and in Word / PDF / HTML exports. */
  style?: DocStyle
  /** 'slides': a native deck (each heading starts a slide; src/shared/slides.ts). */
  kind?: DocKind
}

/** A document's look: its font, text size and theme (src/main/docs/theme.ts). */
export interface DocStyle {
  /** One of DOC_FONTS (installed on every Mac and Windows PC); unset = the theme's own. */
  font?: string
  /** Body text size in points, 9-16. */
  size?: number
  theme?: 'modern' | 'classic' | 'minimal'
}

/** Fonts a document may use: on every Mac and every Windows PC, so a Word file looks the same everywhere. */
export const DOC_FONTS = ['Helvetica', 'Arial', 'Avenir Next', 'Georgia', 'Times New Roman', 'Palatino', 'Verdana', 'Courier New'] as const

export type DocAuthor = 'user' | 'bot'

export interface DocInfo {
  id: string
  threadId: string
  spaceId?: string
  title: string
  type: DocType
  /** The current version number (1 = as created). */
  version: number
  createdAt: number
  updatedAt: number
  lastAuthor: DocAuthor
  lastSummary: string
}

export interface DocVersionInfo {
  n: number
  author: DocAuthor
  at: number
  summary: string
  /** What changed from the version before: block ids, "title", "cell:A1". */
  changed: string[]
}

/** A computed sheet cell: the value, or an error code like "#DIV/0!" / "#CYCLE!". */
export interface DocCellValue { value: number | string; error?: string }

export interface DocSnapshot extends DocInfo {
  content: DocContent
  /** Sheets: computed values by address. */
  computed?: Record<string, DocCellValue>
}

/** Sent to the renderer whenever a document changes. */
export interface DocEvent {
  docId: string
  threadId: string
  version: number
  author: DocAuthor
  summary: string
  changed: string[]
  removed: string[]
}

/** One row of a version diff: a block (or sheet cell) and how it changed. */
export interface DocDiffRow {
  status: 'same' | 'added' | 'removed' | 'changed'
  block: DocBlock
  before?: DocBlock
  /** Word-level diff of the text, for changed text blocks. */
  words?: Array<{ t: 'same' | 'add' | 'del'; s: string }>
}

export interface DocDiff {
  from: number
  to: number
  title?: { before: string; after: string }
  rows: DocDiffRow[]
  cells?: Array<{ addr: string; before: string; after: string }>
}

/** What a document is drawn as: a deck of slides or a dashboard (blocks stay the source of truth). */
export type DocKind = 'slides' | 'dashboard'
export const DOC_KINDS: DocKind[] = ['slides', 'dashboard']

export type DocExportFormat = 'docx' | 'pdf' | 'md' | 'html' | 'xlsx' | 'csv' | 'pptx' | 'pptx_pictures' | 'odp' | 'png'

/** Library items can be live documents (opened in the Document tab). */
export interface LibraryItem {
  docId?: string
}

export interface SahilBotApi {
  docs: {
    /** Documents in a chat, newest change first. */
    list(threadId: string): Promise<DocInfo[]>
    get(id: string): Promise<DocSnapshot>
    create(threadId: string, title: string, type?: DocType | DocKind): Promise<DocSnapshot>
    /** Saves the user's edits made on top of version `base` (merged with any newer bot edit). */
    save(id: string, base: number, content: DocContent): Promise<DocSnapshot>
    versions(id: string): Promise<DocVersionInfo[]>
    version(id: string, n: number): Promise<DocContent>
    diff(id: string, from: number, to: number): Promise<DocDiff>
    restore(id: string, n: number): Promise<DocSnapshot>
    export(id: string, format: DocExportFormat): Promise<string>
    /** Opens a file SahilBot made (Word, PDF, slides, Markdown, text, HTML, Excel, CSV) as an editable document in its chat. */
    importFile(path: string, threadId?: string): Promise<{ docId: string; threadId: string }>
    /** The file a document was opened from, or null. */
    source(id: string): Promise<string | null>
    /** A blank document, deck or sheet in a new chat (Artifacts → Make something new). */
    createNew(kind: 'doc' | 'sheet' | DocKind): Promise<{ docId: string; threadId: string }>
    /** Documents across every chat, newest change first; `slides` marks decks. */
    recent(limit?: number): Promise<Array<DocInfo & { slides: boolean; kind?: DocKind }>>
    /** Saves the document back over its file (backup first) or as a copy: the path written, and whether it was the original. */
    saveBack(id: string, mode: 'replace' | 'copy'): Promise<{ path: string; replaced: boolean }>
    /** Picks an image, copies it into the workspace and returns its path (null if cancelled). */
    addImage(): Promise<string | null>
    /** Tells main whether the editor holds unsaved edits (so the bot's next read waits for them). */
    dirty(id: string, dirty: boolean): Promise<void>
    flushed(id: string): Promise<void>
    onEvent(cb: (e: DocEvent) => void): () => void
    /** Main asks for unsaved edits to be saved now (the bot is about to read or edit). */
    onFlush(cb: (id: string) => void): () => void
  }
}

// ---------------------------------------------------------------- swarms (big cloud teams) and Heavy mode

/** Team of Experts on cloud models: capacity, parallelism and spend per swarm (one agents call). */
export interface SwarmSettings {
  /** Most helper agents per task on a cloud model (1-100, default 30). Local models are RAM-bound instead. */
  maxAgents: number
  /** Helpers running at once on a cloud model (1-32, default 8); halved on a rate limit, then eased back up. */
  maxParallel: number
  /** A swarm (or Heavy run) estimated above this asks the user first (default $1). */
  askAboveUsd: number
  /** Hard cap per swarm (or Heavy run): no new helper starts past it, and requests stop at it (default $5). */
  maxUsd: number
  /** Helper model on the cloud: 'same' as the lead, 'auto' (one tier lower: Sonnet under Opus), or a model id. */
  helperModel: string
}

/** Heavy mode: several independent attempts, then a judge. */
export interface HeavySettings {
  /** Independent attempts (2-8, default 4). */
  attempts: number
  /** 'auto' mixes models on the cloud (2× the lead's, 1× the strongest, 1× another provider when keyed); 'same'; or model ids. */
  mix: 'auto' | 'same' | string[]
}

export interface Settings {
  swarm?: Partial<SwarmSettings>
  heavy?: Partial<HeavySettings>
}

export interface SendInput {
  /** Heavy: several independent attempts, compared by a judge that writes the final answer. */
  heavy?: boolean
}

export interface TeamMember {
  /** Cost so far (cloud models only), from the helper's replies. */
  usd?: number
  /** Tokens so far (prompt + output), from the helper's replies. */
  tokens?: number
}

/** A spend the user is asked to OK before a big swarm or a Heavy run starts. */
export interface SpendApproval {
  kind: 'team' | 'heavy' | 'swarm' | 'council'
  count: number
  model: string
  estimateUsd: number
  capUsd: number
}

export interface PendingRequest {
  /** For an 'approval' that is really a spend OK (a big swarm, a Heavy run): shown as a cost card. */
  spend?: SpendApproval
}

export interface HeavyAttempt {
  id: string
  n: number
  model: string
  label?: string
  /** How this attempt was told to approach the problem (its "seed"). */
  angle: string
  status: TeamMember['status']
  usd?: number
  tokens?: number
  /** Its full answer, once done. */
  answer?: string
  detail?: string
  /** The judge asked it to verify a contested point. */
  rechecked?: boolean
}

export interface HeavyVerdict {
  agreements: string[]
  disagreements: Array<{ point: string; attempts: number[] }>
  errors: Array<{ attempt: number; issue: string }>
  unsupported: Array<{ attempt: number; claim: string }>
  /** The one contested point the judge had an attempt re-check (one round at most). */
  recheck?: { attempt: number; question: string; answer?: string }
  summary?: string
}

/** The Heavy card: kept on a notice message's meta.heavy, updated live. */
export interface HeavyBoard {
  attempts: HeavyAttempt[]
  judge: { model: string; label?: string; status: 'waiting' | 'comparing' | 'rechecking' | 'writing' | 'done' | 'failed' | 'stopped'; verdict?: HeavyVerdict; usd?: number }
  estimateUsd?: number
  capUsd?: number
  spentUsd?: number
  /** Why it ended early (the cap, a stop), if it did. */
  note?: string
}

export interface SahilBotApi {
  swarm: {
    /** Cancels one helper (or Heavy attempt): a queued one never starts, a working one stops. */
    cancel(memberId: string): Promise<boolean>
    /** Stops every helper of a team (or Heavy run) that hasn't finished; the lead carries on with what's done. */
    stopRemaining(groupId: string): Promise<number>
  }
}

// ---------------------------------------------------------------- Media, vision and batch tools (OpenAI / Anthropic keys)

/** Interface merging (append-only): knowledge-search embeddings provider. */
export interface Settings {
  /**
   * "Use OpenAI for knowledge search embeddings" (Settings → Advanced → Knowledge folders). Off by default. Privacy: when on
   * (and an OpenAI key is saved and cloud models are on), passages of the user's indexed documents are
   * sent to OpenAI (text-embedding-3-small) to build the meaning-search index; costs count toward the
   * monthly cloud budget. Off: embeddings stay on this Mac (Ollama) or keyword search alone.
   */
  openaiEmbeddings?: boolean
}

// ---------------------------------------------------------------- Bot swarms (temporary helpers) and Council mode

/** A bot's swarm setting: never, the bot decides (default), or every request. */
export type BotSwarmMode = 'off' | 'auto' | 'always'

/** Per-bot swarm settings (Settings.botSwarm[botId]; spaces.ts botSwarmConfig fills the defaults). */
export interface BotSwarmSettings {
  mode: BotSwarmMode
  /** Most temporary helpers per swarm (1-50, default 20). */
  maxHelpers: number
  /** What one swarm may spend in a routine or goal wake-up, never asking (USD; 0 = no swarms unattended). Default $1. */
  routineUsd: number
}

/** Council mode: frontier models from different providers plan, critique, merge, execute and review together. */
export interface CouncilSettings {
  /** 'auto' = the best Claude + the best GPT available; or model ids (2-4). */
  members: 'auto' | string[]
  /** Review rounds before it stops (1-4, default 2). */
  rounds: number
}

export interface Settings {
  /** Per-bot swarm settings, by bot id. */
  botSwarm?: Record<string, Partial<BotSwarmSettings>>
  council?: Partial<CouncilSettings>
}

export interface SendInput {
  /** Swarm for this message (a bot chat): the bot runs temporary helpers, then compiles. */
  swarm?: boolean
  /** Council for this message: true = Auto members, or the chosen model ids. */
  council?: boolean | string[]
}

/** What a swarm helper is for, which sets its model: cheap breadth, solid work, or the hardest slices. */
export type HelperRole = 'breadth' | 'solid' | 'hard' | 'review'

/** One temporary helper on the swarm card. */
export interface SwarmHelperView {
  id: string
  /** H1, H2… (the credit tags in the compiled answer). */
  n: number
  title: string
  /** Its distinct angle (ideation) or its slice of the work (divide and conquer). */
  angle: string
  role: HelperRole
  model: string
  label?: string
  status: TeamMember['status']
  detail?: string
  usd?: number
  tokens?: number
  /** Idea titles parsed from its output so far. */
  ideas?: string[]
  /** Its final output (shortened). */
  report?: string
  /** Its hidden thread, for the transcript. */
  childId?: string
  /** Sent back to deepen or critique in round 2. */
  refined?: boolean
  /** How often the compiled answer credits it ([H3] tags). */
  credit?: number
}

/** The swarm card: kept on a notice message's meta.swarm, updated live. */
export interface SwarmBoard {
  swarmId: string
  bot?: string
  pattern: 'ideate' | 'divide'
  goal: string
  helpers: SwarmHelperView[]
  phase: 'running' | 'compiling' | 'refining' | 'done' | 'stopped' | 'failed'
  lead: { model: string; label?: string }
  /** The model that drafted the compile (the strongest), when it isn't the lead. */
  compiler?: { model: string; label?: string }
  /** How the helper count was chosen. */
  sizing?: string
  /** "Mixed models chosen by role (routing table)". */
  routing?: string
  ideas?: { total: number; distinct: number }
  compiled?: { excerpt: string; credits: Array<{ n: number; count: number }> }
  estimateUsd?: number
  capUsd?: number
  spentUsd?: number
  unattended?: boolean
  note?: string
}

export interface CouncilMemberView {
  id: string
  model: string
  label?: string
  provider?: string
  /** The chair merges the plans and writes the final answer. */
  chair: boolean
  /** A critic seat: critiques and reviews, never plans, executes or writes the answer. */
  critic?: boolean
  status: 'waiting' | 'working' | 'done' | 'failed' | 'stopped'
  detail?: string
  usd?: number
  plan?: string
  critique?: string
  /** Its sign-off on the merged plan. */
  planOk?: boolean
  objections?: string[]
  childId?: string
}

export interface CouncilStep {
  n: number
  text: string
  /** Member index (0-based) that owns it. */
  owner: number
  /** Done by an outside agent (Cursor) that the owner instructs and the other member reviews. */
  via?: 'cursor'
  repo?: string
  status: 'queued' | 'working' | 'done' | 'failed' | 'skipped'
  output?: string
  /** Cursor: the instructions the owner wrote (after the other member's review). */
  instructions?: string
}

export interface CouncilReview {
  round: number
  by: number
  of: number
  ok: boolean
  notes: string
}

/** The Council card: kept on a notice message's meta.council, updated live. */
export interface CouncilBoard {
  councilId: string
  goal: string
  members: CouncilMemberView[]
  phase: 'planning' | 'critiquing' | 'merging' | 'deciding' | 'executing' | 'reviewing' | 'writing' | 'done' | 'stopped' | 'failed'
  merged?: { summary?: string; steps: CouncilStep[] }
  disagreements: Array<{ point: string; positions: Array<{ member: number; view: string }>; resolution?: string }>
  /** A second opinion on the merged plan from a third provider (when the chair asked for one). */
  secondOpinion?: { model: string; label?: string; text: string }
  reviews: CouncilReview[]
  round: number
  maxRounds: number
  /** Why it stopped: everyone signed off, the round limit, the budget cap, a stop. */
  stopReason?: string
  estimateUsd?: number
  capUsd?: number
  spentUsd?: number
  note?: string
}

// ---- Fast mode, monthly spending limit and the usage dashboard (llm/fast-mode.ts, llm/budget.ts, usage.ts) ----

/** A faster, pricier service tier: Anthropic speed "fast", OpenAI service_tier fast / ultrafast, xAI priority. */
export type FastTier = 'fast' | 'ultrafast'
/** Per-model Fast mode: follow the provider's switch, always on, always off, or OpenAI Ultrafast (Astra, 6.1 Sol). */
export type FastChoice = 'inherit' | 'on' | 'off' | 'ultrafast'

export interface FastModeSettings {
  /** Fast mode for every supported model of a provider (off by default). */
  providers: { anthropic: boolean; openai: boolean; xai: boolean }
  /** Per-model overrides by model id ('inherit' is not stored). */
  models: Record<string, Exclude<FastChoice, 'inherit'>>
  /** When Auto picks the model: 'speed' (default) only for speed-sensitive requests, 'allowed' whenever allowed, 'never'. */
  auto: 'speed' | 'allowed' | 'never'
}

/**
 * The monthly spending limit: 'amount' caps pay-per-use API spend at cloudBudgetUsd; 'unlimited' has no cap
 * (spend is still shown); 'none' turns pay-per-use API spending off (only a ChatGPT plan via Codex and local
 * models run). Unset: derived from cloudBudgetUsd (> 0 = 'amount', 0 = 'none', as $0 always refused requests).
 */
export type SpendingMode = 'amount' | 'unlimited' | 'none'

export interface Settings {
  fastMode?: FastModeSettings
  spendingMode?: SpendingMode
}

/** Token detail for usage rows (the providers' own counts; cost is in usd). */
export interface UsageTokens {
  requests: number
  /** Uncached input tokens. */
  input: number
  /** Input tokens read from the prompt cache. */
  cached: number
  /** Input tokens written to the prompt cache. */
  cacheWrite: number
  /** Output tokens as billed (visible output plus reasoning). */
  output: number
  /** The part of output that was reasoning, when the provider reports it. */
  reasoning: number
  usd: number
}

/** Settings → Usage: the full dashboard (spend against the monthly limit, charts, lifetime, breakdowns). */
export interface UsageDashboard {
  now: number
  month: string
  limit: { mode: SpendingMode; cap: number; spent: number; requests: number }
  week: { start: number; usd: number; requests: number; tokens: number }
  monthTotals: { usd: number; requests: number; tokens: number }
  lifetime: UsageTokens & { since: number | null; local: { requests: number; input: number; output: number } }
  /** Last 30 days, oldest first; tokens = input + cached + cacheWrite + output. */
  days: Array<{ day: string; tokens: number; cloudTokens: number; localTokens: number; usd: number; requests: number }>
  /** Last 12 weeks (weeks start Monday), oldest first. */
  weeks: Array<{ start: string; tokens: number; cloudTokens: number; localTokens: number; usd: number; requests: number }>
  /** This month, per model and per provider; share = part of this month's tokens (0..1). */
  byModel: Array<UsageTokens & { model: string; provider: string; where: 'local' | 'cloud'; fastRequests: number; webCalls: number; share: number }>
  byProvider: Array<UsageTokens & { provider: string; name: string; where: 'local' | 'cloud'; share: number }>
  /** This month, per bot; share = part of this month's cloud spend. */
  byBot: Array<{ spaceId: string | null; name: string; color: string | null; requests: number; tokens: number; usd: number; share: number }>
}

/** The compact usage card (sidebar profile menu, ⌘K "Usage"). */
export interface UsageGlance {
  month: string
  mode: SpendingMode
  cap: number
  spent: number
  weekUsd: number
  lifetimeUsd: number
  /** Last 7 days of tokens, oldest first. */
  days: number[]
}

// ---------- the knowledge vault (src/main/vault; types in ./vault) ----------

export interface SahilBotApi {
  /** The knowledge vault: Obsidian-style notes your bots keep (Vault view, Settings → Memory). Not the password vault (`vault`). */
  notesVault: {
    status(): Promise<import('./vault').VaultStatus>
    setSettings(patch: import('./vault').VaultSettingsPatch): Promise<import('./vault').VaultStatus>
    /** One bot's vault setting (on/off, how much to remember); null fields go back to the default. */
    setBot(spaceId: string, patch: { enabled?: boolean | null; level?: import('./vault').VaultLevel | null }): Promise<import('./vault').VaultStatus>
    list(): Promise<import('./vault').VaultNoteInfo[]>
    read(path: string): Promise<import('./vault').VaultNoteFull | null>
    /** A [[link]] or title → its note's path (looked up from `from`'s area first). */
    resolve(ref: string, from?: string): Promise<string | null>
    search(query: string): Promise<import('./vault').VaultSearchHit[]>
    /** Saves the user's edit of a whole note (a copy of the old one goes to .history). */
    save(path: string, text: string): Promise<import('./vault').VaultNoteFull | null>
    /** A new note (by title) in an area ("Shared" or "Bots/<name>"); returns its path. */
    create(o: { title: string; type?: import('./vault').VaultNoteType; section?: string }): Promise<string>
    /** Moves a note to the vault's trash (Undo in Changes puts it back). */
    trash(path: string): Promise<void>
    graph(): Promise<import('./vault').VaultGraph>
    changes(limit?: number): Promise<import('./vault').VaultChangeInfo[]>
    undo(id: string): Promise<import('./vault').VaultChangeInfo[]>
    /** Opens the vault (or a note) in Obsidian when it's installed, else shows it in Finder. */
    openInObsidian(path?: string): Promise<'obsidian' | 'finder'>
    reveal(path?: string): Promise<void>
    /** Zips the vault (notes only) into the workspace's exports folder; returns the file. */
    exportZip(): Promise<string>
    /** Compiles now (a learning pass) unless one is running or a chat is working. */
    compileNow(): Promise<import('./vault').VaultStatus>
    /** "Use my Obsidian vault": the vaults Obsidian lists (folder exists, has .obsidian/), newest first. */
    obsidianDetect(): Promise<import('./vault').ObsidianVaultChoice[]>
    /** A folder picker for the vault; null when cancelled. `isVault: false` = no .obsidian/ folder (allowed, with a warning). */
    obsidianPick(): Promise<import('./vault').ObsidianFolderCheck | null>
    /** The user's own notes in their Obsidian vault (read-only; paths "obsidian:…"). */
    obsidianNotes(): Promise<import('./vault').VaultNoteInfo[]>
    /** Copies the notes in SahilBot's previous folder into the vault's SahilBot subfolder (the old folder is left as it was). */
    obsidianCopyExisting(): Promise<{ copied: number; renamed: number; from: string; to: string }>
    /** Looks for edits made in Obsidian now. */
    obsidianRescan(): Promise<import('./vault').VaultStatus>
    onChanged(cb: () => void): () => void
  }
  /** People & Places: the context engine's entity graph (src/main/context-engine; Vault view → People & Places). */
  people: import('./context-engine').PeopleApi
  /** Your brain: scheduled reading of connected accounts, "Written for you" briefs, Agent mode (src/main/brain). */
  brain: import('./brain').BrainApi
}

/** Settings → Models → Fast mode: one supported model the user has (llm/fast-mode.ts). */
/** One speed a model can run at, with its penalty (Settings → Models → Fast mode). */
export interface FastSpeedOption {
  tier: 'standard' | FastTier
  /** "Standard", "Fast", "Ultrafast" (xAI: "Priority"). */
  title: string
  /** "up to 4.5x faster" */
  speed: string
  /** Price multiplier on the standard rate, in force now. */
  factor: number
  /** A dated price: the last day `factor` applies (Pacific time) and the multiplier after it. */
  until?: string
  then?: number
  /** "Ultrafast · up to 4.5x faster · 3x price ($24 / $120 per M) until Feb 28, 2027, then 6x ($48 / $240)" */
  line: string
  /** The other costs the provider's docs state (rate limits, downgrades, API, residency). */
  tradeoffs: string[]
}

export interface FastCatalogRow {
  id: string
  label: string
  provider: 'anthropic' | 'openai' | 'xai'
  /** Price multiplier at Fast (and Ultrafast, where offered: today's multiplier). */
  factor: number
  ultrafast?: number
  /** The Fast (and Ultrafast) penalty lines, joined. */
  tradeoff: string
  /** Standard, Fast and (where offered) Ultrafast, each with its penalty. */
  options: FastSpeedOption[]
  /** Switched on in the picker (older, superseded models are listed but start off). */
  enabled?: boolean
  note?: string
}

export interface ForemanFastApi {
  catalog(): Promise<FastCatalogRow[]>
}

export interface SahilBotApi {
  /** Settings → Models → Fast mode: the supported models the user has, with each one's speed / price trade-off. */
  fast: ForemanFastApi
}

// ---- Computer use: Planner + executor (src/main/agent/cua) ----

/** Settings → Models → Computer use. */
export interface ComputerUseSettings {
  /** 'auto' (default): Planner + executor for multi-step computer use; 'single': one model; 'pair': always Planner + executor. */
  mode?: 'auto' | 'single' | 'pair'
  /** Executor model: '' = Auto (from the computer-use evidence), or a model id. */
  executor?: string
  /** Planner model: '' = Auto (by difficulty, from the routing table), or a model id. */
  planner?: string
}

export interface Settings {
  computerUse?: ComputerUseSettings
}

export interface Settings {
  /**
   * Per-model context window (Settings → Models → Context window): model id → tokens. Missing = Default (the
   * context strategy decides). Only sizes the model's provider offers are offered (shared/context-choices.ts);
   * the main process applies the choice exactly, clamped only to the provider's maximum (llm/context-window.ts).
   */
  modelContext?: Record<string, number>
}

// ---- Attachments, working folders and cloud-first local opt-in (main: attachments.ts, attach-process.ts,
// knowledge/folder-scan.ts, settings.ts; renderer: components/Attachments.tsx, lib/attachments.ts) ----

/** What an attached file is, for its chip and for how the agent reads it. */
export type AttachCategory = 'image' | 'pdf' | 'office' | 'text' | 'code' | 'binary' | 'folder'

export interface Attachment {
  /** What kind of file it is (set by main when it registers the file). */
  category?: AttachCategory
  /** Its MIME type, when known. */
  mime?: string
  /** One line about it for the chip's tooltip and the agent (e.g. "HEIC converted to JPEG", "binary, can't be read as text"). */
  note?: string
  /** Folders: files SahilBot can index (after ignore rules), and whether that count hit the limit. */
  files?: number
  truncated?: boolean
}

/** Result of adding dropped, pasted or picked items: what was attached, and what wasn't (with why). */
export interface AttachResult {
  added: Attachment[]
  rejected: Array<{ name: string; reason: string }>
}

/** Progress of a folder scan (counting what can be indexed, ignore rules applied). */
export interface FolderScanEvent {
  path: string
  files: number
  bytes: number
  done: boolean
  truncated?: boolean
}

/** A chat's working folder: where relative paths and commands start. source: who chose it. */
export interface WorkingFolder {
  path: string | null
  source: 'chat' | 'bot' | 'project' | null
}

export interface SendInput {
  /** The chat's working folder chosen before the chat existed (a path the user picked); null clears it. */
  workingFolder?: string | null
}

/**
 * Local models (Ollama, LM Studio, a custom server) are opt-in. enabled false: nothing installs or
 * downloads local models, Auto never routes to them, warm-up never runs and nothing asks about them.
 */
export interface LocalSettings {
  enabled: boolean
  /** Set when the choice came from migrating an existing install (local models found on this Mac). */
  migrated?: boolean
}

/** Speech output when local voices are off: OpenAI's TTS (needs a key and this switch) or the Mac's own voice. */
export interface VoiceOutputSettings {
  provider?: import('./voice-provider').CloudSpeechProvider
  /** Use OpenAI text-to-speech when an OpenAI key is saved (paid, priced against the monthly cap). Default off. */
  openai?: boolean
}

export interface Settings {
  local?: LocalSettings
  voiceOutput?: VoiceOutputSettings
  voiceInput?: VoiceInputSettings
  /** The voice bar's voice, speed and language. */
  voiceStyle?: VoiceStyle
}

export interface KnowledgeStatus {
  /** Local models are off: meaning search uses OpenAI embeddings only if turned on, else keyword search. */
  localOff?: boolean
}

export interface VoiceStatus {
  /** The engine replies are spoken with: 'kokoro' (local), 'openai' (OpenAI TTS) or 'say' (the Mac's voice). */
  output?: 'kokoro' | 'openai' | 'xai' | 'say'
  /** Speech recognition for voice input: 'whisper' (this Mac), 'openai' (OpenAI transcription) or 'none' (inputNote says what it needs). */
  input?: 'whisper' | 'openai' | 'xai' | 'none'
  inputNote?: string
  /** Speech recognition on this Mac (src/main/voice/models.ts): the Whisper model picked for it and its download. */
  speech?: VoiceSpeechStatus
}

/** Settings → Voice: the Whisper model voice input uses, why, and where its background download is. */
export interface VoiceSpeechStatus {
  /** Model id, e.g. 'large-v3-turbo-q5_0'. */
  model: string
  /** "Whisper large-v3-turbo" and its build ("5-bit"). */
  label: string
  build: string
  mb: number
  /** "best for your Mac", "fastest on this Mac" or "you chose it"; `why` is the one-sentence reason. */
  reason: string
  why: string
  /** 'auto' or a pinned model id (Settings → Voice → Advanced). */
  choice: string
  /** Transcribe on this Mac (default on). */
  local: boolean
  ready: boolean
  /** Another downloaded model in use until the picked one is ready. */
  using?: { model: string; label: string }
  state: 'ready' | 'downloading' | 'waiting' | 'error' | 'off'
  progress?: number
  error?: string
  /** The one-time benchmark's time for this model (ms). */
  bench?: number
  /** Test runs: downloads are recorded, never fetched. */
  stub?: boolean
  /** Files asked for this session (only speech models: Whisper, Silero). */
  requested: string[]
}

/** Speech recognition preferences (Settings → Voice → Advanced). */
/** How the voice sounds and listens (the voice bar's settings): per-engine voice, speed, and spoken language. */
export interface VoiceStyle {
  /** The chosen voice for each engine (ids differ by engine). */
  voices?: Partial<Record<'kokoro' | 'openai' | 'xai' | 'say', string>>
  /** 0.5 to 2 (1 = normal). */
  speed?: number
  /** 'auto' or a language code ('en', 'es', …) for speech recognition. */
  language?: string
}

/** What the voice bar can offer now: the engine speaking, its voices, and the current choices. */
export interface VoiceBarOptions {
  engine: 'kokoro' | 'openai' | 'xai' | 'say'
  engineLabel: string
  voices: Array<{ id: string; label: string; desc: string }>
  voice: string
  speed: number
  /** False when this engine can't change speed. */
  speedOk: boolean
  language: string
  languages: Array<{ id: string; label: string }>
  /** The cloud voices to pick from (ChatGPT's or Grok's) and whether each has its key. */
  providers: Array<{ id: 'openai' | 'xai'; label: string; ready: boolean }>
  provider: 'openai' | 'xai' | null
}

/** A finished voice conversation in a chat, folded into one line (the notice's meta.voiceSession). */
export interface VoiceSession { startedAt: number; endedAt: number; title: string; seconds: number }

export interface VoiceInputSettings {
  /** Transcribe with Whisper when local models and local speech are both enabled. */
  local?: boolean
  /** 'auto' (default: picked for this Mac) or a Whisper model id. */
  model?: string
  /** The one-time benchmark (voice/models.ts). */
  bench?: { model: string; ms: number; at: number }
}

export interface SahilBotApi {
  /** Attachments for the composer: dropped/pasted items, screenshots and folder scans (main: attachments.ts). */
  attach: {
    /** Dropped or pasted File objects: ones with a path are registered; ones without (a pasted screenshot, an image dragged from a browser) are saved to a temp file first. */
    fromFiles(files: File[]): Promise<AttachResult>
    /** Region screenshot (macOS screencapture -i): only from the user's click; null if cancelled. */
    screenshot(): Promise<Attachment | null>
    /** Counts what SahilBot can index in a folder the user attached (progress through onScan). */
    scanFolder(path: string): Promise<FolderScanEvent>
    onScan(cb: (e: FolderScanEvent) => void): () => void
    /** The chat's working folder (its own choice, else the bot's or project's folder). */
    folder(threadId: string): Promise<WorkingFolder>
    /** Opens the folder picker and sets it as the chat's working folder (null when cancelled). */
    pickFolder(threadId: string): Promise<WorkingFolder | null>
    clearFolder(threadId: string): Promise<WorkingFolder>
    /** A folder picked earlier this session becomes the chat's working folder again (the Folder chip's recent list). */
    useFolder(threadId: string, path: string): Promise<WorkingFolder>
    /** A bot's default working folder ("Works in folder"): picker, or null to clear. */
    pickBotFolder(spaceId: string): Promise<Space | null>
    clearBotFolder(spaceId: string): Promise<Space>
    /** The picker (files or folders), processed like a drop: what was added and what wasn't. */
    pick(kind: 'files' | 'folder'): Promise<AttachResult>
  }
  /** Local models opt-in (Settings → Models, onboarding). */
  local: {
    status(): Promise<{ enabled: boolean; installed: boolean }>
    set(enabled: boolean): Promise<Settings>
  }
}

// ---------------------------------------------------------------- Always-on bots: autonomy, questions, digest
// (main: agent/questions/**, goals/digest.ts; renderer: NeedsYou.tsx, BotDetails.tsx)

/** Per-bot always-on settings (Settings.botAutonomy[botId]; agent/questions/policy.ts fills the defaults). */
export interface BotAutonomySettings {
  /** "Always ask for…": approval-rule phrases ("send email", "tool:github__*") that always ask in this bot, whatever its level. */
  alwaysAsk: string[]
  /** How long a posted question waits before the bot goes ahead with its recommended default (hours, 0.25-168; default 4). */
  deadlineHours: number
  /** The daily digest: what the bot did, what's pending, what needs you. */
  digest: { enabled: boolean; time: string }  /**
   * "Can message without asking": emails and phone numbers this bot may email or text without asking, in
   * Auto, also unattended (agent/trusted.ts). The user's own (Settings.me) always count. Omitted when empty.
   */
  trustedRecipients?: string[]
}

/** One question in a queued question card. */
export interface QueueQuestion {
  question: string
  options?: string[]
  /** The bot's recommended default, used if nobody answers by the deadline (only when that is safe). */
  default?: string
  /** The bot marked this a preference: the answer is remembered so it isn't asked again. */
  preference?: boolean
  /** false: the bot said going ahead with the default without the user is not safe (the deadline never picks it). */
  safe?: boolean
}

/** A pending question or approval across all bots (the "Needs you" inbox). */
export interface NeedsYouItem {
  id: string
  /** 'queue': persisted, the bot kept working. 'live': a card open in a running chat right now. 'brain': Agent mode reaching out (src/main/brain). */
  source: 'queue' | 'live' | 'brain'
  botId: string
  botName: string
  threadId: string
  kind: 'question' | 'approval' | 'other' | 'prompt'
  /** A brain prompt ("Sarah Lee asked for the revised proposal by Friday. Draft it?"): its actions and sources. */
  prompt?: { text: string; detail?: string; actions: import('./brain').BrainPromptAction[]; chips: import('./brain').SourceChip[]; question?: boolean; placeholder?: string; auto?: boolean }
  questions?: QueueQuestion[]
  approval?: { tool: string; label: string; summary?: string; reason?: string; folder?: string }
  status: 'open' | 'answered' | 'defaulted' | 'cancelled'
  /** Why this never goes ahead on its own (a hard stop: money, credentials, deleting, mass sends, public posts, "always ask"). */
  hardStop?: string
  deadline?: number | null
  /** The deadline passed but there was no safe default: it waits for you. */
  expired?: boolean
  answers?: string[]
  answeredBy?: 'user' | 'default'
  /** The bot went ahead with its default: shown under "For your review" until you OK or change it. */
  review?: boolean
  createdAt: number
  answeredAt?: number
}

export interface Settings {
  /** Per-bot always-on settings, by bot id. */
  botAutonomy?: Record<string, Partial<BotAutonomySettings>>
}

export interface SahilBotApi {
  /** The "Needs you" inbox: pending questions and approvals across all bots (main: agent/questions). */
  needsYou: {
    list(): Promise<NeedsYouItem[]>
    /** Answers a question (one answer per question), or 'approve' / 'deny' for an approval. A later answer resumes the bot. A brain prompt: [action id, typed answer?]. */
    answer(id: string, answer: string[] | 'approve' | 'always' | 'deny'): Promise<NeedsYouItem | null>
    /** "Looks good" on an assumption the bot made: it leaves the review list. */
    reviewed(id: string): Promise<void>
    onChange(cb: () => void): () => void
  }
  botAutonomy: {
    /** A bot's autonomy level: saved for its new chats and applied to its open conversations. */
    setLevel(spaceId: string, level: PermissionMode): Promise<void>
  }
}

// ---- SahilBot Server (src/server, docs/server.md) and the Mac app's link to one ----

export interface ServerDeviceInfo {
  id: string
  name: string
  kind: 'browser' | 'app'
  createdAt: string
  lastSeen?: string
  lastIp?: string
  revokedAt?: string
  /** The device making this call. */
  current?: boolean
  /** Open tabs right now. */
  sessions: number
  /** Web Push is set up on it. */
  push?: boolean
}

export interface ServerAuditEntry { at: string; kind: string; ip?: string; device?: string; detail?: string }

export interface ServerInfo {
  runtime: 'server'
  version: string
  platform: string
  arch: string
  node: string
  /** Where it listens (e.g. http://127.0.0.1:8787). */
  url: string
  tls: boolean
  selfSigned: boolean
  /** Seconds. */
  uptime: number
  memory: { rssMB: number; heapMB: number; totalMB: number; freeMB: number }
  load: number[]
  cores: number
  runs: { limit: number; running: number; queued: number; pressure: boolean; maxRunning: number; admitted: number }
  helperCeiling: number | null
  keySource: 'credential' | 'env' | 'passphrase' | 'keyfile'
  push: boolean
  /** Electron-only features that are off here. */
  unavailable: string[]
}

export interface ServerApi {
  info(): Promise<ServerInfo>
  devices(): Promise<ServerDeviceInfo[]>
  revokeDevice(id: string): Promise<ServerDeviceInfo[]>
  renameDevice(id: string, name: string): Promise<ServerDeviceInfo[]>
  /** A one-time code (10 minutes) to pair another phone or computer. */
  pairingCode(): Promise<{ code: string; expires: number }>
  audit(limit?: number): Promise<ServerAuditEntry[]>
  /** Web Push: the server's public key, then this browser's subscription. */
  pushKey(): Promise<string | null>
  pushSubscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<boolean>
  pushUnsubscribe(): Promise<boolean>
  /** A test notification to this device. */
  pushTest(): Promise<{ delivered: string[]; queued: string[]; pushed: string[] }>
  /** Phone access: the Mac this phone uses, and this phone's own entry. */
  phoneInfo?(): Promise<PhoneHostInfo>
  /** Signs this device out (it needs a new code to come back). */
  signOut?(): Promise<void>
}

export interface RemoteServerStatus {
  /** Paired with a server. */
  linked: boolean
  url?: string
  deviceName?: string
  /** Reachable right now (null = not checked). */
  online?: boolean | null
  error?: string
  /** Pinned self-signed certificate (SHA-256), when the server uses one. */
  pinned?: string
  info?: { version: string; uptime: number; bots: number; running: number; queued: number; routines: number; rssMB: number; platform: string; arch: string }
}

/** The Mac link (src/main/mac-link.ts): on the Mac, whether the server may use it; on the server, whether a Mac is online. */
export interface MacLinkStatus {
  server: boolean
  linked?: boolean
  allow?: boolean
  tools?: string[]
  keepAwake?: boolean
  connected?: boolean
  error?: string
  awake?: boolean
  available?: Array<{ id: string; what: string }>
  /** What the server did on this Mac, newest first. */
  log?: Array<{ at: number; what: string; effect: string; ok: boolean; note: string }>
  /** On the server: the linked Mac. */
  online?: boolean
  name?: string
  lastSeen?: number
}

export interface RemoteServerApi {
  status(refresh?: boolean): Promise<RemoteServerStatus>
  /** The Mac link: status, and (on the Mac) whether the server may use this Mac. */
  macLink?(): Promise<MacLinkStatus>
  setMacLink?(patch: { allow?: boolean; keepAwake?: boolean; tools?: string[] }): Promise<{ ok: boolean }>
  /** Pairs with a server (URL + one-time code from it). */
  connect(url: string, code: string): Promise<RemoteServerStatus>
  disconnect(): Promise<RemoteServerStatus>
  /** Opens the server's web UI in the browser, already signed in (a one-time code in the link's fragment). */
  openUi(): Promise<void>
}

export interface WorkerView {
  id: string
  name: string
  url: string
  online?: boolean
  capacity?: number
  active?: number
  error?: string
}

export interface WorkerPlacement {
  botId: string
  workerId: string | null
  pending?: { workerId: string | null }
}

export interface WorkerApi {
  list(refresh?: boolean): Promise<{ workers: WorkerView[]; placements: WorkerPlacement[] }>
  pair(input: { name: string; url: string; code: string; fingerprint?: string }): Promise<void>
  capacity(workerId: string, slots: number): Promise<void>
  assign(botId: string, workerId: string | null): Promise<void>
  open(workerId: string | null, botId?: string): Promise<void>
}

// ---- Phone access: the Mac app serves its own UI to the user's paired phones (src/main/phone, docs/phone-access.md)

export interface PhoneAccessAddress { ip: string; kind: 'lan' | 'tailscale'; iface: string; listening: boolean }

export interface PhoneAccessStatus {
  enabled: boolean
  /** Listening on at least one address right now. */
  running: boolean
  /** Why it isn't running (no Wi-Fi, the port is taken, the Keychain is locked…). */
  error?: string
  port: number
  /** Which networks to answer on. */
  lan: boolean
  tailscale: boolean
  addresses: PhoneAccessAddress[]
  tailscaleInfo: { installed: boolean; connected: boolean; ip?: string; dnsName?: string }
  /** This Mac's Bonjour name (name.local), when it has one. */
  localName?: string
  /** The certificate's SHA-256 fingerprint (AB:CD:…), which the QR code carries for the phone to check. */
  fingerprint?: string
  /** The live one-time pairing code and its link (the QR code's path, one unit per module). */
  pairing?: { code: string; expires: number; url: string; via: 'lan' | 'lan-ip' | 'tailscale'; qr: { d: string; size: number } }
  devices: ServerDeviceInfo[]
}

export interface PhoneAccessApi {
  status(): Promise<PhoneAccessStatus>
  setEnabled(on: boolean): Promise<PhoneAccessStatus>
  setOptions(o: { lan?: boolean; tailscale?: boolean }): Promise<PhoneAccessStatus>
  /** A new one-time code and QR link (10 minutes), for the home network (by name or by address) or Tailscale. */
  newCode(via?: 'lan' | 'lan-ip' | 'tailscale'): Promise<PhoneAccessStatus>
  revoke(id: string): Promise<PhoneAccessStatus>
  rename(id: string, name: string): Promise<PhoneAccessStatus>
  audit(limit?: number): Promise<ServerAuditEntry[]>
  onChange(cb: () => void): () => void
}

/** What a phone connected to the Mac sees about it (Settings on the phone). */
export interface PhoneHostInfo { mac: string; version: string; device?: ServerDeviceInfo }

export interface SahilBotApi {
  /** 'server' in a browser connected to SahilBot Server; 'electron' (or missing) in the Mac app. */
  runtime?: 'electron' | 'server'
  /** In a browser: who serves it. 'mac' = a phone using the Mac app through Phone access; 'server' = SahilBot Server. */
  serverHost?: 'mac' | 'server'
  /** SahilBot Server only: paired devices, pairing codes, the audit log, notifications. */
  server?: ServerApi
  /** Mac app only: Settings → Always-on server. */
  remoteServer?: RemoteServerApi
  /** Mac app only: paired machines and bot placement. */
  workers?: WorkerApi
  /** Mac app only: Settings → General → Phone access. */
  phoneAccess?: PhoneAccessApi
  /** Mac app only: Team access (teammates ask your brain), under Phone access. */
  team?: import('./brain-access').TeamApi
}

export interface ModelList {
  /** Local models are switched off (cloud only): the picker hides Auto (local) and offers no downloads. */
  localOff?: boolean
}

// ---------------------------------------------------------------- Max mode (one mode for many agents)

/**
 * Max: many agents at once. SahilBot's strategy planner (agent/max/planner.ts) picks how for each request:
 * a research team (divide and conquer), an idea swarm (independent divergent helpers, then a compile),
 * competing attempts with a judge (Heavy), or a hybrid (explore first, then judged attempts on the deliverable).
 */
export type MaxStrategy = 'team' | 'swarm' | 'heavy' | 'hybrid'
/** One phase of a Max run (a hybrid has two). */
export type MaxPhaseKind = 'team' | 'swarm' | 'heavy'

/** A bot's Max setting: Off (only when you turn it on in the composer), Auto (teams up only for big tasks; default), Always. */
export interface BotMaxSettings {
  mode: BotSwarmMode
  /** Most helpers per Max run (1-50, default 20). */
  maxHelpers: number
  /** What one Max run may spend in a routine or goal wake-up, never asking (USD; 0 = none unattended). Default $1. */
  routineUsd: number
}

export interface Settings {
  /** Per-bot Max settings (Settings → bot details). Older installs kept these as botSwarm: migrated on start. */
  botMax?: Record<string, Partial<BotMaxSettings>>
}

export interface SendInput {
  /** Max for this message: the planner picks a team, a swarm, judged attempts or a mix. */
  max?: boolean
  /** Tests and the max tool: skip the planner and use this strategy. */
  maxStrategy?: MaxStrategy
}

export interface MaxPhase {
  kind: MaxPhaseKind
  /** "Research team", "Idea swarm", "Judged attempts". */
  label: string
  status: 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped'
  note?: string
}

/** The Max card: kept on a notice message's meta.max, updated live. Phases embed the team, swarm and Heavy boards. */
export interface MaxBoard {
  maxId: string
  strategy: MaxStrategy
  /** "idea swarm → judged final draft". */
  title: string
  /** Why the planner chose it, in a few words. */
  why: string
  /** Who turned Max on: the composer, the bot's Max setting (Always), Auto (a big task: max/auto-teamwork.ts), or the lead's max tool. */
  source: 'composer' | 'bot' | 'auto' | 'tool'
  phases: MaxPhase[]
  /** Team phases by their agents (or max) call id. */
  teams?: Array<{ callId: string; members: TeamMember[] }>
  swarm?: SwarmBoard
  heavy?: HeavyBoard
  heavyId?: string
  /** A hybrid's first phase, as handed to the judged attempts (shortened). */
  brief?: string
  /** The final answer and who it credits ([H3] swarm helpers, [A2] attempts). */
  result?: { excerpt: string; credits: Array<{ tag: string; count: number }> }
  status: 'running' | 'done' | 'failed' | 'stopped'
  unattended?: boolean
  /** Ran under a routine's budget (never asked). */
  budgetUsd?: number
  startedAt: number
  endedAt?: number
}

// ---- Videos (HeyGen avatar videos, translations, HyperFrames motion videos: src/main/agent/tools/video.ts) ----

/** One video job as the chat's video card shows it (tool result meta.video, or a notice's meta.video). */
export interface VideoCardData {
  /** SahilBot's job id (v_…); the HeyGen id is `remoteId`. */
  id: string
  kind: 'avatar' | 'translate' | 'motion'
  title: string
  /** processing: HeyGen is rendering; downloading: saving the MP4; needs_input: HyperFrames asked something. */
  status: 'processing' | 'downloading' | 'ready' | 'failed' | 'needs_input'
  remoteId?: string
  /** The saved MP4 (absolute) and its foreman-file: URL, once downloaded. */
  path?: string
  url?: string
  size?: number
  aspect?: string
  /** The credit estimate shown on the approval card. */
  credits?: number
  /** 0–100 when HeyGen reports it. */
  progress?: number
  /** Rough render time, in seconds, from when it started. */
  etaSec?: number
  createdAt: number
  doneAt?: number
  error?: string
  /** The finished video was announced with its own note in the chat (the progress card then stays compact). */
  announced?: boolean
}

export interface SahilBotApi {
  /** Video jobs (the chat's render-progress card checks its job here). Optional so older preloads still type-check. */
  video?: {
    get(id: string): Promise<VideoCardData | null>
  }
}

/** A starter tile under Home's message box (personalized from the user's habits, apps, files and projects). */
export interface HomeIdea {
  icon: 'globe' | 'clock' | 'search' | 'cpu' | 'file' | 'video' | 'sparkle' | 'edit' | 'layers' | 'image' | 'inbox' | 'users' | 'listicon' | 'bolt' | 'folder'
  label: string
  /** What fills the message box. */
  text: string
  /** Suggested by the user's own patterns (not one of the generic tiles). */
  personal?: boolean
}
