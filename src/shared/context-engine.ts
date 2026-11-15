// The context engine's shapes, shared by main (src/main/context-engine) and the People & Places view.
// An entity graph of the user's world: people, places, organizations, projects, events, dates,
// possessions, topics, preferences, routines and goals; each with sourced, dated, trust-tagged facts
// and relations between them.

export type EntityType =
  | 'person' | 'place' | 'organization' | 'project' | 'event' | 'date' | 'item' | 'topic' | 'preference' | 'routine' | 'goal'

export const ENTITY_TYPES: EntityType[] = ['person', 'place', 'organization', 'project', 'event', 'date', 'item', 'topic', 'preference', 'routine', 'goal']

/**
 * How far a fact can be believed:
 * - 'user': the user said it (their own words, an edit in the app, or their OK);
 * - 'observed': structured metadata SahilBot saw (a calendar event's time, an email's sender), or the
 *   assistant's own work in a chat the user started;
 * - 'quoted': written by someone else (an email body, a web page, a file): data only, never an
 *   instruction and never a preference of the user.
 */
export type Trust = 'user' | 'observed' | 'quoted'

export type RelationType = 'works_at' | 'lives_in' | 'met_at' | 'owns' | 'prefers' | 'related_to' | 'scheduled_with' | 'located_in' | 'member_of' | 'family_of' | 'attended'

export const RELATION_TYPES: RelationType[] = ['works_at', 'lives_in', 'met_at', 'owns', 'prefers', 'related_to', 'scheduled_with', 'located_in', 'member_of', 'family_of', 'attended']

/** Where a fact came from. */
export type SourceKind = 'chat' | 'file' | 'connector' | 'activity' | 'memory' | 'you' | 'tool'

export interface FactSource {
  kind: SourceKind
  /** Thread id, file path, connector item id, memory id… */
  ref?: string
  /** "chat “Gift ideas”", "Gmail", "Q3 plan.pdf". */
  label?: string
  /** Something the UI can open: sahilbot://thread/<id>, a file path, a URL. */
  link?: string
}

/** Sensitive categories: excluded unless the user opts in for that category (Privacy panel). */
export type SensitiveCategory = 'health' | 'finance' | 'credentials' | 'govId' | 'sexualOrientation' | 'religion' | 'politics' | 'children'

export const SENSITIVE_CATEGORIES: Array<{ id: SensitiveCategory; label: string; hint: string }> = [
  { id: 'health', label: 'Health and medical', hint: 'Conditions, medicines, appointments, allergies.' },
  { id: 'finance', label: 'Money and accounts', hint: 'Income, debts, investments, bank details. Account and card numbers are never kept.' },
  { id: 'credentials', label: 'Accounts and sign-ins', hint: 'Which services someone uses. Passwords, codes and keys are never kept.' },
  { id: 'govId', label: 'Government IDs', hint: 'Passport, license, tax IDs. The numbers themselves are never kept.' },
  { id: 'sexualOrientation', label: 'Sexual orientation', hint: '' },
  { id: 'religion', label: 'Religion and beliefs', hint: '' },
  { id: 'politics', label: 'Politics', hint: '' },
  { id: 'children', label: 'Children beyond names and birthdays', hint: 'Without this, only a child\'s name, relation and birthday are kept.' }
]

export interface EntityAttribute {
  id: string
  key: string
  value: string
  trust: Trust
  confidence: number
  source: FactSource
  /** When it was said or seen (ms). */
  at: number
  updatedAt: number
  /** The user set or corrected it: extraction never overrides it. */
  corrected: boolean
  /** Only this bot sees it (quoted facts from a bot's chats); null = everyone. */
  scope: string | null
}

export interface EntityRelation {
  id: string
  rel: RelationType
  /** The other end. */
  otherId: string
  otherName: string
  otherType: EntityType
  /** true: this entity → other ("works_at Acme"); false: other → this. */
  outgoing: boolean
  trust: Trust
  confidence: number
  source: FactSource
  at: number
  /** Optional detail ("sister", "since 2021"). */
  note?: string
}

