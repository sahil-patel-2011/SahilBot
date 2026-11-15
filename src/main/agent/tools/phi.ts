import type { ToolDef } from '../types'

// A deterministic PHI (protected health information) detector and redactor: regular expressions and
// labels for the HIPAA Safe Harbor identifiers that can be found in plain text (names after a label or
// title, dates, phone and fax numbers, emails, SSNs, record, plan, account and license numbers, vehicle
// and device identifiers, URLs, IP addresses, street addresses, ZIP codes and ages over 89). No model,
// no network: the same text always gives the same findings. It is a safety net, not a guarantee: free
// text clues, unusual names and images are not caught, so a person still reviews the output.
//
// Not wired into the agent yet: register phiTool() in index.ts (next to researchTool) to offer it
// through find_tools("phi"). The hipaa-* skills call it as phi_scan.

/** The Safe Harbor identifier categories (45 CFR 164.514(b)(2)) this detector can find in text. */
export type PhiType =
  | 'name' | 'address' | 'zip' | 'date' | 'age_over_89' | 'phone' | 'fax' | 'email' | 'ssn' | 'mrn'
  | 'health_plan_id' | 'account' | 'license' | 'vehicle' | 'device' | 'url' | 'ip' | 'other_id'

export interface PhiFinding {
  type: PhiType
  /** The Safe Harbor list number (1-18) the finding falls under. */
  identifier: number
  text: string
  start: number
  end: number
  /** high: a format that is almost always an identifier; medium: depends on context. */
  confidence: 'high' | 'medium'
}

export interface PhiScan {
  findings: PhiFinding[]
  counts: Partial<Record<PhiType, number>>
  /** Identifiers were found. */
  hasIdentifiers: boolean
  /** The text also talks about health or care (diagnoses, medicines, visits): identifiers + health = PHI. */
  healthContext: boolean
  /** Likely PHI: identifiers in a health context. */
  likelyPhi: boolean
}

const IDENTIFIER: Record<PhiType, number> = {
  name: 1, address: 2, zip: 2, date: 3, age_over_89: 3, phone: 4, fax: 5, email: 6, ssn: 7, mrn: 8,
  health_plan_id: 9, account: 10, license: 11, vehicle: 12, device: 13, url: 14, ip: 15, other_id: 18
}

/** Placeholder text used by redactPhi. */
export const PHI_PLACEHOLDER: Record<PhiType, string> = {
  name: '[NAME]', address: '[ADDRESS]', zip: '[ZIP]', date: '[DATE]', age_over_89: '[AGE 90+]', phone: '[PHONE]',
  fax: '[FAX]', email: '[EMAIL]', ssn: '[SSN]', mrn: '[MRN]', health_plan_id: '[PLAN ID]', account: '[ACCOUNT]',
  license: '[LICENSE]', vehicle: '[VEHICLE ID]', device: '[DEVICE ID]', url: '[URL]', ip: '[IP]', other_id: '[ID]'
}

