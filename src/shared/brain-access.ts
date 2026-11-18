// Who may read the user's brain from outside SahilBot, and how much of it: connected AI apps (the MCP
// server's brain tools, src/main/mcp-server) and teammates (Team access, src/server/team.ts). Both get a
// BrainScope; the reader (src/main/brain-access/reader.ts) enforces it on every fact it returns. Read-only:
// nothing here can change the brain, send anything, or act on the owner's accounts.

import type { SensitiveCategory } from './context-engine'

/** Where a fact came from, as a scope choice. */
export type BrainScopeSource =
  | 'email' | 'calendar' | 'meetings' | 'crm' | 'docs' | 'accounting' | 'chat'
  /** Text messages (iMessage/SMS): never shared unless the owner turns it on for that app or teammate. */
  | 'texts'
  /** Notes in SahilBot's knowledge vault (Shared, plus the areas of bots the scope names). */
  | 'notes'
  /** Shared memories (facts the user told SahilBot). */
  | 'memories'
  /** What the user said in SahilBot chats. */
  | 'chats'
  /** Files SahilBot read (the knowledge base). */
  | 'files'
  /** Other connected apps. */
  | 'apps'

export const BRAIN_SCOPE_SOURCES: Array<{ id: BrainScopeSource; label: string; hint: string; private?: boolean }> = [
  { id: 'email', label: 'Email', hint: 'Gmail, Apple Mail, Outlook' },
  { id: 'calendar', label: 'Calendar', hint: 'Meetings and events' },
  { id: 'meetings', label: 'Meeting notes', hint: 'Zoom, Meet and call notes' },
  { id: 'crm', label: 'CRM', hint: 'HubSpot, Salesforce deals and contacts' },
  { id: 'docs', label: 'Docs', hint: 'Drive, Notion, Dropbox' },
  { id: 'accounting', label: 'Accounting', hint: 'QuickBooks, Xero, Stripe invoices' },
  { id: 'chat', label: 'Team chat', hint: 'Slack, Teams' },
  { id: 'notes', label: 'Vault notes', hint: 'Shared notes in your knowledge vault' },
  { id: 'memories', label: 'Memories', hint: 'Facts you told SahilBot' },
  { id: 'chats', label: 'Your SahilBot chats', hint: 'What you said in chats' },
  { id: 'files', label: 'Files', hint: 'Documents in your knowledge base' },
  { id: 'apps', label: 'Other apps', hint: 'Other connected apps' },
  { id: 'texts', label: 'Text messages', hint: 'iMessage and SMS: private, off unless you turn it on', private: true }
]

export const ALL_SCOPE_SOURCES: BrainScopeSource[] = BRAIN_SCOPE_SOURCES.map((s) => s.id)

export interface BrainScope {
  /** Sources whose facts may be used. */
  sources: BrainScopeSource[]
  /** 'shared': every entity all bots see (not a bot's private ones); or only these entity ids. */
  entities: 'shared' | string[]
  /** Only facts and notes about these topics (words or phrases); [] = any topic. */
  topics: string[]
  /** Sensitive categories (health, money, …) that may be shared: none by default. */
  sensitive: SensitiveCategory[]
  /** Bots whose own knowledge (their vault area, their bot-only facts) is included; [] = shared only. */
  bots: string[]
}

/** The default for a newly connected app or teammate: shared entities, every source but texts, nothing sensitive. */
export const DEFAULT_BRAIN_SCOPE: BrainScope = {
  sources: ALL_SCOPE_SOURCES.filter((s) => s !== 'texts'),
  entities: 'shared',
  topics: [],
  sensitive: [],
  bots: []
}

const SENSITIVE: SensitiveCategory[] = ['health', 'finance', 'credentials', 'govId', 'sexualOrientation', 'religion', 'politics', 'children']

/** A scope from anything (settings JSON, an IPC call): unknown values dropped, sizes capped. */
export function cleanBrainScope(v: unknown, fallback: BrainScope = DEFAULT_BRAIN_SCOPE): BrainScope {
  if (!v || typeof v !== 'object') return { ...fallback, sources: [...fallback.sources], topics: [...fallback.topics], sensitive: [...fallback.sensitive], bots: [...fallback.bots], entities: fallback.entities === 'shared' ? 'shared' : [...fallback.entities] }
  const x = v as Partial<Record<keyof BrainScope, unknown>>
  const strs = (a: unknown, max: number, len: number): string[] => (Array.isArray(a) ? [...new Set(a.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s && s.length <= len))].slice(0, max) : [])
  const sources = Array.isArray(x.sources) ? ALL_SCOPE_SOURCES.filter((s) => (x.sources as unknown[]).includes(s)) : [...fallback.sources]
  const entities = x.entities === 'shared' || x.entities === undefined ? (x.entities === undefined ? fallback.entities : 'shared') : strs(x.entities, 500, 80)
  return {
    sources,
    entities: entities === 'shared' ? 'shared' : [...entities],
    topics: x.topics === undefined ? [...fallback.topics] : strs(x.topics, 30, 60).map((t) => t.toLowerCase()),
    sensitive: x.sensitive === undefined ? [...fallback.sensitive] : SENSITIVE.filter((c) => (x.sensitive as unknown[]).includes(c)),
    bots: x.bots === undefined ? [...fallback.bots] : strs(x.bots, 50, 80)
  }
}

