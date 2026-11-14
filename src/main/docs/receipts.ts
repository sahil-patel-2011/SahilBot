import { parseDate, parseNumber, type SheetSpec } from './xlsx'

// Receipts and invoices (text PDFs) to an expense sheet: vendor, date, subtotal, tax, tip, total,
// currency, receipt number and a category guess. Anything uncertain is marked "check" so a person (or the
// model, looking at the file) confirms it; images need the model's eyes and come in as given rows.

export interface Receipt {
  file: string
  vendor?: string
  date?: string
  subtotal?: number
  tax?: number
  tip?: number
  total?: number
  currency?: string
  number?: string
  category?: string
  status: 'ok' | 'check' | 'needs vision'
  notes?: string[]
}

const CATEGORIES: Array<[RegExp, string]> = [
  [/\b(uber|lyft|taxi|cab|airline|airlines|delta|united|american air|southwest|jetblue|alaska air|amtrak|hertz|avis|enterprise rent|parking|toll|shell|chevron|exxon|bp|mobil|gas station|fuel)\b/i, 'Travel'],
  [/\b(hotel|marriott|hilton|hyatt|airbnb|inn|lodging|motel)\b/i, 'Lodging'],
  [/\b(restaurant|cafe|café|coffee|starbucks|bistro|grill|pizza|bar|kitchen|deli|bakery|doordash|grubhub|uber eats|chipotle|sweetgreen|diner|taqueria|sushi)\b/i, 'Meals'],
  [/\b(staples|office depot|officemax|best buy|apple store|amazon|b&h|newegg|micro center|ikea|home depot|lowe'?s)\b/i, 'Supplies & equipment'],
  [/\b(aws|amazon web services|google cloud|azure|github|slack|zoom|notion|figma|adobe|microsoft|openai|anthropic|dropbox|atlassian|software|subscription|saas)\b/i, 'Software'],
  [/\b(verizon|at&t|t-mobile|comcast|xfinity|spectrum|internet|phone bill|wireless)\b/i, 'Phone & internet'],
  [/\b(fedex|ups|usps|dhl|postage|shipping)\b/i, 'Shipping'],
  [/\b(conference|summit|registration|eventbrite|ticket)\b/i, 'Events']
]

const MONEY = /[-(]?\s*(?:[$€£¥]|usd|eur|gbp)?\s*\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})\b\)?|[-(]?\s*[$€£¥]\s*\d+(?:\.\d{1,2})?\)?/gi

function amountsIn(line: string): number[] {
  return [...line.matchAll(MONEY)].map((m) => parseNumber(m[0].replace(/\s+/g, '').replace(/usd|eur|gbp/i, '$'))?.n).filter((n): n is number => n !== undefined && Number.isFinite(n))
}

function currencyOf(text: string): string | undefined {
  if (/€|\beur\b/i.test(text)) return 'EUR'
  if (/£|\bgbp\b/i.test(text)) return 'GBP'
  if (/¥|\bjpy\b/i.test(text)) return 'JPY'
  if (/\bcad\b|c\$/i.test(text)) return 'CAD'
  if (/\$|\busd\b/i.test(text)) return 'USD'
  return undefined
}

