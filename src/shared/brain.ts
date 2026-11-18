// "Your brain" (src/main/brain): what SahilBot reads from the user's connected accounts on a schedule, the
// briefs it writes about the people, clients and projects that matter, and Agent mode, where SahilBot
// reaches out with a few high-value prompts instead of waiting to be asked. Shared by main and the Brain page.

/** What kind of thing a source holds (it decides the chip label and how items are read). */
export type BrainSourceKind = 'email' | 'calendar' | 'chat' | 'meetings' | 'crm' | 'docs' | 'accounting'

export const SOURCE_KIND_LABEL: Record<BrainSourceKind, string> = {
  email: 'Email', calendar: 'Calendar', chat: 'Messages', meetings: 'Meetings', crm: 'CRM', docs: 'Docs', accounting: 'Accounting'
}

export interface BrainSettings {
  /** "Pause the brain": no syncing, no briefs, no prompts. */
  paused: boolean
  /** Per source: an explicit on/off. A source that's absent is on once it's connected (texts: off unless turned on). */
  sources: Record<string, boolean>
  /** The brain's own daily cap on cloud spend (it also counts toward the monthly limit). */
  dailyUsd: number
  /** How far back a first read ("backfill") goes, after the user OKs its estimate. */
  backfillDays: number
  /** Items read per sync at most (the rest wait for the next one). */
  maxItemsPerSync: number
  /** Minutes between syncs while the user is active (idle: hourly). */
  activeMinutes: number
  /** "Agent mode: SahilBot reaches out" (off by default). */
  agentMode: boolean
  /** No prompts, notifications or pushes between these local times ("21:00" → "08:00"). */
  quietHours: { start: string; end: string }
  /** At most this many prompts a day. */
  maxPromptsPerDay: number
  /** Kinds of action the user lets SahilBot start without a click. Only drafting exists: sending never runs on its own. */
  preApproved: { draft: boolean }
  /** Let background brain jobs use the ChatGPT plan (its own limits apply). Off: the plan is kept for the user's chats. */
  usePlan: boolean
}

export const DEFAULT_BRAIN: BrainSettings = {
  paused: false,
  sources: {},
  dailyUsd: 0.25,
  backfillDays: 30,
  maxItemsPerSync: 60,
  activeMinutes: 15,
  agentMode: false,
  quietHours: { start: '21:00', end: '08:00' },
  maxPromptsPerDay: 3,
  preApproved: { draft: false },
  usePlan: false
}

export type BrainSourceState = 'on' | 'off' | 'needs-sign-in' | 'not-connected'

export interface BackfillEstimate {
  sourceId: string
  days: number
  /** Items in that window (an estimate when the app only says "more than N"). */
  items: number
  /** What reading them would cost on the extraction model (0: a local model, or the ChatGPT plan). */
  usd: number
  model?: string
  /** "Read the last 30 days of Gmail: about 1,800 emails, ~$0.40". */
  label: string
}

export interface BrainSourceView {
  id: string
  name: string
  kind: BrainSourceKind
  /** The connector preset whose icon to show (and to connect). */
  preset: string
  state: BrainSourceState
  /** On for the brain (a connected source the user didn't turn off). */
  on: boolean
  /** Off unless the user turns it on (texts). */
  optIn?: boolean
  what: string
  lastSyncAt?: number
  /** Items kept from it so far. */
  items: number
  error?: string
  /** First read: waiting for the user's OK on its estimate, reading back, done or skipped. */
  backfill?: 'ask' | 'running' | 'done' | 'skipped'
  /** What to do to use it ("Connect Gmail", "Allow Full Disk Access"). */
  hint?: string
}

export interface SourceChip {
  /** "Email · Oct 28", "HubSpot deal", "Zoom call · Mon". */
  label: string
  kind: BrainSourceKind | 'chat' | 'you' | 'file' | 'memory'
  /** What opening it opens: a web link (Gmail, the event, the deal), message:// for Mail, sahilbot://thread/… */
  link?: string
  title?: string
  at?: number
}

export type BriefFilter = 'all' | 'clients' | 'people' | 'projects'

