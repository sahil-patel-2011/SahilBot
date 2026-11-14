// Types shared by the main process, preload bridge and renderer.

export type Role = 'system' | 'user' | 'assistant' | 'tool'
/**
 * How much a chat may do on its own. 'ask': every change asks. 'auto': routine actions run, consequential
 * outside actions ask. 'autonomous': also project commands (installs from the lockfile, git fetch/pull)
 * and overwrites inside your folders; deleting, sending, buying, credentials, security, tainted actions
 * and anything outside your folders still ask. 'bypass' (Settings → Advanced): everything but hard stops.
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
  /** One-line label under the bot's name ("Add a label"). */
  label?: string | null
  /** Desktop notifications when this bot finishes or needs you (default on). */
  notify?: boolean
  createdAt: number
  /** Derived for the sidebar. */
  lastPreview?: string
  lastAt?: number
  unread?: boolean
}

export interface Thread {
  id: string
  spaceId: string
  title: string
  pinned: boolean
  unread: boolean
  permissionMode: PermissionMode
  model: string | null
  createdAt: number
  updatedAt: number
  lastPreview?: string
  /** Set on a helper agent's thread: the chat that started it. */
  parentId?: string | null
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
export type ProviderId = 'ollama' | 'lmstudio' | 'custom' | 'anthropic' | 'openai' | 'openrouter'

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

export interface Settings {
  /** Fallback endpoint for models no provider claims (and the legacy single-server setting). */
  baseUrl: string
  /** Stored encrypted; the renderer only ever sees `hasApiKey` / `keys`. */
  hasApiKey: boolean
  providers: ProviderSettings
  /** Which providers have a key saved in the Keychain. */
  keys: Record<ProviderId, boolean>
  /** A Cursor API key is saved (Cursor cloud agents). */
  hasCursorKey: boolean
  /** The Blue Alliance read key (FRC scouting), kept in the Keychain. */
  hasTbaKey?: boolean
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
  thinking: Effort
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
  }
  /** 0 = Auto: the largest window that fits this Mac's memory with the model (agents get more room). */
  contextWindow: 0 | 16384 | 32768 | 65536 | 131072
  /** Models switched on by hand even though they're tight on memory. */
  shownModels: string[]
  /** Per-model overrides. Missing keys fall back to the model-card preset. */
  sampling: Record<string, Partial<Sampling>>
  theme: 'system' | 'light' | 'dark'
  userName: string
  workspaceDir: string
  search: { provider: 'auto' | 'none' | 'brave' | 'searxng' | 'duckduckgo'; searxngUrl: string; hasBraveKey: boolean }
  advanced: {
    hardStopsEnabled: boolean
    /** Offer Bypass (Full access) in the composer's autonomy picker (default off). */
    allowBypass?: boolean
    /** Run terminal commands under a macOS sandbox that refuses writes outside your folders unless you approved the command (default on). */
    sandboxCommands?: boolean
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
  /** Routines missed while SahilBot was closed or the Mac slept run once on launch/wake if due within this many hours (0 = never catch up). */
  catchUpHours?: number
  /** "Pause all routines" from the menu bar icon: no routine fires until resumed. */
  routinesPaused?: boolean
  /** How long a local model stays loaded after a message (Ollama keep_alive: '30m', '2h', or seconds; '-1' = always). */
  localKeepAlive?: string
  /** Learning while the app is open and idle (Settings → Memory → What I learned). */
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
  kind: 'approval' | 'question' | 'connect' | 'questions' | 'plan' | 'purchase' | 'otp'
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
}

export type ApprovalAnswer = 'once' | 'always' | 'deny'

/** What a memory is: about the user (profile, preference, person, location…), a rule to follow, or a dated work-log entry. */
export type MemoryKind = 'profile' | 'work' | 'preference' | 'person' | 'location' | 'project' | 'trip' | 'link' | 'date' | 'rule' | 'fact' | 'worklog'

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

/** Import preview: one candidate memory per line of the pasted export. */
export interface MemoryImportPreview {
  items: Array<{ content: string; category: MemoryKind }>
  duplicates: number
  skipped: number
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
  /** The saved login's name in Settings > Passwords (never the secret itself). */
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
  kind: 'pdf' | 'image' | 'html' | 'markdown' | 'text' | 'sheets' | 'slides' | 'unsupported'
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
   * google: needs your Google OAuth client ID; browser: sign in once in SahilBot's browser; app: built into SahilBot.
   */
  auth: 'oauth' | 'none' | 'oauth-static' | 'google' | 'browser' | 'app'
  /** The app's own site, for its icon, when the server URL's host doesn't map to it (gmailmcp.googleapis.com → mail.google.com/mail/). */
  domain?: string
  /** One-time setup for oauth-static apps: exact steps with links, and the redirect URL to register. */
  setup?: ConnectorSetup
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

export type VoiceUiEvent =
  | { type: 'state'; state: 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking' }
  | { type: 'partial'; text: string }
  | { type: 'transcript'; text: string }
  | { type: 'reply'; text: string }
  | { type: 'audio'; audio: Float32Array; rate: number }
  | { type: 'stop-audio' }
  | { type: 'metric'; name: string; ms: number }
  | { type: 'error'; message: string }
  | { type: 'download'; kind: string; progress: number; done?: boolean; error?: string }

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
  threadId: string
  text: string
  images?: string[]
  /** Extra context for the model only (not shown in the bubble). */
  note?: string
  /** Stored on the message for display, e.g. attached files and folders. */
  meta?: Record<string, unknown>
  /** Files and folders picked or dropped by the user; they become readable/editable for this thread. */
  attachments?: Attachment[]
  /** Sent from voice mode: short spoken-style answers, 16k window. */
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
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings> & { apiKey?: string | null; braveKey?: string | null; cursorKey?: string | null; tbaKey?: string | null; setKeys?: Partial<Record<ProviderId, string | null>> }): Promise<Settings>
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
    list(): Promise<Space[]>
    create(input: { name?: string; color?: string; shape?: BotShape; kind?: 'bot' | 'group' | 'project'; members?: string[]; intro?: boolean; folder?: string }): Promise<{ space: Space; threadId: string }>
    update(id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'shape' | 'pinned' | 'hidden' | 'members' | 'model' | 'folder' | 'label' | 'notify'>>): Promise<Space>
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
    update(id: string, patch: Partial<Pick<Thread, 'title' | 'pinned' | 'unread' | 'permissionMode' | 'model' | 'spaceId'>>): Promise<Thread>
    remove(id: string): Promise<void>
    messages(id: string): Promise<Message[]>
    react(messageId: string, emoji: string | null): Promise<Message>
  }
  files: {
    pick(kind: 'files' | 'folder'): Promise<Attachment[]>
    /** Resolves dropped File objects to paths (preload only; the renderer can't fake these). */
    fromDrop(files: File[]): Promise<Attachment[]>
    preview(path: string): Promise<FilePreview>
    /** The first lines of a document SahilBot made (PDF, Word, PowerPoint), for thumbnails. */
    snippet(path: string): Promise<string>
    /** Files SahilBot made, newest first. */
    recent(limit?: number): Promise<Array<{ path: string; name: string; size: number; threadId: string; threadTitle: string; createdAt: number; tool: string }>>
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
  budget(): Promise<{ month: string; spent: number; cap: number; requests: number }>
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
    frame(samples: Float32Array): void
    onEvent(cb: (e: VoiceUiEvent) => void): () => void
  }
  connectors: {
    presets(): Promise<ConnectorPreset[]>
    list(): Promise<{ configs: ConnectorConfig[]; statuses: ConnectorStatus[] }>
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
    importCommit(items: Array<{ content: string; category?: MemoryKind }>): Promise<number>
    getEnabled(): Promise<boolean>
    setEnabled(on: boolean): Promise<void>
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

export interface SahilBotApi {
  /** macOS permissions: status (never prompts) and the System Settings pane for each. Nothing is granted from here. */
  permissions: {
    status(): Promise<PermissionRow[]>
    /** Opens the exact System Settings pane for a permission. */
    open(kind: PermissionKind): Promise<void>
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

/** Settings → Privacy & Permissions → Connected apps (MCP). Off by default; the port is kept so app configs keep working. */
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
  snippets: { cursor: string; claudeCode: string; claudeDesktop: string; curl: string }
}

export interface SahilBotApi {
  /** Connected apps (MCP). Changes are only accepted from the main window. */
  mcp: {
    status(): Promise<McpStatus>
    /** newPort: start on a fresh free port (after the saved one was in use); apps then need the new URL. */
    setEnabled(on: boolean, opts?: { newPort?: boolean }): Promise<McpStatus>
    createClient(name: string): Promise<McpNewClient>
    revokeClient(id: string): Promise<McpStatus>
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
  /** Settings → Knowledge and the project home's Knowledge block. */
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
  /** Learn while SahilBot is open. Unset = on when a local model is available, off otherwise. */
  enabled?: boolean
  /** May use a cloud model when no local one is available (default off). */
  cloudAllowed: boolean
  /** Daily cap (USD) on cloud spending for learning. */
  dailyUsd: number
}

/** What a learned item is: a memory, a skill, a lesson from a mistake, or memory housekeeping. */
export type LearnedKind = 'memory' | 'skill' | 'lesson' | 'merge' | 'stale' | 'trim'

/** One entry in the learning log (Settings → Memory → What I learned). */
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
  /** Settings → Memory → What I learned. */
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

/** Settings → Privacy & Permissions → Know what I'm working on. Off by default; kept only on this Mac. */
export interface ActivitySettings {
  enabled: boolean
  /** Front window titles (needs Accessibility, and System Events once). */
  windowTitles: boolean
  /** The front browser tab's title and address (needs Automation for each browser). */
  browserTabs: boolean
  /** "Let SahilBot learn from my activity": the learning pass may read the timeline. Separate, off by default. */
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

/** Interface merging (append-only): the Onshape API key pair is saved (Settings → API Keys & Servers → Onshape). */
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
}

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

export type DocExportFormat = 'docx' | 'pdf' | 'md' | 'html' | 'xlsx' | 'csv'

/** Library items can be live documents (opened in the Document tab). */
export interface LibraryItem {
  docId?: string
}

export interface SahilBotApi {
  docs: {
    /** Documents in a chat, newest change first. */
    list(threadId: string): Promise<DocInfo[]>
    get(id: string): Promise<DocSnapshot>
    create(threadId: string, title: string, type?: DocType): Promise<DocSnapshot>
    /** Saves the user's edits made on top of version `base` (merged with any newer bot edit). */
    save(id: string, base: number, content: DocContent): Promise<DocSnapshot>
    versions(id: string): Promise<DocVersionInfo[]>
    version(id: string, n: number): Promise<DocContent>
    diff(id: string, from: number, to: number): Promise<DocDiff>
    restore(id: string, n: number): Promise<DocSnapshot>
    export(id: string, format: DocExportFormat): Promise<string>
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
  kind: 'team' | 'heavy'
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
   * "Use OpenAI for knowledge search embeddings" (Settings → Knowledge). Off by default. Privacy: when on
   * (and an OpenAI key is saved and cloud models are on), passages of the user's indexed documents are
   * sent to OpenAI (text-embedding-3-small) to build the meaning-search index; costs count toward the
   * monthly cloud budget. Off: embeddings stay on this Mac (Ollama) or keyword search alone.
   */
  openaiEmbeddings?: boolean
}
