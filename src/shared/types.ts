// Types shared by the main process, preload bridge and renderer.

export type Role = 'system' | 'user' | 'assistant' | 'tool'
export type PermissionMode = 'ask' | 'auto' | 'bypass'
export type ToolEffect = 'read' | 'write_local' | 'write_external' | 'destructive'
export type MessageStatus = 'streaming' | 'done' | 'error' | 'stopped'
export type MessageKind = 'normal' | 'compacted' | 'error' | 'notice'

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string exactly as the model produced it. */
  arguments: string
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
  cloud: { enabled: boolean; hybrid: boolean; advisorModel: string; maxConsultsPerRequest: number }
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
  advanced: { hardStopsEnabled: boolean }
  /** First-run setup finished. */
  onboarded: boolean
  /** Hard monthly cap (USD) on cloud model spending; local models are free and unaffected. */
  cloudBudgetUsd: number
  /** The user's own approval rules: "When SahilBot wants to …, it should allow automatically / ask first". Ask first wins. */
  customRules?: CustomRule[]
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
  kind: 'approval' | 'question' | 'connect' | 'questions' | 'plan'
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
  /** 'chat' = saved by a bot while talking, 'you' = added in Settings, 'import' = imported from another assistant. */
  source: 'chat' | 'you' | 'import'
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

export interface VaultEntry {
  name: string
  origin: string
  username: string
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
  | { threadId: string; type: 'progress'; step: number; actions: number; plan?: { at: number; of: number }; used: number; window: number; model?: string; routed?: { tier: Tier; why: string } }
  /** The model is writing a tool call (shown as "Preparing to …" before it runs). */
  | { threadId: string; type: 'drafting'; tool: string | null }
  /** Bots or groups changed (renamed, recolored by a bot): reload the sidebar. */
  | { threadId: string; type: 'spaces' }

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
  /** oauth: sign in in the browser; none: open server; google: needs your Google OAuth client ID; app: built into SahilBot. */
  auth: 'oauth' | 'none' | 'google' | 'browser' | 'app'
  /** The app's own site, for its icon, when the server URL's host doesn't map to it (gmailmcp.googleapis.com → mail.google.com/mail/). */
  domain?: string
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
  /** Pre-registered OAuth client (Google); its secret, if any, is kept in the Keychain. */
  clientId?: string
  preset?: string
  enabled: boolean
  /** Tool names (as the server names them) the user switched off; they aren't offered to the agent. */
  disabledTools?: string[]
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
  state: 'off' | 'disconnected' | 'connecting' | 'signing_in' | 'needs_auth' | 'connected' | 'error'
  tools: number
  toolNames?: string[]
  error?: string
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
    set(patch: Partial<Settings> & { apiKey?: string | null; braveKey?: string | null; cursorKey?: string | null; setKeys?: Partial<Record<ProviderId, string | null>> }): Promise<Settings>
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
  }
  vault: {
    list(): Promise<VaultEntry[]>
    set(entry: VaultEntry & { password?: string }): Promise<VaultEntry[]>
    remove(name: string): Promise<VaultEntry[]>
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
  skills: {
    list(): Promise<Skill[]>
    save(s: { name: string; description: string; body: string }): Promise<Skill>
    remove(name: string): Promise<void>
  }
  chat: {
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
