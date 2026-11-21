// Privacy Gate: personal data found by PII-Tracer on this Mac stays here when a chat uses local and
// cloud models together (src/main/privacy). Shared between the main process and the renderer.

/** PII-Tracer's nine categories. */
export type PrivacyLabel = 'private_person' | 'private_email' | 'private_phone' | 'private_address' | 'private_url' | 'private_date' | 'account_number' | 'secret' | 'other_pii'

export const PRIVACY_LABEL_TEXT: Record<PrivacyLabel, { one: string; many: string; placeholder: string }> = {
  private_person: { one: 'name', many: 'names', placeholder: 'PERSON' },
  private_email: { one: 'email address', many: 'email addresses', placeholder: 'EMAIL' },
  private_phone: { one: 'phone number', many: 'phone numbers', placeholder: 'PHONE' },
  private_address: { one: 'address', many: 'addresses', placeholder: 'ADDRESS' },
  private_url: { one: 'private link', many: 'private links', placeholder: 'URL' },
  private_date: { one: 'personal date', many: 'personal dates', placeholder: 'DATE' },
  account_number: { one: 'account or ID number', many: 'account or ID numbers', placeholder: 'ACCOUNT' },
  secret: { one: 'password or key', many: 'passwords or keys', placeholder: 'SECRET' },
  other_pii: { one: 'other personal detail', many: 'other personal details', placeholder: 'PRIVATE' }
}

/** Passwords, keys, card, account and ID numbers: never sent to a cloud model unless the user says they aren't personal. */
export const STRICT_LABELS: ReadonlySet<PrivacyLabel> = new Set<PrivacyLabel>(['secret', 'account_number'])

/** Whole documents that are personal records by nature (src/main/privacy/documents.ts). */
export type PrivacyDocumentKind = 'bank_statement' | 'card_statement' | 'utility_bill' | 'pay_stub' | 'tax_form' | 'medical_record' | 'id_document' | 'sensitive_text'

export const PRIVACY_DOCUMENT_TEXT: Record<PrivacyDocumentKind, string> = {
  bank_statement: 'bank statement', card_statement: 'credit card statement', utility_bill: 'bill (internet, phone or utilities)',
  pay_stub: 'pay stub', tax_form: 'tax form', medical_record: 'medical record', id_document: 'ID document', sensitive_text: 'sensitive personal passage'
}

export interface PrivacySpan { start: number; end: number; label: PrivacyLabel; score: number; text?: string }

/** One flagged item on the Privacy Gate card. */
export interface PrivacyGateItem {
  id: string
  label: PrivacyLabel
  /** The value itself (the card is on this Mac). */
  value: string
  /** Where it was found: "Your message", "file_read output", … */
  source: string
  strict: boolean
}

/** The Privacy Gate card's content (a pending request of kind 'privacy'). */
export interface PrivacyGateInfo {
  items: PrivacyGateItem[]
  /** Whole personal records found (a bank statement in a file_read output): kept on the Mac unless shared. */
  documents?: Array<{ kind: PrivacyDocumentKind; source: string }>
  /** Where it was found, deduplicated, for the card's heading ("bash_execute output"). */
  sources: string[]
  /** A local model can take over ("Process on my Mac" is available). */
  localModel?: string
  /** The cloud model the next reply was going to use. */
  cloudModel: string
}

/** What the user picked on the card. */
export type PrivacyAction = 'local' | 'split' | 'share' | 'skip'
export interface PrivacyAnswer {
  action: PrivacyAction
  /** Items the user says aren't personal ("Is this correct?"): treated as shareable. */
  notPersonal: string[]
  /** "Don't ask again for this chat": later finds in this chat get the same action. */
  remember: boolean
}

export type PrivacyInstallEvent = { phase: 'download' | 'verify' | 'start' | 'done' | 'error'; pct?: number; error?: string }

/** What hybrid compute needs from this Mac. */
export interface HybridRequirements {
  ramGB: number
  freeDiskGB: number
  appleSilicon: boolean
  /** 32 GB memory and 50 GB free disk, on Apple Silicon. */
  meetsMinimum: boolean
  /** 64 GB and 150 GB: the top local models at full quality. */
  meetsBest: boolean
  /** Plain words: what's missing, if anything. */
  problem?: string
}

export const HYBRID_MIN = { ramGB: 32, diskGB: 50 }
export const HYBRID_BEST = { ramGB: 64, diskGB: 150 }

/** What the gate did today (Settings → Hybrid compute). */
export interface PrivacyDayStats { day: string; requests: number; checked: number; asked: number; protected: number; cleared: number; errors: number }

export interface PrivacyStatus {
  /** PII-Tracer is downloaded. */
  installed: boolean
  /** 'ask': pause on a card; 'auto': protect on its own and say so. */
  mode: 'ask' | 'auto'
  /** How many details are remembered as not personal across chats. */
  remembered: number
  today: PrivacyDayStats
  installing: boolean
  /** Hybrid compute is switched on (Settings → Privacy & Security → Hybrid compute). */
  enabled: boolean
  requirements: HybridRequirements
  /** Local and cloud models are both set up, so the gate has something to route between. */
  hybrid: boolean
  /** The gate checks cloud requests right now. */
  active: boolean
  downloadBytes: number
}

export interface PrivacyApi {
  status(): Promise<PrivacyStatus>
  install(): Promise<PrivacyStatus>
  setEnabled(enabled: boolean): Promise<PrivacyStatus>
  remove(): Promise<PrivacyStatus>
  /** Ask on a card, or protect automatically. */
  setMode(mode: 'ask' | 'auto'): Promise<PrivacyStatus>
  /** Forgets the details remembered as not personal. */
  forgetNotPersonal(): Promise<PrivacyStatus>
  /** Runs a made-up sample through PII-Tracer on this Mac: what it caught and how long it took. */
  selfTest(): Promise<{ sample: string; ms: number; found: Array<{ label: PrivacyLabel; text: string }> }>
  onInstall(cb: (e: PrivacyInstallEvent) => void): () => void
}
