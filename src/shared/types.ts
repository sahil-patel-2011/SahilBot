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

export interface MemoryItem {
  id: string
  category: string
  content: string
  /** null = about you; otherwise the project it belongs to. */
  projectId: string | null
  updatedAt: number
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
    update(id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'shape' | 'pinned' | 'hidden' | 'members' | 'model' | 'folder'>>): Promise<Space>
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
  schedules: {
    list(): Promise<ScheduledTask[]>
    create(t: { title: string; prompt: string; schedule: Schedule; spaceId: string }): Promise<ScheduledTask>
    update(id: string, patch: { enabled?: boolean; title?: string; prompt?: string; schedule?: Schedule }): Promise<ScheduledTask>
    remove(id: string): Promise<void>
    runNow(id: string): Promise<void>
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
    onState(cb: (s: BrowserState) => void): () => void
    onOpenRequest(cb: () => void): () => void
  }
  memory: {
    list(): Promise<MemoryItem[]>
    remove(id: string): Promise<void>
    add(content: string, projectId: string | null): Promise<MemoryItem>
    update(id: string, content: string): Promise<void>
  }
  rules: {
    list(): Promise<Rule[]>
    save(r: { name: string; text: string; scope?: string; category?: string }): Promise<Rule>
    setEnabled(name: string, on: boolean): Promise<void>
    remove(name: string): Promise<void>
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
    onEvent(cb: (e: ChatEvent) => void): () => void
  }
}