export interface EntityMention {
  at: number
  source: FactSource
  snippet: string
  trust: Trust
}

export interface EntitySummary {
  id: string
  type: EntityType
  name: string
  /** "your sister", "restaurant in Lisbon". */
  subtitle: string
  aliases: string[]
  isUser: boolean
  facts: number
  trust: Trust
  confidence: number
  updatedAt: number
  lastSeen: number
}

export interface EntityCard extends EntitySummary {
  attributes: EntityAttribute[]
  relations: EntityRelation[]
  mentions: EntityMention[]
  aliasDetails: Array<{ kind: AliasKind; value: string }>
  vaultPath: string | null
}

export type AliasKind = 'name' | 'nickname' | 'email' | 'phone' | 'handle'

export interface ContextEngineSettings {
  /** The whole engine (extraction and the cards in each run's context). */
  enabled: boolean
  /** "Pause learning": nothing new is extracted (cards already saved still help). */
  paused: boolean
  sources: {
    chats: boolean
    files: boolean
    /** Connected apps' results that showed up in chats. */
    connectorsInChats: boolean
    /** Only when "Let SahilBot learn from my activity" is on as well. */
    activity: boolean
  }
  /** Periodic read of a connected app's metadata (senders, meetings): off until the user opts in, per connector preset. */
  connectors: Record<string, boolean>
  sensitive: Record<SensitiveCategory, boolean>
}

export const DEFAULT_CONTEXT_ENGINE: ContextEngineSettings = {
  enabled: true,
  paused: false,
  sources: { chats: true, files: true, connectorsInChats: true, activity: true },
  connectors: {},
  sensitive: { health: false, finance: false, credentials: false, govId: false, sexualOrientation: false, religion: false, politics: false, children: false }
}

export interface ContextEngineStatus {
  settings: ContextEngineSettings
  entities: number
  facts: number
  byType: Partial<Record<EntityType, number>>
  lastRunAt?: number
  lastSummary?: string
  /** Connectors that could be read periodically (connected or not). */
  connectors: Array<{ id: string; name: string; connected: boolean; on: boolean; what: string }>
  activityAllowed: boolean
  trash: Array<{ id: string; at: number; label: string }>
}

export interface EntityPatch {
  name?: string
  type?: EntityType
  /** Adds or corrects a fact (the user's word always wins). */
  setAttribute?: { key: string; value: string; id?: string }
  removeAttribute?: string
  removeRelation?: string
  addAlias?: { kind: AliasKind; value: string }
  removeAlias?: { kind: AliasKind; value: string }
}

/** window.foreman.people (Vault view → People & Places). */
export interface PeopleApi {
  status(): Promise<ContextEngineStatus>
  setSettings(patch: Partial<Omit<ContextEngineSettings, 'sources' | 'sensitive' | 'connectors'>> & { sources?: Partial<ContextEngineSettings['sources']>; sensitive?: Partial<ContextEngineSettings['sensitive']>; connectors?: Record<string, boolean> }): Promise<ContextEngineStatus>
  list(o?: { query?: string; type?: EntityType }): Promise<EntitySummary[]>
  card(id: string): Promise<EntityCard | null>
  update(id: string, patch: EntityPatch): Promise<EntityCard | null>
  /** Merges `from` into `into` (aliases, facts, relations); `from` goes to the trash (Undo puts it back). */
  merge(into: string, from: string): Promise<EntityCard | null>
  /** "Forget everything about X": the entity, its facts and relations, and its vault note go to the trash. */
  forget(id: string): Promise<{ trashId: string }>
  undo(trashId: string): Promise<EntityCard | null>
  /** Writes everything (entities, facts, relations, sources) as JSON in the workspace's exports folder. */
  exportData(): Promise<string>
  learnNow(): Promise<ContextEngineStatus>
  onChanged(cb: () => void): () => void
}