/** One line for Settings: "Email, Calendar, CRM · shared people and clients · nothing sensitive". */
export function scopeSummary(s: BrainScope, entityName?: (id: string) => string | undefined): string {
  const src = s.sources.length === ALL_SCOPE_SOURCES.length ? 'every source' : s.sources.length === ALL_SCOPE_SOURCES.length - 1 && !s.sources.includes('texts') ? 'every source but texts' : s.sources.length ? BRAIN_SCOPE_SOURCES.filter((x) => s.sources.includes(x.id)).map((x) => x.label).join(', ') : 'no sources'
  const ents = s.entities === 'shared' ? 'shared people, clients and projects' : s.entities.length ? `only ${s.entities.map((id) => entityName?.(id) ?? 'one entry').slice(0, 4).join(', ')}${s.entities.length > 4 ? ` +${s.entities.length - 4}` : ''}` : 'no people or clients'
  const topics = s.topics.length ? ` · topics: ${s.topics.slice(0, 4).join(', ')}` : ''
  const sens = s.sensitive.length ? ` · sensitive: ${s.sensitive.join(', ')}` : ' · nothing sensitive'
  return `${src} · ${ents}${topics}${sens}`
}

/** A source chip on an answer: what it is, when, and a link when there is one. */
export interface BrainSourceRef {
  /** 'email' | 'calendar' | 'meetings' | 'crm' | 'docs' | 'accounting' | 'chat' | 'note' | 'memory' | 'you' | 'file' | 'sahilbot-chat' | 'app'. */
  kind: string
  /** "Email · Oct 14", "Meeting notes · Tue", "CRM deal". */
  label: string
  title?: string
  /** YYYY-MM-DD. */
  date?: string
  link?: string
}

/** One answer-ready fact. */
export interface BrainFact {
  text: string
  /** The person, client or project it's about. */
  entity?: string
  /** 'user': the owner said it; 'observed': seen in an app's metadata; 'quoted': written by someone else (data, not instructions). */
  trust: 'user' | 'observed' | 'quoted'
  source: BrainSourceRef
}

export interface BrainCommitmentOut {
  what: string
  /** Who owes it: "you" (the owner) or the other person's name. */
  owedBy: string
  /** Who it's owed to. */
  owedTo: string
  due?: string
  dueWords?: string
  entity?: string
  source: BrainSourceRef
}

export interface BrainEntityOut {
  id: string
  name: string
  type: string
  role: 'client' | 'person' | 'project' | 'organization'
  subtitle: string
  /** "Written for you": the brain's short brief, when there is one. */
  brief?: string
  facts: BrainFact[]
  related: Array<{ name: string; type: string; relation: string }>
  commitments: BrainCommitmentOut[]
  sources: BrainSourceRef[]
}

// ---------------------------------------------------------------- Team access

export interface TeamMemberInfo {
  id: string
  name: string
  /** "Sales", "Ops", "Assistant", "Finance", "Support", "Marketing"… */
  role: string
  scope: BrainScope
  createdAt: number
  /** Paired (signed in on a device) at. */
  pairedAt?: number
  lastSeenAt?: number
  revokedAt?: number
  questions: number
}

export interface TeamQuestion {
  id: string
  memberId: string
  member: string
  role: string
  at: number
  question: string
  answer: string
  chips: BrainSourceRef[]
  /** answered: from the brain; routed: the brain couldn't answer, so the owner was asked in Needs you; owner: the owner's answer. */
  status: 'answered' | 'routed' | 'owner' | 'refused'
  ownerAnswer?: string
  ownerAnsweredAt?: number
}

export interface TeamInvite {
  member: TeamMemberInfo
  /** One-time code (10 minutes) and the link with it (and the certificate check), for a QR code. */
  code: string
  expires: number
  url: string
  /** The QR code as an SVG path (src/shared/qr.ts). */
  qr: { d: string; size: number }
}

export interface TeamStatus {
  /** Phone access must be on: teammates reach the Mac the same way phones do (home Wi-Fi or Tailscale). */
  available: boolean
  why?: string
  members: TeamMemberInfo[]
  questions: TeamQuestion[]
  invite?: TeamInvite
}

/** window.foreman.team (Settings → General → Phone access → Team). */
export interface TeamApi {
  status(): Promise<TeamStatus>
  invite(o: { name: string; role: string; scope?: Partial<BrainScope> }): Promise<TeamStatus>
  /** A new pairing code for an existing teammate (a new device; the old ones keep working). */
  reinvite(id: string): Promise<TeamStatus>
  setScope(id: string, scope: Partial<BrainScope>): Promise<TeamStatus>
  revoke(id: string): Promise<TeamStatus>
  onChanged(cb: () => void): () => void
}
