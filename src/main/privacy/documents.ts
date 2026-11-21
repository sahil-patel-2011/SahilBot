import type { PrivacyDocumentKind } from '@shared/privacy'

// Privacy Gate, document safeguard: whole documents that are personal records by nature (a bank statement,
// an internet bill, a pay stub, a tax form, medical records), even where PII-Tracer only tags a few spans.
// Deterministic and deliberately not jumpy: a kind needs several of its own signals plus money or account
// structure, so an article *about* bank statements or a single word "invoice" doesn't trip it.

interface Rule {
  kind: PrivacyDocumentKind
  /** Phrases typical of the document (case-insensitive). */
  signals: RegExp[]
  /** How many distinct signals it needs. */
  need: number
  /** Also needs money amounts (most financial records do). */
  money?: boolean
}

const RULES: Rule[] = [
  {
    kind: 'bank_statement', need: 3, money: true,
    signals: [/\bstatement (period|date)\b/i, /\b(beginning|opening|starting|previous) balance\b/i, /\b(ending|closing|new) balance\b/i, /\baccount (number|no\.?|#)\b/i, /\b(routing|aba|sort code|iban)\b/i, /\b(deposits?|credits?) (and|&) (other )?(additions|credits)\b/i, /\b(withdrawals?|debits?) (and|&) (other )?(subtractions|debits)\b/i, /\b(checking|savings) account\b/i, /\bavailable balance\b/i, /\bdaily (ending )?balance\b/i, /\bfdic\b/i]
  },
  {
    kind: 'card_statement', need: 3, money: true,
    signals: [/\b(minimum|min\.?) payment( due)?\b/i, /\bpayment due date\b/i, /\bcredit (limit|line)\b/i, /\bnew balance\b/i, /\b(purchase|cash advance) apr\b/i, /\bannual percentage rate\b/i, /\bavailable credit\b/i, /\baccount ending in\b/i, /\blate payment warning\b/i, /\bprevious balance\b/i]
  },
  {
    kind: 'utility_bill', need: 3, money: true,
    signals: [/\b(internet|broadband|wi-?fi|cable|fiber|mobile|wireless|phone|electric(ity)?|gas|water|sewer|utility|energy) (service|bill|plan|charges?|usage)\b/i, /\b(amount|total|balance) due\b/i, /\b(due date|pay by|please pay)\b/i, /\bservice (address|period|location)\b/i, /\baccount (number|no\.?|#)\b/i, /\bbilling (period|date|cycle)\b/i, /\b(kwh|therms?|gallons|data usage|gb used|mbps)\b/i, /\bautopay\b/i, /\bmeter (number|reading)\b/i, /\b(previous|last) (bill|payment)\b/i]
  },
  {
    kind: 'pay_stub', need: 3, money: true,
    signals: [/\b(gross|net) pay\b/i, /\bpay (period|date)\b/i, /\bytd\b|\byear[- ]to[- ]date\b/i, /\b(federal|state) (income )?tax( withholding)?\b/i, /\bsocial security\b|\bfica\b|\bmedicare\b/i, /\bdeductions\b/i, /\bemployee (id|number)\b/i, /\bhours worked\b|\bregular hours\b|\bovertime\b/i]
  },
  {
    kind: 'tax_form', need: 2, money: true,
    signals: [/\bform (w-?2|w-?9|1099(-[a-z]+)?|1040|1098|k-?1|8949)\b/i, /\b(employer|payer)'?s? (identification|federal id|ein|tin)\b/i, /\b(wages, tips|taxable income|adjusted gross income|agi)\b/i, /\binternal revenue service\b|\birs\b/i, /\btax year\b/i, /\b(ssn|social security number|taxpayer identification)\b/i, /\bfederal income tax withheld\b/i]
  },
  {
    kind: 'medical_record', need: 3,
    signals: [/\b(patient|member) (name|id|number|dob)\b/i, /\b(date of birth|dob)\b/i, /\b(diagnosis|diagnoses|icd-?10|cpt)\b/i, /\b(mrn|medical record( number)?)\b/i, /\b(prescription|rx|dosage|medication list)\b/i, /\b(lab|test) results?\b/i, /\b(physician|provider|attending|npi)\b/i, /\b(explanation of benefits|eob|claim number|copay|deductible)\b/i, /\b(allergies|vital signs|blood pressure|chief complaint|discharge summary)\b/i]
  },
  {
    kind: 'id_document', need: 2,
    signals: [/\b(passport|driver'?s? licen[cs]e|state id|national id|identity card)\b/i, /\b(date of birth|dob)\b/i, /\b(date of (issue|expiry|expiration)|expires|exp\.?)\b/i, /\b(license|passport|document) (no\.?|number|#)\b/i, /\b(nationality|place of birth|sex:)\b/i, /\bP<[A-Z]{3}[A-Z<]{5,}/]
  }
]

const MONEY = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\s?(?:usd|eur|gbp|cad)?\b)/gi

/** The kind of personal record `text` is, or undefined. Short texts never count (a sentence isn't a document). */
export function classifyDocument(text: string): PrivacyDocumentKind | undefined {
  if (text.length < 200) return undefined
  const sample = text.length > 60_000 ? text.slice(0, 60_000) : text
  const amounts = (sample.match(MONEY) ?? []).length
  let best: { kind: PrivacyDocumentKind; score: number } | undefined
  for (const r of RULES) {
    const hits = r.signals.filter((re) => re.test(sample)).length
    if (hits < r.need || (r.money && amounts < 3)) continue
    const score = hits / r.signals.length
    if (!best || score > best.score) best = { kind: r.kind, score }
  }
  return best?.kind
}
