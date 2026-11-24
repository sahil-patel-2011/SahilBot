import type { SensitiveCategory } from '@shared/context-engine'
import { redactPhi, scanPhi, type PhiType } from '../agent/tools/phi'
import { hasSecret } from '../learning/extract'
import { redactSecrets } from '../secure/redact'

// What the context engine leaves out when the user turns a category off (Privacy panel; every category
// is on by default), and what it never keeps at all, whatever the settings say. Every candidate fact goes through screen() before it's stored:
//   - secrets (passwords, keys, codes, card and account numbers, a saved vault value): always dropped;
//   - the PHI helper (agent/tools/phi.ts) finds SSNs, record, plan, account and license numbers:
//     always dropped (the numbers themselves are never kept, whatever the settings say);
//   - sensitive categories (health, money, sign-ins, government IDs, sexual orientation, religion,
//     politics, children beyond names and birthdays): dropped when that category is turned off.
// The first two checks run before any category is looked at, so turning categories on never weakens them.
// Snippets (a line of an email kept as an interaction) are redacted, not dropped: secrets masked and,
// when the text is about health, PHI identifiers replaced.

const RX: Record<Exclude<SensitiveCategory, 'children'>, RegExp> = {
  health: /\b(diagnos\w*|allerg(y|ies|ic)|medication\w*|medicine|prescri\w*|therap(y|ist)|pregnan\w*|miscarriage|surgery|surgical|chemo\w*|cancer|tumou?r|diabetes|diabetic|adhd|autis\w*|depress\w*|anxiety|bipolar|schizo\w*|ptsd|ocd|disorder|illness|disease|infection|hiv|aids|std|sti|rehab|addiction|sober|sobriety|insulin|blood (type|pressure|sugar|test)|cholesterol|asthma|migraine|dementia|alzheimer\w*|parkinson\w*|stroke|heart attack|injur(y|ies|ed)|broken (arm|leg|bone)|symptom\w*|side effects?|mg\b|dosage|\d+\s?mg|doctor'?s appointment|physical therapy|ivf|fertility|menstrua\w*|period cramps|mental health|psychiatr\w*|psycholog\w*|counsel(l)?ing|panic attacks?|eating disorder|anorexi\w*|bulimi\w*|vaccin\w*|covid|flu shot)\b/i,
  finance: /\b(salary|salaries|income|net worth|paycheck|bonus of|raise to|bank account|checking account|savings account|account (number|no\.?|#)|routing( number)?|iban|swift|credit (card|score|limit)|debit card|debt|debts|loan|loans|mortgage|owes? (me|him|her|them|us)|in debt|bankrupt\w*|invest(ment|ments|ing|ed)|portfolio|brokerage|(buy|buys|sell|sells|sold|bought|own|owns|hold|holds) (some )?(stocks?|shares)|shares of|crypto\w*|bitcoin|ethereum|401\(?k\)?|roth|\bira\b|pension|tax (return|refund|bill)|taxes owed|irs|venmo|zelle|paypal balance|wire transfer)\b|\bearn(s|ed|ing)? (about |around |over |nearly )?(\$\d|\d[\d,.]*k\b)|\b(makes?|making) (about |around |over |nearly )?\$\d|\$\d[\d,.]*k? (a|an|per) (year|yr|month|hour)\b|\b\d+k (a|per) (year|yr)\b/i,
  credentials: /\b(password|passcode|passphrase|pin (code|number)|login|log-?in|username|user name|2fa|two[- ]factor|otp|one[- ]time code|verification code|recovery (code|key|phrase)|seed phrase|api key|access token|secret key|private key)\b/i,
  govId: /\b(ssn|social security|passport|driver'?s licen[cs]e|licen[cs]e (number|no\.?)|national id|tax id|ein|itin|visa number|green card|alien number|medicare (number|id)|nhs number|aadhaar|pan card)\b/i,
  sexualOrientation: /\b(gay|lesbian|bisexual|queer|homosexual|heterosexual|asexual|pansexual|coming out|came out|sexual orientation|sexuality|lgbt\w*|trans(gender)?|non-?binary)\b/i,
  religion: /\b(religio\w*|church|mosque|synagogue|christian\w*|catholic\w*|protestant\w*|muslim|islam\w*|jewish|judaism|hindu\w*|buddhis\w*|sikh\w*|atheis\w*|agnostic|mormon|evangelical|baptist|methodist|lutheran|orthodox|pray(s|ed|ing)?|prayer|faith|worship\w*|bible|quran|torah|ramadan|diwali|passover|sabbath|mass on sunday)\b/i,
  politics: /\b(democrat\w*|republican\w*|liberal|conservative|politic\w*|vot(e|ed|es|ing) (for|against)|ballot|party member|labour|tory|tories|leftist|left-wing|right-wing|maga|socialis\w*|communis\w*|libertarian|progressive|campaign(ed|ing)? for|donat(e|ed) to .{0,20}campaign|trump|biden|harris|obama)\b/i
}

/** Words that mark a person as a child. */
export const CHILD_REL = /\b(son|daughter|kid|kids|child|children|toddler|baby|newborn|infant|grand(son|daughter|child)|step(son|daughter)|niece|nephew|teen(ager)?)\b/i
/** What may be kept about a child with the children category off: who they are and when their birthday is. */
export const CHILD_OK_KEYS = new Set(['name', 'relationship', 'birthday', 'nickname', 'alias'])

/** PHI-helper identifiers that are never kept (whatever the settings). */
const NEVER_PHI = new Set<PhiType>(['ssn', 'mrn', 'health_plan_id', 'account', 'license', 'vehicle', 'device'])

export interface ScreenResult {
  ok: boolean
  /** Why it was dropped. */
  why?: 'secret' | 'identifier' | SensitiveCategory
  /** The sensitive category it falls in (when that category is on and it was kept). */
  category?: SensitiveCategory
}

export type Optins = Record<SensitiveCategory, boolean>

/** The user asked to keep something ("remember…", "save that", "keep in mind", "don't forget"). */
export const ASKED_TO_REMEMBER = /\b(remember|memori[sz]e|save (that|this|it)|note (that|this|it|down)|make a note|keep in mind|keep that in mind|don'?t forget|do not forget|add (that|this|it) to (your )?memory)\b/i

/** Sensitive categories kept only when the user asks: the memory tool, the idle learner and People & Places never keep them on their own. */
export const ASK_ONLY = new Set<SensitiveCategory>(['health', 'finance', 'govId', 'sexualOrientation', 'religion', 'politics'])
export const ASK_ONLY_LABEL: Record<string, string> = { health: 'health', finance: 'money', govId: 'ID', sexualOrientation: 'sexuality', religion: 'religion', politics: 'politics' }
/** Allergies and diet matter for safety (a food request brings them in): not ask-only health. */
const SAFETY_HEALTH = /\b(allerg(y|ies|ic)( to)?|intoleran(t|ce)( to)?|vegetarian|vegan|pescatarian|gluten[- ]free|gluten|celiac|coeliac|lactose|dairy[- ]free|nut[- ]free)\b/gi

/** The ask-only categories a text touches (allergies and diet aren't health here). */
export function askOnlyCategories(text: string): SensitiveCategory[] {
  return categoriesOf(text).filter((k) => ASK_ONLY.has(k) && (k !== 'health' || RX.health.test(text.replace(SAFETY_HEALTH, ' '))))
}

/** The user asked to remember it: the evidence says so ("remember that I have ADHD"), or a message of theirs holding the evidence does. */
export function askedToRemember(evidence: string | undefined, userMessages: string[]): boolean {
  if (evidence && ASKED_TO_REMEMBER.test(evidence)) return true
  const e = (evidence ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (e.length < 4) return false
  return userMessages.some((m) => ASKED_TO_REMEMBER.test(m) && m.toLowerCase().replace(/\s+/g, ' ').includes(e))
}

/** Which sensitive categories a text touches (none: []). */
export function categoriesOf(text: string): SensitiveCategory[] {
  const out: SensitiveCategory[] = []
  for (const [k, rx] of Object.entries(RX) as Array<[Exclude<SensitiveCategory, 'children'>, RegExp]>) if (rx.test(text)) out.push(k)
  return out
}

/**
 * Whether a candidate fact may be stored. `text` is the whole fact ("Priya: allergic to peanuts");
 * `child` marks a fact about a child (only CHILD_OK_KEYS with the children category off).
 */
export function screen(text: string, optins: Optins, o: { secretValues?: string[]; child?: boolean; key?: string } = {}): ScreenResult {
  if (!text.trim()) return { ok: false, why: 'secret' }
  if (hasSecret(text, o.secretValues ?? [])) return { ok: false, why: 'secret' }
  const phi = scanPhi(text)
  if (phi.findings.some((f) => NEVER_PHI.has(f.type))) return { ok: false, why: 'identifier' }
  const cats = categoriesOf(text)
  // PHI identifiers in a health context: health, even when the words above missed it.
  if (phi.likelyPhi && !cats.includes('health') && phi.findings.some((f) => f.type !== 'date' && f.type !== 'name')) cats.push('health')
  for (const c of cats) if (!optins[c]) return { ok: false, why: c }
  if (o.child && !optins.children && !CHILD_OK_KEYS.has((o.key ?? '').toLowerCase())) return { ok: false, why: 'children' }
  return { ok: true, ...(cats[0] ? { category: cats[0] } : {}) }
}

/** A snippet kept as an interaction: secrets masked, PHI identifiers replaced when it's about health, one line. */
export function cleanSnippet(text: string, secretValues: string[] = [], max = 240): string {
  let t = redactSecrets(text.replace(/\s+/g, ' ').trim(), secretValues)
  if (scanPhi(t).healthContext || hasSecret(t)) t = redactPhi(t).text
  t = t.replace(/\b(?:\d[ -]?){13,19}\b/g, '[number]')
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t
}
