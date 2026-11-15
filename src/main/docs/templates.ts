import { plainText, type Cell, type DocBlock, type ParsedDoc } from './markdown'

// Document templates: the frame around the user's content (memo header, letter blocks, report cover,
// meeting details). They never invent content: a field that isn't given is left out, not filled with
// a placeholder.

export type TemplateKind = 'memo' | 'report' | 'letter' | 'meeting_notes' | 'proposal' | 'resume' | 'invoice'
export const TEMPLATE_KINDS: TemplateKind[] = ['memo', 'report', 'letter', 'meeting_notes', 'proposal', 'resume', 'invoice']

export interface TemplateFields {
  // memo
  to?: string
  from?: string
  cc?: string
  date?: string
  subject?: string
  // letter
  sender?: string
  sender_address?: string
  recipient?: string
  recipient_address?: string
  salutation?: string
  closing?: string
  signature?: string
  // report / proposal
  subtitle?: string
  author?: string
  organization?: string
  prepared_for?: string
  prepared_by?: string
  confidential?: boolean
  // meeting notes
  time?: string
  location?: string
  facilitator?: string
  attendees?: string | string[]
  absent?: string | string[]
  // invoice
  invoice_number?: string
  due_date?: string
  po_number?: string
  /** Payment terms line, e.g. "Net 30". */
  terms?: string
}

/** What a template changes in the document's options. */
export interface TemplateLayout {
  cover?: boolean
  toc?: boolean | 'auto'
  header?: string | false
  footer?: string | false
  pageNumbers?: boolean
  subtitle?: string
  author?: string
  date?: string
  promoteTitle?: boolean
  /** A layout family for the PDF stylesheet ('resume', 'invoice', 'memo', 'letter'). */
  docClass?: string
  /** "Role — Org | dates" headings get the dates at the right margin. */
  sideHeads?: boolean
  /** Aim for this many pages (shrinking spacing, then type, within readable limits). */
  fitPages?: number
}

const list = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.filter(Boolean).join(', ') : v ?? '')
const lines = (s: string | undefined): string[] => (s ?? '').split(/\n|;\s*/).map((x) => x.trim()).filter(Boolean)
const meta = (pairs: Array<[string, string | undefined]>): DocBlock | null => {
  const rows: Cell[][] = pairs.filter(([, v]) => v && v.trim()).map(([k, v]) => [`**${k}**`, v!.trim()])
  return rows.length ? { type: 'table', rows, variant: 'plain', widths: [22, 78] } : null
}

export function longDate(d = new Date()): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

/** Drops a leading H1 that repeats the title (templates write their own). */
function withoutTitle(doc: ParsedDoc, title: string | undefined): { blocks: DocBlock[]; title?: string } {
  const [h, ...rest] = doc.blocks
  if (h?.type === 'heading' && h.level === 1) {
    const text = plainText(h.text)
    if (!title || text.trim().toLowerCase() === title.trim().toLowerCase()) return { blocks: rest, title: title ?? text }
  }
  return { blocks: doc.blocks, title }
}

/**
 * Wraps the body in a template. Returns the blocks to render and the layout options the template implies
 * (explicit options the caller gives still win).
 */