export interface BriefCard {
  entityId: string
  name: string
  /** Shown as the card's eyebrow ("Client", "Client contact", "Person", "Project", "Organization"). */
  role: 'client' | 'contact' | 'person' | 'project' | 'organization'
  subtitle: string
  /** 2–3 sentences written for the user; empty while it's being written. */
  text: string
  chips: SourceChip[]
  updatedAt: number
  /** The user corrected it: their words, kept as their own fact. */
  edited: boolean
  model?: string
  facts: number
  /** The next open commitment, if any. */
  due?: { what: string; at?: number }
  /** Facts changed since it was written: a new one is on its way at the next sync. */
  stale?: boolean
}

export interface BrainCadence {
  /** Time between syncs right now (0 while paused). */
  everyMs: number
  /** "~15 min", "~1 hr (idle)", "paused on battery". */
  label: string
  paused?: string
}

export interface BrainJobLine {
  job: 'extract' | 'brief'
  model: string
  usd: number
  input: number
  output: number
  calls: number
}

export interface BrainSyncRow {
  id: string
  at: number
  trigger: 'schedule' | 'manual'
  read: number
  kept: number
  dropped: number
  facts: number
  briefs: number
  prompts: number
  usd: number
  jobs: BrainJobLine[]
  note: string
}

export interface BrainStatus {
  settings: BrainSettings
  syncing: boolean
  job?: string
  lastSyncAt?: number
  lastSummary?: string
  nextSyncAt?: number
  cadence: BrainCadence
  stats: {
    /** Entity facts + saved memories. */
    memories: number
    /** Sources on for the brain and connected. */
    tools: number
    /** Vault notes the user wrote themselves. */
    notesFiled: number
    todayUsd: number
    dailyUsd: number
    /** The monthly spending limit is nearly used (brain jobs on paid models wait). */
    monthTight: boolean
  }
  sources: BrainSourceView[]
  /** First reads waiting for the user's OK. */
  estimates: BackfillEstimate[]
  /** Which model each job would use now, and why. */
  routing: { extract?: string; brief?: string; extractWhy?: string; briefWhy?: string; blocked?: string }
  recent: BrainSyncRow[]
  /** Prompts surfaced today / the daily max (Agent mode). */
  promptsToday: number
}

export type BrainPromptKind = 'commitment' | 'gap'
export type BrainActionId = 'draft' | 'remind' | 'dismiss' | 'answer' | 'open'

export interface BrainPromptAction { id: BrainActionId; label: string; primary?: boolean }

export interface BrainPrompt {
  id: string
  kind: BrainPromptKind
  /** "Sarah Lee asked for the revised proposal by Friday. Draft it from the last version?" */
  text: string
  detail?: string
  entityId?: string
  entityName?: string
  dueAt?: number
  actions: BrainPromptAction[]
  chips: SourceChip[]
  /** A question to answer in words (gaps): its answer becomes the user's own fact. */
  question?: boolean
  placeholder?: string
  status: 'open' | 'accepted' | 'dismissed' | 'snoozed' | 'answered'
  createdAt: number
  /** The chat a Draft started. */
  threadId?: string
  /** Started on its own (the user pre-approved drafting): waits for review. */
  auto?: boolean
}

/** window.foreman.brain */
export interface BrainApi {
  status(): Promise<BrainStatus>
  setSettings(patch: Partial<Omit<BrainSettings, 'sources' | 'quietHours' | 'preApproved'>> & { sources?: Record<string, boolean>; quietHours?: Partial<BrainSettings['quietHours']>; preApproved?: Partial<BrainSettings['preApproved']> }): Promise<BrainStatus>
  /** "Refresh now": a sync right away (still inside the daily budget). */
  refresh(): Promise<BrainStatus>
  briefs(o?: { query?: string; filter?: BriefFilter }): Promise<BriefCard[]>
  /** "That's wrong": the user's own words replace the brief and are kept as their fact. */
  correct(entityId: string, text: string): Promise<BriefCard | null>
  /** Forget the entity everywhere (People & Places' forget; Undo puts it back). */
  forget(entityId: string): Promise<{ trashId: string }>
  undo(trashId: string): Promise<BriefCard | null>
  /** OK (true) or Cancel (false) on a first read's estimate. */
  backfill(sourceId: string, ok: boolean): Promise<BrainStatus>
  /** "Forget everything from <source>": its facts, items, briefs and prompts go, and the source turns off. */
  forgetSource(sourceId: string): Promise<BrainStatus>
  openChip(chip: SourceChip): Promise<void>
  prompts(): Promise<BrainPrompt[]>
  onChanged(cb: () => void): () => void
}