// Higher wins when two findings overlap (a labeled MRN beats a bare number read as a phone).
const PRIORITY: Record<PhiType, number> = {
  ssn: 9, mrn: 9, health_plan_id: 9, account: 8, license: 8, device: 8, vehicle: 8, email: 8, url: 7, ip: 7,
  fax: 7, phone: 6, address: 6, name: 6, date: 5, age_over_89: 5, zip: 4, other_id: 3
}

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const STREET_WORDS = ['Street', 'St', 'Avenue', 'Ave', 'Road', 'Rd', 'Boulevard', 'Blvd', 'Lane', 'Ln', 'Drive', 'Dr', 'Court', 'Ct', 'Way', 'Place', 'Pl', 'Terrace', 'Ter', 'Circle', 'Cir', 'Highway', 'Hwy', 'Parkway', 'Pkwy', 'Square', 'Sq', 'Trail', 'Trl']
// Capitalized or all caps ("Main Street", "MAIN ST"), never lowercase ("2 pills at dr" is not an address).
const STREET = [...STREET_WORDS, ...STREET_WORDS.map((w) => w.toUpperCase())].join('|')
/** "mother|next of kin" → "[mM]other|[nN]ext [oO]f [kK]in": labels match in any case, the name after them doesn't. */
const ci = (words: string): string => words.replace(/\b([a-z])/g, (c) => `[${c}${c.toUpperCase()}]`)
const NAME_LABELS = ci('patient name|patient|pt|full name|name|mother|father|parent|guardian|spouse|wife|husband|son|daughter|emergency contact|next of kin|employer|insured|subscriber|resident|client')
const STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR'
// A labeled value: "MRN: 00123", "Member ID # XJ-449", "Acct no. 5531".
const VALUE = '[:#]?\\s*(?:no\\.?|number|num|#)?\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{3,24})'
// Capitalized words for a name: "John", "O'Neil", "Mary-Kate", "J.".
// Never a field label that follows on the same line ("Jane Doe DOB: …", "Jane Doe MRN 0042").
const NOT_NAME_WORD = '(?!(?:DOB|D\\.O\\.B|MRN|SSN|Age|AGE|Sex|SEX|Gender|Date|DATE|Phone|PHONE|Tel|ID|Room|Bed|Acct|Account|Seen|Visit|Address|Email|Fax|Admitted|Discharged|Insurance|Member)\\b)'
const NAME_WORD = `${NOT_NAME_WORD}(?:[A-Z][a-zA-Z'\\-]+|[A-Z]\\.)`

interface Rule { type: PhiType; re: RegExp; group?: number; confidence: PhiFinding['confidence']; check?: (m: string) => boolean }

const hasDigit = (m: string): boolean => /\d/.test(m)