export function applyTemplate(kind: TemplateKind, doc: ParsedDoc, f: TemplateFields = {}, title?: string): { blocks: DocBlock[]; layout: TemplateLayout; title?: string } {
  const body = withoutTitle(doc, title)
  const date = f.date?.trim() || longDate()
  switch (kind) {
    case 'memo': {
      const head = meta([['To', f.to], ['From', f.from], ['CC', f.cc], ['Date', date], ['Subject', f.subject ?? body.title]])
      return {
        blocks: [{ type: 'paragraph', style: 'title', text: f.confidential ? 'Confidential memorandum' : 'Memorandum' }, ...(head ? [head] : []), { type: 'hr' }, ...body.blocks],
        layout: { cover: false, toc: false, header: false, pageNumbers: true, promoteTitle: false, docClass: 'memo' },
        title: f.subject ?? body.title ?? 'Memorandum'
      }
    }
    case 'letter': {
      const out: DocBlock[] = []
      const sender = [f.sender, ...lines(f.sender_address)].filter(Boolean) as string[]
      if (sender.length) out.push({ type: 'paragraph', text: sender.map((s, i) => (i ? `  \n${s}` : `**${s}**`)).join('') })
      out.push({ type: 'paragraph', text: date })
      const to = [f.recipient, ...lines(f.recipient_address)].filter(Boolean) as string[]
      if (to.length) out.push({ type: 'paragraph', text: to.join('  \n') })
      if (f.subject) out.push({ type: 'paragraph', text: `**Re: ${f.subject}**` })
      const textOf = (b: DocBlock | undefined): string => (b?.type === 'paragraph' ? plainText(b.text).trim() : '')
      const hasGreeting = /^(dear|hello|hi|to whom)\b/i.test(textOf(body.blocks[0]))
      const greet = f.salutation ?? (f.recipient ? `Dear ${f.recipient.split(',')[0].trim()},` : undefined)
      if (greet && !hasGreeting) out.push({ type: 'paragraph', text: greet })
      out.push(...body.blocks)
      const CLOSE = /^(sincerely|best|best regards|best wishes|kind regards|warm regards|regards|yours truly|yours sincerely|yours faithfully|respectfully|thanks|thank you|many thanks|cheers),?$/i
      const lastTwo = body.blocks.slice(-2).map(textOf)
      // A sign-off line alone, possibly followed by the signature (a short line) or merged with it ("Best,\nAda").
      const hasClosing = lastTwo.some((t, k) => CLOSE.test(t.split('\n')[0].trim()) && (k === lastTwo.length - 1 || lastTwo[k + 1].length < 60))
      if (!hasClosing) out.push({ type: 'paragraph', text: f.closing ?? 'Sincerely,' })
      if (!hasClosing && (f.signature ?? f.sender)) out.push({ type: 'paragraph', text: `  \n  \n${f.signature ?? f.sender}` })
      return { blocks: out, layout: { cover: false, toc: false, header: false, pageNumbers: false, promoteTitle: false, docClass: 'letter' }, title: f.subject ?? body.title ?? 'Letter' }
    }
    case 'meeting_notes': {
      const head = meta([['Date', date], ['Time', f.time], ['Location', f.location], ['Facilitator', f.facilitator], ['Attendees', list(f.attendees)], ['Absent', list(f.absent)]])
      const t = body.title ?? f.subject ?? 'Meeting notes'
      return {
        blocks: [{ type: 'heading', level: 1, text: t }, ...(head ? [head] : []), ...body.blocks],
        layout: { cover: false, toc: false, header: false, pageNumbers: true, promoteTitle: true },
        title: t
      }
    }
    case 'resume': {
      // "# Name", a contact line, then "## Experience" with "### Role — Company | 2021 – Present" entries.
      const [h, ...rest] = doc.blocks
      const name = h?.type === 'heading' && h.level === 1 ? h.text : (f.sender ?? title ?? 'Résumé')
      const after = h?.type === 'heading' && h.level === 1 ? rest : doc.blocks
      const [first, ...more] = after
      const contact = first?.type === 'paragraph' && plainText(first.text).length < 220 && !/[.!?]\s*$/.test(plainText(first.text).trim()) ? first : undefined
      return {
        blocks: [{ type: 'paragraph', style: 'title', text: name }, ...(contact ? [{ ...contact, style: 'subtitle' as const }] : []), ...(contact ? more : after)],
        layout: { cover: false, toc: false, header: false, pageNumbers: false, promoteTitle: false, docClass: 'resume', sideHeads: true, fitPages: 1 },
        title: plainText(name)
      }
    }
    case 'invoice': {
      const from = [f.sender ?? '', ...lines(f.sender_address)].filter(Boolean).join('  \n')
      const to = [f.recipient ?? '', ...lines(f.recipient_address)].filter(Boolean).join('  \n')
      const facts: Array<[string, string | undefined]> = [['Invoice', f.invoice_number], ['Issued', date], ['Due', f.due_date], ['PO number', f.po_number], ['Terms', f.terms]]
      const out: DocBlock[] = [{ type: 'paragraph', style: 'title', text: 'Invoice' }]
      const factRows = facts.filter(([, v]) => v && v.trim())
      const cells = [from && `**From**  \n${from}`, to && `**Bill to**  \n${to}`, factRows.length ? factRows.map(([k, v]) => `**${k}** ${v}`).join('  \n') : ''].filter(Boolean)
      if (cells.length) {
        const n = cells.length
        out.push({ type: 'table', variant: 'plain', widths: n === 3 ? [34, 34, 32] : n === 2 ? [55, 45] : [100], rows: [cells], align: cells.map((_, i) => (i === n - 1 && factRows.length && n > 1 ? 'right' : 'left')) })
      }
      out.push(...body.blocks)
      return { blocks: out, layout: { cover: false, toc: false, header: false, pageNumbers: false, promoteTitle: false, docClass: 'invoice' }, title: f.invoice_number ? `Invoice ${f.invoice_number}` : title ?? 'Invoice' }
    }
    case 'report':
    case 'proposal': {
      const by = kind === 'proposal'
        ? [f.prepared_for ? `Prepared for ${f.prepared_for}` : '', f.prepared_by ?? f.author ? `Prepared by ${f.prepared_by ?? f.author}` : ''].filter(Boolean).join(' · ')
        : [f.author, f.organization].filter(Boolean).join(' · ')
      return {
        blocks: body.blocks,
        layout: { cover: true, toc: 'auto', header: body.title ?? title, pageNumbers: true, subtitle: f.subtitle, author: by || undefined, date, footer: f.confidential ? 'Confidential' : undefined, docClass: kind },
        title: body.title ?? title
      }
    }
  }
}