/** Pulls the fields out of a receipt's text. */
export function parseReceipt(text: string, file: string): Receipt {
  const lines = text.replace(/--- Page \d+ ---/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const notes: string[] = []
  const r: Receipt = { file, status: 'ok' }
  // Vendor: the first line that reads like a name (not a date, amount, address or a "receipt" header).
  r.vendor = lines.slice(0, 8).find((l) => /[A-Za-z]{2}/.test(l) && l.length <= 60 && !/^(receipt|invoice|tax invoice|order|bill|statement|sales receipt|thank you|welcome)\b/i.test(l) && !/\d{3,}.*\b(st|street|ave|avenue|rd|road|blvd|suite|ste)\b/i.test(l) && !parseDate(l) && !/^(tel|phone|fax|www\.|http|date|time)\b/i.test(l) && amountsIn(l).length === 0)
  const fromLine = lines.find((l) => /^(from|merchant|vendor|sold by|billed by)\s*[:\-]/i.test(l))
  if (fromLine) r.vendor = fromLine.replace(/^[^:\-]+[:\-]\s*/, '')
  // Date
  for (const l of lines) {
    const cands = [...l.matchAll(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4})\b/gi)]
    const d = cands.map((c) => parseDate(c[1].replace(/(\d)(st|nd|rd|th)/, '$1'))).find(Boolean)
    if (d) { r.date = d.toISOString().slice(0, 10); break }
  }
  // Amounts by label. Later lines win for totals (the grand total comes last).
  const pick = (re: RegExp, avoid?: RegExp): number | undefined => {
    let v: number | undefined
    for (const l of lines) if (re.test(l) && !(avoid && avoid.test(l))) { const a = amountsIn(l); if (a.length) v = a[a.length - 1] }
    return v
  }
  r.subtotal = pick(/\bsub[- ]?total\b/i)
  r.tax = pick(/\b(tax|vat|gst|hst|pst|sales tax)\b/i, /\b(before tax|pre-?tax|tax ?id|tax ?number|vat (no|number|reg))\b/i)
  r.tip = pick(/\b(tip|gratuity)\b/i)
  r.total = pick(/\b(grand total|amount due|balance due|total due|amount paid|total paid|total charged|total amount|invoice total)\b/i) ?? pick(/\btotal\b/i, /\bsub[- ]?total\b|\btotal (tax|savings|discount|items|qty|quantity)\b/i)
  if (r.total === undefined) {
    const all = lines.flatMap(amountsIn)
    if (all.length) { r.total = Math.max(...all); notes.push('total is the largest amount on the receipt (no "Total" line found)') }
  }
  r.currency = currencyOf(text)
  const num = /\b(?:receipt|invoice|order|transaction|ref(?:erence)?|confirmation)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i.exec(lines.join('\n'))
  if (num && /\d/.test(num[1])) r.number = num[1]
  r.category = CATEGORIES.find(([re]) => re.test(text))?.[1]
  // Consistency
  if (r.subtotal !== undefined && r.total !== undefined) {
    const expect = r.subtotal + (r.tax ?? 0) + (r.tip ?? 0)
    if (Math.abs(expect - r.total) > 0.02 && Math.abs(r.subtotal - r.total) > 0.02) notes.push(`subtotal + tax${r.tip ? ' + tip' : ''} (${expect.toFixed(2)}) ≠ total (${r.total.toFixed(2)})`)
  }
  if (!r.vendor) notes.push('no vendor found')
  if (!r.date) notes.push('no date found')
  if (r.total === undefined) notes.push('no total found')
  if (notes.length) { r.status = 'check'; r.notes = notes }
  return r
}

/** The expense workbook: a Receipts sheet (typed, totals, "check" rows highlighted) and a By category summary with live formulas. */
export function receiptsSheets(receipts: Receipt[]): SheetSpec[] {
  const n = receipts.length
  const rows = receipts.map((r) => [r.date ?? null, r.vendor ?? null, r.category ?? 'Uncategorized', r.subtotal ?? null, r.tax ?? null, r.tip ?? null, r.total ?? null, r.currency ?? null, r.number ?? null, r.status, (r.notes ?? []).join('; ') || null, r.file])
  const cats = [...new Set(receipts.map((r) => r.category ?? 'Uncategorized'))].sort()
  const last = n + 1
  return [
    {
      name: 'Receipts',
      columns: [
        { header: 'Date', type: 'date' }, { header: 'Vendor', type: 'text' }, { header: 'Category', type: 'text', options: [...new Set([...cats, 'Travel', 'Lodging', 'Meals', 'Supplies & equipment', 'Software', 'Phone & internet', 'Shipping', 'Events', 'Other', 'Uncategorized'])] },
        { header: 'Subtotal', type: 'currency' }, { header: 'Tax', type: 'currency' }, { header: 'Tip', type: 'currency' }, { header: 'Total', type: 'currency' },
        { header: 'Currency', type: 'text', total: 'none' }, { header: 'Receipt #', type: 'text' }, { header: 'Status', type: 'text', options: ['ok', 'check', 'needs vision'] }, { header: 'Notes', type: 'text', width: 40 }, { header: 'File', type: 'text', width: 30 }
      ],
      rows,
      totals: true,
      conditional: [{ column: 'Status', type: 'text_contains', value: 'check', color: 'yellow' }, { column: 'Status', type: 'text_contains', value: 'vision', color: 'red' }]
    },
    {
      name: 'By category',
      columns: [{ header: 'Category', type: 'text' }, { header: 'Receipts', type: 'integer', total: 'sum' }, { header: 'Total', type: 'currency' }],
      rows: cats.map((c, i) => [c, `=COUNTIF(Receipts!$C$2:$C$${last},A${i + 2})`, `=SUMIF(Receipts!$C$2:$C$${last},A${i + 2},Receipts!$G$2:$G$${last})`]),
      totals: true
    }
  ]
}