const RULES: Rule[] = [
  { type: 'ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, confidence: 'high' },
  { type: 'ssn', re: /\b(?:ssn|social security(?: number| no\.?)?)\s*[:#]?\s*(\d{3}[- ]?\d{2}[- ]?\d{4})\b/gi, group: 1, confidence: 'high' },
  { type: 'mrn', re: new RegExp(`\\b(?:mrn|mr#|medical record(?: number)?|patient id|chart(?: number| no\\.?| #))\\s*${VALUE}`, 'gi'), group: 1, confidence: 'high', check: hasDigit },
  { type: 'health_plan_id', re: new RegExp(`\\b(?:member id|member number|subscriber id|policy(?: number| no\\.?| #)?|group(?: number| no\\.?| #)|insurance id|beneficiary(?: id| number)?|medicaid(?: id| number)?|medicare(?: id| number)?|mbi)\\s*${VALUE}`, 'gi'), group: 1, confidence: 'high', check: hasDigit },
  // Medicare Beneficiary Identifier format (11 characters, no S, L, O, I, B, Z).
  { type: 'health_plan_id', re: /\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y]{2}\d{2}\b/g, confidence: 'medium' },
  { type: 'account', re: new RegExp(`\\b(?:account|acct|invoice|billing)(?: number| no\\.?| #)?\\s*${VALUE}`, 'gi'), group: 1, confidence: 'high', check: hasDigit },
  { type: 'account', re: /\b(?:\d[ -]?){13,19}\b/g, confidence: 'high', check: (m) => luhn(m.replace(/\D/g, '')) },
  { type: 'license', re: new RegExp(`\\b(?:driver'?s? licen[cs]e|licen[cs]e|dl|certificate|passport)(?: number| no\\.?| #)?\\s*${VALUE}`, 'gi'), group: 1, confidence: 'high', check: hasDigit },
  { type: 'vehicle', re: /\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/g, confidence: 'medium' },
  { type: 'vehicle', re: new RegExp(`\\b(?:license plate|plate(?: number| no\\.?| #)?|vin)\\s*${VALUE}`, 'gi'), group: 1, confidence: 'high', check: hasDigit },
  { type: 'device', re: new RegExp(`\\b(?:serial(?: number| no\\.?| #)?|s/n|device id|udi|imei|pacemaker id|implant id)\\s*${VALUE}`, 'gi'), group: 1, confidence: 'high', check: hasDigit },
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, confidence: 'high' },
  { type: 'url', re: /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, confidence: 'high' },
  { type: 'ip', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, confidence: 'high' },
  { type: 'ip', re: /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, confidence: 'high' },
  { type: 'fax', re: /\bfax\s*(?:number|no\.?|#)?\s*[:#]?\s*((?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/gi, group: 1, confidence: 'high' },
  { type: 'phone', re: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g, confidence: 'high' },
  // Dates: 03/14/1962, 3-14-62, 1962-03-14, March 14, 1962, 14 Mar 1962, March 14th.
  { type: 'date', re: /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:\d{4}|\d{2})\b/g, confidence: 'high' },
  { type: 'date', re: /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g, confidence: 'high' },
  { type: 'date', re: new RegExp(`\\b(?:${MONTHS})\\.?\\s+(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:,?\\s+(?:19|20)\\d{2})?\\b`, 'gi'), confidence: 'high' },
  { type: 'date', re: new RegExp(`\\b(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\.?(?:,?\\s+(?:19|20)\\d{2})\\b`, 'gi'), confidence: 'high' },
  { type: 'age_over_89', re: /\b(?:9\d|1[0-1]\d)(?:\s|-)?(?:years?|yrs?|y\/?o)(?:[\s-]old)?\b/gi, confidence: 'high' },
  { type: 'age_over_89', re: /\bage[d:]?\s*(9\d|1[0-1]\d)\b/gi, group: 1, confidence: 'high' },
  { type: 'address', re: new RegExp(`\\b\\d{1,6}[ \\t]+(?:[NSEW]\\.?[ \\t]+)?(?:[A-Z][a-zA-Z0-9]*[ \\t]+){1,4}(?:${STREET})\\b\\.?(?:,?[ \\t]+(?:[Aa]pt|APT|[Aa]partment|[Uu]nit|UNIT|[Ss]uite|[Ss]te|#)\\.?[ \\t]*[A-Za-z0-9-]+)?`, 'g'), confidence: 'high' },
  { type: 'address', re: /\b(?:p\.?\s?o\.?\s+box|post office box)\s+\d+\b/gi, confidence: 'high' },
  { type: 'zip', re: new RegExp(`\\b(?:${STATES})\\s+(\\d{5}(?:-\\d{4})?)\\b`, 'g'), group: 1, confidence: 'high' },
  { type: 'zip', re: /\b(?:zip|zip code|postal code)\s*[:#]?\s*(\d{5}(?:-\d{4})?)\b/gi, group: 1, confidence: 'high' },
  // Names: after a label ("Patient: Jane Q. Doe", "Mother: Ana Ruiz") or a title ("Mr. Smith").
  // "DOE, JANE" style first, so it wins over the plain label rule below.
  { type: 'name', re: new RegExp(`\\b(?:${NAME_LABELS})[ \\t]*[:\\-][ \\t]*([A-Z][A-Za-z'\\-]+,[ \\t]*[A-Z][A-Za-z'\\-]+(?:[ \\t]+[A-Z]\\.?)?)`, 'g'), group: 1, confidence: 'high' },
  { type: 'name', re: new RegExp(`\\b(?:${NAME_LABELS})[ \\t]*[:\\-][ \\t]*((?:${NAME_WORD})(?:[ \\t](?:${NAME_WORD})){0,3})`, 'g'), group: 1, confidence: 'high' },
  { type: 'name', re: new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Mx)\\.?[ \\t]+((?:${NAME_WORD})(?:[ \\t](?:${NAME_WORD})){0,2})`, 'g'), group: 1, confidence: 'medium' },
  { type: 'other_id', re: new RegExp(`\\b(?:case(?: number| no\\.?| #)|encounter(?: id| number)|visit(?: id| number)|accession(?: number| no\\.?| #)?|specimen(?: id| number)|claim(?: id| number| no\\.?| #))\\s*${VALUE}`, 'gi'), group: 1, confidence: 'high', check: hasDigit }
]

// Words that make a text about health or care: diagnoses, visits, medicines, results, codes.
const HEALTH = /\b(?:patient|diagnos\w*|dx|hx|history of|symptom\w*|prescri\w*|medication\w*|\d+\s?mg\b|dose|tablet|treatment|therapy|surgery|procedure|admit\w*|discharg\w*|clinic\w*|hospital\w*|physician|nurse|appointment|visit|lab results?|biopsy|mri|ct scan|x-ray|blood (?:pressure|test|work)|a1c|psa|cancer|diabetes|hypertension|depression|anxiety|pregnan\w*|allerg\w*|icd-?10|cpt|insurance|claim|medicare|medicaid|chief complaint|assessment|plan of care|soap)\b/i

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

/** Words a name rule can catch that are not names ("Patient: Denies pain", "Name: Unknown"). */
const NOT_NAME = /^(?:denies|reports|states|presents|unknown|none|n\/a|na|not|no|yes|the|a|an|is|was|has|had|male|female|adult|child|infant|seen|here|see|per|with|without|doing|feeling|stable|alert)\b/i

/** Every identifier found in the text, in order, with overlaps resolved (longest, most specific wins). */
export function scanPhi(text: string): PhiScan {
  const raw: PhiFinding[] = []
  for (const r of RULES) {
    r.re.lastIndex = 0
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      if (m[0].length === 0) { r.re.lastIndex++; continue }
      const value = r.group ? m[r.group] : m[0]
      if (!value) continue
      const start = r.group ? m.index + m[0].lastIndexOf(value) : m.index
      const clean = value.replace(/[.,;:]+$/, '')
      if (r.check && !r.check(clean)) continue
      if (r.type === 'name' && NOT_NAME.test(clean)) continue
      raw.push({ type: r.type, identifier: IDENTIFIER[r.type], text: clean, start, end: start + clean.length, confidence: r.confidence })
    }
  }
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || PRIORITY[b.type] - PRIORITY[a.type])
  const findings: PhiFinding[] = []
  for (const f of raw) {
    const prev = findings[findings.length - 1]
    if (prev && f.start < prev.end) {
      // Overlap: keep the more specific type, then the longer span.
      const better = PRIORITY[f.type] > PRIORITY[prev.type] || (PRIORITY[f.type] === PRIORITY[prev.type] && f.end - f.start > prev.end - prev.start)
      if (better) findings[findings.length - 1] = { ...f, start: Math.min(f.start, prev.start), end: Math.max(f.end, prev.end), text: text.slice(Math.min(f.start, prev.start), Math.max(f.end, prev.end)) }
      else if (f.end > prev.end) findings[findings.length - 1] = { ...prev, end: f.end, text: text.slice(prev.start, f.end) }
      continue
    }
    findings.push(f)
  }
  const counts: Partial<Record<PhiType, number>> = {}
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1
  const healthContext = HEALTH.test(text)
  return { findings, counts, hasIdentifiers: findings.length > 0, healthContext, likelyPhi: findings.length > 0 && healthContext }
}

/** The text with every finding replaced by a typed placeholder ("[NAME]", "[DATE]"…). */
export function redactPhi(text: string, opts: { keepYear?: boolean } = {}): { text: string; scan: PhiScan; replaced: number } {
  const scan = scanPhi(text)
  let out = ''
  let at = 0
  for (const f of scan.findings) {
    out += text.slice(at, f.start)
    // Safe Harbor allows the year of a date (but not for ages over 89).
    const year = opts.keepYear && f.type === 'date' ? f.text.match(/\b(?:19|20)\d{2}\b/)?.[0] : undefined
    out += year ? `[DATE ${year}]` : PHI_PLACEHOLDER[f.type]
    at = f.end
  }
  out += text.slice(at)
  return { text: out, scan, replaced: scan.findings.length }
}

/** "John Smith" → "J*** S****": enough to recognize a finding without repeating it. */
export function maskValue(s: string): string {
  return s.replace(/[A-Za-z0-9]+/g, (w) => (w.length <= 1 ? '*' : w[0] + '*'.repeat(Math.min(w.length - 1, 8))))
}

const LABEL: Record<PhiType, string> = {
  name: 'names', address: 'street addresses', zip: 'ZIP codes', date: 'dates', age_over_89: 'ages over 89', phone: 'phone numbers',
  fax: 'fax numbers', email: 'emails', ssn: 'Social Security numbers', mrn: 'medical record numbers', health_plan_id: 'health plan IDs',
  account: 'account or card numbers', license: 'license or certificate numbers', vehicle: 'vehicle identifiers', device: 'device identifiers',
  url: 'URLs', ip: 'IP addresses', other_id: 'other identifying numbers'
}

export function summarizeScan(scan: PhiScan): string {
  if (!scan.hasIdentifiers) return `No HIPAA identifiers found by the automatic check${scan.healthContext ? ' (the text is about health, so still read it for names or other clues the check can miss)' : ''}.`
  const parts = (Object.keys(scan.counts) as PhiType[]).map((t) => `${scan.counts[t]} ${LABEL[t]}`)
  return `${scan.likelyPhi ? 'Likely PHI' : 'Identifiers found'}: ${parts.join(', ')}.${scan.healthContext ? ' The text is about health or care.' : ' No health context detected (identifiers alone are personal data, not PHI).'}`
}

type Args = { action: 'scan' | 'redact'; text: string; keep_year?: boolean }

/** A read-only tool: finds or redacts identifiers in text the agent already has. Nothing leaves the Mac. */
export function phiTool(): ToolDef<Args> {
  return {
    name: 'phi_scan',
    label: 'Checking for PHI',
    group: 'Privacy',
    effect: 'read',
    description: 'Check text for HIPAA identifiers (names after labels or titles, dates, phone/fax, email, SSN, MRN, health plan, account, license, vehicle and device numbers, URLs, IPs, addresses, ZIPs, ages over 89) before sharing it, sending it to a cloud model or connector, or saving it. action "scan" lists what was found (values masked); "redact" returns the text with typed placeholders like [NAME] and [DATE] (keep_year keeps the year of dates, as Safe Harbor allows). Runs locally and deterministically; it can miss free-text clues, so still read the result. See the hipaa-handling-phi skill.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'redact'] },
        text: { type: 'string', minLength: 1, maxLength: 200_000, description: 'The text to check (read files first with file_read)' },
        keep_year: { type: 'boolean', description: 'redact: keep the year of dates, e.g. [DATE 2024]' }
      },
      required: ['action', 'text'],
      additionalProperties: false
    },
    async run(a) {
      if (a.action === 'redact') {
        const r = redactPhi(a.text, { keepYear: a.keep_year })
        return {
          text: `${summarizeScan(r.scan)} Replaced ${r.replaced}. Review the redacted text for anything the check missed (unusual names, relatives, employers, rare details) before sharing.\n\n${r.text}`,
          display: r.replaced ? `redacted ${r.replaced} identifier${r.replaced === 1 ? '' : 's'}` : 'no identifiers found'
        }
      }
      const scan = scanPhi(a.text)
      const list = scan.findings.slice(0, 60).map((f) => `- ${LABEL[f.type]} (#${f.identifier}, ${f.confidence}): ${maskValue(f.text)} at ${f.start}`)
      return {
        text: [summarizeScan(scan), ...(list.length ? ['Findings (values masked):', ...list] : []), scan.findings.length > 60 ? `…and ${scan.findings.length - 60} more.` : '', scan.hasIdentifiers ? 'Before sending this to a cloud model, connector or anyone outside the care team: redact it (action "redact") or confirm the user\'s setup allows it (BAA).' : ''].filter(Boolean).join('\n'),
        display: scan.hasIdentifiers ? `${scan.findings.length} identifier${scan.findings.length === 1 ? '' : 's'} found` : 'no identifiers found'
      }
    }
  }
}
