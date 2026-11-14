import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { functionsIn } from './formula'
import { inspectDocx, inspectPptx, type DocxInfo, type DeckInfo } from './inspect'
import { pdfFields } from './pdf'
import { pdfText } from './read'
import { computeWorkbook, isDateFmt, loadWorkbook, parseCsv, parseNumber, readSheets, sheetGrid, showValue } from './xlsx'
import type { Value } from './formula'

// review_document: reads a finished .docx/.xlsx/.pptx/.pdf back and checks it against a rubric —
// structure (heading order, a TOC when long, no empty sections or slides), formatting (consistent
// styles, no overflowing slide text, no #REF!/#DIV/0!, formulas compute, totals cover their data),
// content (placeholders, duplicated paragraphs, numbers that don't match a source table) and common
// typos. Every finding has a location, so the agent can fix it and review again.

export type Area = 'structure' | 'formatting' | 'content' | 'spelling' | 'numbers'
export interface ReviewCheck { area: Area; status: 'pass' | 'fail' | 'warn'; message: string; where?: string }
export interface Review { file: string; kind: string; pass: boolean; checks: ReviewCheck[]; summary: string }

export interface ReviewOptions {
  /** A source table to check numbers against: rows (first row headers) or a CSV/XLSX file's bytes. */
  source?: { rows?: Array<Array<string | number | null>>; data?: Buffer; name?: string }
  /** Expect a table of contents regardless of length. */
  requireToc?: boolean
}

// ------------------------------------------------------------------ text checks

export const TYPOS: Record<string, string> = {
  teh: 'the', adn: 'and', recieve: 'receive', recieved: 'received', reciept: 'receipt', seperate: 'separate', seperately: 'separately', occured: 'occurred', occurence: 'occurrence',
  occurrance: 'occurrence', definately: 'definitely', definatly: 'definitely', accomodate: 'accommodate', accomodation: 'accommodation', acheive: 'achieve', acheived: 'achieved', adress: 'address',
  begining: 'beginning', beleive: 'believe', calender: 'calendar', collegue: 'colleague', colleage: 'colleague', commited: 'committed', commitee: 'committee', concensus: 'consensus', enviroment: 'environment',
  existance: 'existence', foward: 'forward', goverment: 'government', guage: 'gauge', independant: 'independent', liason: 'liaison', maintainance: 'maintenance', maintenence: 'maintenance', millenium: 'millennium',
  neccessary: 'necessary', necesary: 'necessary', noticable: 'noticeable', persue: 'pursue', posession: 'possession', prefered: 'preferred', publically: 'publicly', recomend: 'recommend', reccomend: 'recommend',
  recommand: 'recommend', refered: 'referred', relevent: 'relevant', responsibilty: 'responsibility', succesful: 'successful', successfull: 'successful', sucessful: 'successful', supercede: 'supersede',
  tommorow: 'tomorrow', tommorrow: 'tomorrow', truely: 'truly', untill: 'until', wich: 'which', wierd: 'weird', alot: 'a lot', thier: 'their', buisness: 'business', bussiness: 'business', busines: 'business',
  managment: 'management', finacial: 'financial', financal: 'financial', quater: 'quarter', quaterly: 'quarterly', accross: 'across', agressive: 'aggressive', apparant: 'apparent', arguement: 'argument',
  basicly: 'basically', comming: 'coming', completly: 'completely', dissapoint: 'disappoint', embarass: 'embarrass', excercise: 'exercise', familar: 'familiar', fourty: 'forty', freind: 'friend',
  grammer: 'grammar', harrass: 'harass', immediatly: 'immediately', knowlege: 'knowledge', lenght: 'length', ocassion: 'occasion', paralel: 'parallel', perfomance: 'performance', performace: 'performance',
  priviledge: 'privilege', recieving: 'receiving', schedual: 'schedule', strenght: 'strength', sucess: 'success', threshhold: 'threshold', wether: 'whether', analysys: 'analysis', anual: 'annual',
  availible: 'available', avaliable: 'available', benifit: 'benefit', catagory: 'category', comittee: 'committee', compatable: 'compatible', competetive: 'competitive', concious: 'conscious',
  convinient: 'convenient', critisism: 'criticism', curent: 'current', develope: 'develop', developement: 'development', diffrent: 'different', effecient: 'efficient',
  efficency: 'efficiency', equiptment: 'equipment', estimatation: 'estimation', expierence: 'experience', experiance: 'experience', explaination: 'explanation', fullfill: 'fulfill', guarentee: 'guarantee',
  guidence: 'guidance', implmentation: 'implementation', imporant: 'important', improvment: 'improvement', inital: 'initial', intrest: 'interest', languange: 'language', lisence: 'license', mesage: 'message',
  milestome: 'milestone', oppurtunity: 'opportunity', oportunity: 'opportunity', organisaton: 'organisation', particpant: 'participant', payed: 'paid', percieve: 'perceive', posible: 'possible',
  potencial: 'potential', presense: 'presence', proccess: 'process', proffesional: 'professional', profesional: 'professional', propsal: 'proposal', proposel: 'proposal', recipt: 'receipt', refrence: 'reference',
  reponse: 'response', resourse: 'resource', revenu: 'revenue', reveune: 'revenue', sincerly: 'sincerely', stategy: 'strategy', stratergy: 'strategy', summery: 'summary', suport: 'support', targetted: 'targeted',
  temperture: 'temperature', thrid: 'third', trasnfer: 'transfer', unfortunatly: 'unfortunately', usefull: 'useful', wheather: 'whether', wrting: 'writing', yeild: 'yield'
}

const PLACEHOLDER = /\b(TBD|TBA|TODO|FIXME|XXX+|lorem ipsum|dolor sit amet)\b|\[(insert|add|your|company|client|customer|name|date|title|address|amount|number|link|logo|placeholder|todo|tbd)\b[^\]]*\]|<(insert|your|add|name|company|date)\b[^>]*>|\{\{[^}]{1,40}\}\}|\?\?\?+|\bplaceholder text\b|\bclick here to (add|edit|insert)\b/i

export interface TextItem { text: string; where: string }

export function placeholderChecks(items: TextItem[]): ReviewCheck[] {
  const out: ReviewCheck[] = []
  for (const it of items) {
    for (const m of it.text.matchAll(new RegExp(PLACEHOLDER.source, 'gi'))) out.push({ area: 'content', status: 'fail', message: `Placeholder "${m[0]}" left in: "${clip(it.text, 90)}"`, where: it.where })
  }
  return out
}

export function duplicateChecks(items: TextItem[]): ReviewCheck[] {
  const seen = new Map<string, string>()
  const out: ReviewCheck[] = []
  for (const it of items) {
    const k = it.text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w ]/g, '').trim()
    if (k.length < 40) continue
    const prev = seen.get(k)
    if (prev) out.push({ area: 'content', status: 'fail', message: `Duplicated text (also at ${prev}): "${clip(it.text, 80)}"`, where: it.where })
    else seen.set(k, it.where)
  }
  return out
}

export function spellingChecks(items: TextItem[]): ReviewCheck[] {
  const out: ReviewCheck[] = []
  for (const it of items) {
    for (const m of it.text.matchAll(/\b[A-Za-z']+\b/g)) {
      const w = m[0].toLowerCase()
      const fix = TYPOS[w]
      if (fix) out.push({ area: 'spelling', status: 'fail', message: `"${m[0]}" → "${fix}"`, where: it.where })
    }
    for (const m of it.text.matchAll(/\b(\w{2,})\s+\1\b/gi)) {
      if (/^(\d+|ha|bye|no|very|so|that|had)$/i.test(m[1])) continue
      out.push({ area: 'spelling', status: 'fail', message: `Repeated word "${m[0]}"`, where: it.where })
    }
  }
  return out
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ')

// ------------------------------------------------------------------ numbers vs a source table

interface Source { labels: Map<string, Map<string, number>>; numbers: number[] }

const normLabel = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

async function loadSource(src: NonNullable<ReviewOptions['source']>): Promise<Source> {
  let rows: Array<Array<Value | string | number | null>>
  if (src.rows) rows = src.rows
  else if (src.data && /\.xlsx?$/i.test(src.name ?? '')) {
    const wb = await loadWorkbook(src.data)
    rows = sheetGrid(readSheets(wb)[0])
  } else if (src.data) rows = parseCsv(src.data.toString('utf8'))
  else rows = []
  const [head = [], ...body] = rows
  const labels = new Map<string, Map<string, number>>()
  const numbers: number[] = []
  for (const r of body) {
    const label = normLabel(String(r[0] ?? ''))
    const m = new Map<string, number>()
    r.forEach((v, c) => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v)?.n : undefined
      if (n === undefined) return
      numbers.push(n)
      if (c > 0) m.set(normLabel(String(head[c] ?? '')), n)
    })
    if (label) labels.set(label, m)
  }
  return { labels, numbers }
}

/** Parses a number as written in a document: "$1.2M", "12.5%", "(300)", "4,200". */
function docNumber(s: string): { value: number; tol: number; pct: boolean } | undefined {
  const m = /^\s*\(?\s*([-+]?)\s*[$€£¥]?\s*([\d,]*\.?\d+)\s*(%|k|m|mm|bn|b|million|billion|thousand)?\s*\)?\s*$/i.exec(s)
  if (!m) return undefined
  const digits = m[2].replace(/,/g, '')
  const dec = (digits.split('.')[1] ?? '').length
  const unit = (m[3] ?? '').toLowerCase()
  const scale = unit === 'k' || unit === 'thousand' ? 1e3 : unit === 'm' || unit === 'mm' || unit === 'million' ? 1e6 : unit === 'b' || unit === 'bn' || unit === 'billion' ? 1e9 : 1
  const neg = m[1] === '-' || /^\s*\(/.test(s)
  const v = Number(digits) * scale * (neg ? -1 : 1)
  return { value: v, tol: 0.5 * Math.pow(10, -dec) * scale + 1e-9, pct: unit === '%' }
}

function matchesSource(n: { value: number; tol: number; pct: boolean }, src: number[]): boolean {
  return src.some((s) => Math.abs(s - n.value) <= n.tol || (n.pct && Math.abs(s * 100 - n.value) <= n.tol) || Math.abs(Math.abs(s) - Math.abs(n.value)) <= n.tol)
}

function numberChecks(tables: Array<{ rows: string[][]; where: string }>, prose: TextItem[], src: Source): ReviewCheck[] {
  const out: ReviewCheck[] = []
  let compared = 0
  for (const t of tables) {
    const [head = [], ...rows] = t.rows
    const cols = head.map((h) => normLabel(h))
    for (const r of rows) {
      const want = src.labels.get(normLabel(r[0] ?? ''))
      if (!want) continue
      r.forEach((cell, c) => {
        if (c === 0) return
        const expected = want.get(cols[c] ?? '')
        const got = docNumber(cell)
        if (expected === undefined || !got) return
        compared++
        if (!matchesSource(got, [expected])) out.push({ area: 'numbers', status: 'fail', message: `${r[0]} / ${head[c]} is ${cell.trim()} but the source says ${expected}`, where: t.where })
      })
    }
  }
  for (const it of prose) {
    for (const m of it.text.matchAll(/(?<![\w.])\(?[-+]?[$€£¥]?\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|m\b|mm\b|bn\b|b\b|million\b|billion\b|thousand\b)?\)?/gi)) {
      const raw = m[0]
      const n = docNumber(raw)
      if (!n) continue
      const plain = raw.replace(/[^\d.]/g, '')
      if (/^(19|20)\d\d$/.test(plain) && !/[$%.,]/.test(raw)) continue
      if (plain.replace('.', '').length < 3 && !/[$%]/.test(raw)) continue
      compared++
      if (!matchesSource(n, src.numbers)) out.push({ area: 'numbers', status: 'warn', message: `${raw.trim()} isn't in the source table: "${clip(it.text, 70)}"`, where: it.where })
    }
  }
  if (!out.length) out.push({ area: 'numbers', status: 'pass', message: compared ? `${compared} numbers match the source` : 'No numbers to compare with the source' })
  return out
}

// ------------------------------------------------------------------ per format

function reviewDocx(d: DocxInfo): { checks: ReviewCheck[]; texts: TextItem[]; tables: Array<{ rows: string[][]; where: string }>; summary: string } {
  const checks: ReviewCheck[] = []
  const body = d.paragraphs.filter((p) => !p.inToc)
  const texts: TextItem[] = body.filter((p) => p.text.trim()).map((p) => ({ text: p.text, where: p.inTable ? `table, paragraph ${p.i + 1}` : `paragraph ${p.i + 1}${p.heading ? ` (H${p.heading})` : ''}` }))
  const where = (i: number) => {
    const h = [...d.headings].reverse().find((x) => x.i <= i)
    return `paragraph ${i + 1}${h ? ` under "${clip(h.text, 40)}"` : ''}`
  }
  // Structure
  let prev = 0, jumps = 0
  for (const h of d.headings) {
    if (prev && h.level > prev + 1) { jumps++; checks.push({ area: 'structure', status: 'fail', message: `Heading jumps from H${prev} to H${h.level}: "${clip(h.text, 60)}" (make it H${prev + 1})`, where: `paragraph ${h.i + 1}` }) }
    prev = h.level
  }
  if (d.headings.length && !jumps) checks.push({ area: 'structure', status: 'pass', message: `${d.headings.length} headings in order` })
  if (!d.headings.length && d.words > 350) checks.push({ area: 'structure', status: 'warn', message: `${d.words} words with no headings: add Heading 1/2 sections so it can be scanned` })
  const sections = d.headings.filter((h) => h.level <= 2).length
  const long = (sections >= 4 && d.words > 800) || (sections >= 2 && d.words > 2000)
  if (long && !d.toc.present) checks.push({ area: 'structure', status: 'fail', message: `Long document (${d.words} words, ${d.headings.length} headings) without a table of contents: add [TOC] or toc: true` })
  else if (d.toc.present) checks.push({ area: 'structure', status: d.toc.entries ? 'pass' : 'warn', message: d.toc.entries ? `Table of contents with ${d.toc.entries} entries${d.toc.pageNumbers ? ' and page numbers' : ''}` : 'Table of contents is empty until Word updates it (References > Update Table)' })
  // Empty sections: a heading followed by another heading at the same or a higher level, or by nothing.
  for (let k = 0; k < d.headings.length; k++) {
    const h = d.headings[k], next = d.headings[k + 1]
    const end = next ? next.i : body.length
    const content = body.filter((p) => p.i > h.i && p.i < end && (p.text.trim() || p.inTable)).length
    const parentOfNext = next && next.level > h.level
    if (!content && !parentOfNext) checks.push({ area: 'structure', status: 'fail', message: `Empty section: "${clip(h.text, 60)}" has no content`, where: `paragraph ${h.i + 1}` })
  }
  if (!d.title && !d.headings.some((h) => h.level === 1)) checks.push({ area: 'structure', status: 'warn', message: 'No title (Title style or a Heading 1) at the top' })
  // Formatting
  const fake = body.filter((p, k) => !p.heading && !p.inTable && p.allBold && p.text.trim().length > 0 && p.text.trim().length < 70 && !/[.:;,]$/.test(p.text.trim()) && /^normal$/i.test(d.styles[p.style] ?? p.style) && body[k + 1]?.text.trim() && !body[k + 1]?.allBold)
  for (const p of fake.slice(0, 5)) checks.push({ area: 'formatting', status: 'warn', message: `"${clip(p.text, 50)}" is bold body text used as a heading; use a Heading style so it shows in the TOC and navigation`, where: where(p.i) })
  const fonts = new Set(body.flatMap((p) => p.fonts).filter((f) => !/mono|consolas|courier|menlo/i.test(f)))
  if (fonts.size > 2) checks.push({ area: 'formatting', status: 'warn', message: `${fonts.size} different body fonts (${[...fonts].slice(0, 5).join(', ')}): use one body font and one heading font` })
  const sizes = new Set(body.filter((p) => !p.heading && !p.inTable).flatMap((p) => p.sizes))
  if (sizes.size > 3) checks.push({ area: 'formatting', status: 'warn', message: `Body text in ${sizes.size} different sizes (${[...sizes].sort((a, b) => a - b).join(', ')} pt): set sizes with styles` })
  if (fonts.size <= 2 && sizes.size <= 3 && !fake.length) checks.push({ area: 'formatting', status: 'pass', message: 'Consistent styles' })
  d.tables.forEach((t, k) => {
    if (!t.rows.length) return
    if (!t.headerRow && t.rows.length > 3 && t.rows[0].every((c) => c && !/^\s*[-$\d]/.test(c))) checks.push({ area: 'formatting', status: 'warn', message: `Table ${k + 1}'s first row isn't marked as a header row (it won't repeat across pages)`, where: `table ${k + 1}` })
    const emptyCols = t.rows[0]?.map((_, c) => t.rows.slice(1).every((r) => !r[c]?.trim())).filter(Boolean).length ?? 0
    if (t.rows.length > 1 && emptyCols) checks.push({ area: 'content', status: 'fail', message: `Table ${k + 1} has ${emptyCols} empty column(s)`, where: `table ${k + 1}` })
  })
  if (d.words > 1200 && !d.pageNumberField) checks.push({ area: 'formatting', status: 'warn', message: 'No page numbers in the header or footer' })
  for (const p of body.filter((x) => (x.text.match(/\S+/g) ?? []).length > 220).slice(0, 3)) checks.push({ area: 'formatting', status: 'warn', message: `Very long paragraph (${(p.text.match(/\S+/g) ?? []).length} words): split it`, where: where(p.i) })
  const summary = `Word, ${d.words.toLocaleString('en-US')} words, ${d.headings.length} headings, ${d.tables.length} tables, ${d.images} images${d.footnotes.length ? `, ${d.footnotes.length} footnotes` : ''}${d.sections.some((s) => s.orientation === 'landscape') ? ', landscape section' : ''}`
  return { checks, texts, tables: d.tables.map((t, k) => ({ rows: t.rows, where: `table ${k + 1}` })), summary }
}

function reviewPptx(deck: DeckInfo): { checks: ReviewCheck[]; texts: TextItem[]; tables: Array<{ rows: string[][]; where: string }>; summary: string } {
  const checks: ReviewCheck[] = []
  const texts: TextItem[] = []
  let overflow = 0
  const titles = new Map<string, number>()
  for (const s of deck.slides) {
    const at = `slide ${s.n}`
    for (const sh of s.shapes) for (const p of sh.paragraphs) texts.push({ text: p.text, where: `${at}${sh.isTitle ? ' title' : ''}` })
    for (const t of s.tables) for (const r of t.rows) texts.push({ text: r.join(' | '), where: `${at} table` })
    if (s.notes) texts.push({ text: s.notes, where: `${at} notes` })
    const empty = !s.texts.some((t) => t.trim()) && !s.charts.length && !s.images && !s.tables.length
    if (empty) { checks.push({ area: 'structure', status: 'fail', message: 'Empty slide', where: at }); continue }
    if (!s.title && !(s.images && s.texts.length <= 1)) checks.push({ area: 'structure', status: 'fail', message: 'Slide has no title', where: at })
    if (s.title) {
      const k = s.title.replace(/\s*\(cont\.?\)\s*$/i, '').trim().toLowerCase()
      if (!/\(cont/i.test(s.title)) titles.set(k, (titles.get(k) ?? 0) + 1)
      if (s.title.length > 90) checks.push({ area: 'formatting', status: 'warn', message: `Title is ${s.title.length} characters; keep headlines under ~70`, where: at })
    }
    for (const sh of s.shapes) {
      if (/slide number/i.test(sh.name)) continue
      if (sh.fill > 1.05) { overflow++; checks.push({ area: 'formatting', status: 'fail', message: `Text overflows its box "${sh.name || 'text'}" (needs ~${Math.round(sh.fill * 100)}% of the space): shorten it, split the slide, or move detail to the notes`, where: at }) }
      if (sh.x + sh.w > deck.width + 0.05 || sh.y + sh.h > deck.height + 0.05 || sh.x < -0.05 || sh.y < -0.05) checks.push({ area: 'formatting', status: 'fail', message: `"${sh.name || 'A text box'}" runs off the slide`, where: at })
      const small = sh.paragraphs.filter((p) => p.size < 12)
      if (small.length && !sh.isTitle && !/caption|footer|source|label/i.test(sh.name)) checks.push({ area: 'formatting', status: 'warn', message: `Text at ${Math.min(...small.map((p) => p.size))} pt is hard to read when presented (use 14 pt or more)`, where: at })
    }
    const body = s.shapes.filter((x) => !x.isTitle && !/slide number/i.test(x.name))
    const bullets = body.reduce((n, x) => n + x.paragraphs.length, 0)
    const words = body.reduce((n, x) => n + x.paragraphs.reduce((m, p) => m + (p.text.match(/\S+/g) ?? []).length, 0), 0)
    if (bullets > 8) checks.push({ area: 'formatting', status: 'warn', message: `${bullets} bullet lines: aim for 6 or fewer; move detail to the notes`, where: at })
    else if (words > 110) checks.push({ area: 'formatting', status: 'warn', message: `${words} words on one slide: trim it to the key points`, where: at })
    for (const c of s.charts) if (!c.series || !c.points) checks.push({ area: 'content', status: 'fail', message: `Chart has no data (${c.series} series, ${c.points} points)`, where: at })
  }
  for (const [t, n] of titles) if (n > 1) checks.push({ area: 'content', status: 'warn', message: `${n} slides share the title "${clip(t, 50)}": give each slide its own headline` })
  if (!overflow) checks.push({ area: 'formatting', status: 'pass', message: 'No text overflows its box' })
  const later = deck.slides.slice(1)
  if (later.length >= 3 && later.filter((s) => s.slideNumber).length < later.length / 2) checks.push({ area: 'formatting', status: 'warn', message: 'No slide numbers' })
  if (deck.fonts.length > 3) checks.push({ area: 'formatting', status: 'warn', message: `${deck.fonts.length} fonts in the deck (${deck.fonts.join(', ')}): use one heading and one body font` })
  if (Math.abs(deck.width / deck.height - 16 / 9) > 0.02) checks.push({ area: 'formatting', status: 'warn', message: `Slides are ${deck.width.toFixed(2)}×${deck.height.toFixed(2)} in, not 16:9` })
  if (deck.slides.length >= 8 && !deck.slides.some((s) => s.notes)) checks.push({ area: 'content', status: 'warn', message: 'No speaker notes in an 8+ slide deck' })
  const charts = deck.slides.reduce((n, s) => n + s.charts.length, 0)
  const summary = `PowerPoint, ${deck.slides.length} slides, ${charts} charts, ${deck.slides.reduce((n, s) => n + s.tables.length, 0)} tables, ${deck.slides.filter((s) => s.notes).length} with notes`
  return { checks, texts, tables: deck.slides.flatMap((s) => s.tables.map((t) => ({ rows: t.rows, where: `slide ${s.n} table` }))), summary }
}

async function reviewXlsx(data: Buffer): Promise<{ checks: ReviewCheck[]; texts: TextItem[]; tables: Array<{ rows: string[][]; where: string }>; summary: string }> {
  const wb = await loadWorkbook(data)
  const checks: ReviewCheck[] = []
  const texts: TextItem[] = []
  const comp = computeWorkbook(wb)
  const sheets = readSheets(wb, { maxCells: 200_000 })
  for (const e of comp.errors.slice(0, 25)) checks.push({ area: 'formatting', status: 'fail', message: `${e.formula} gives ${e.problem}`, where: `${e.sheet}!${e.cell}` })
  if (comp.errors.length > 25) checks.push({ area: 'formatting', status: 'fail', message: `…and ${comp.errors.length - 25} more formula errors` })
  if (comp.unverified.length) {
    const fns = [...new Set(comp.unverified.flatMap((u) => functionsIn(u.formula)))].slice(0, 8)
    checks.push({ area: 'formatting', status: 'warn', message: `${comp.unverified.length} formula(s) couldn't be checked here (${fns.join(', ') || 'unsupported syntax'}); Excel computes them on open`, where: comp.unverified.slice(0, 3).map((u) => `${u.sheet}!${u.cell}`).join(', ') })
  }
  if (comp.formulas && !comp.errors.length) checks.push({ area: 'formatting', status: 'pass', message: `${comp.formulas - comp.unverified.length} of ${comp.formulas} formulas compute without errors` })
  const tables: Array<{ rows: string[][]; where: string }> = []
  for (const s of sheets) {
    if (!s.cells.length) { if (sheets.length > 1) checks.push({ area: 'structure', status: 'fail', message: 'Empty sheet', where: s.name }); continue }
    const at = (a: string) => `${s.name}!${a}`
    for (const c of s.cells) {
      if (c.kind === 'error') checks.push({ area: 'formatting', status: 'fail', message: `Error value ${showValue(c.value)}`, where: at(c.addr) })
      if (c.kind === 'text' && typeof c.value === 'string') {
        if (/^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!)/.test(c.value)) checks.push({ area: 'formatting', status: 'fail', message: `"${c.value}" typed as text`, where: at(c.addr) })
        texts.push({ text: c.value, where: at(c.addr) })
      }
    }
    const grid = sheetGrid(s)
    const rows = grid.length
    const first = grid[0] ?? []
    const headerLike = first.length > 0 && first.filter((v) => v !== null).every((v) => typeof v === 'string')
    if (rows > 5 && !headerLike) checks.push({ area: 'structure', status: 'warn', message: 'First row is not a header row (column names)', where: s.name })
    if (rows > 25 && headerLike && !s.frozen?.rows) checks.push({ area: 'formatting', status: 'warn', message: `${rows} rows and the header row isn't frozen`, where: s.name })
    // Numbers stored as text inside numeric columns.
    const byCol = new Map<number, typeof s.cells>()
    for (const c of s.cells) if (c.row > 1) (byCol.get(c.col) ?? byCol.set(c.col, []).get(c.col)!).push(c)
    for (const [, cs] of byCol) {
      const nums = cs.filter((c) => c.kind === 'number' || (c.kind === 'formula' && typeof c.value === 'number'))
      const textNums = cs.filter((c) => c.kind === 'text' && typeof c.value === 'string' && parseNumber(c.value))
      if (nums.length >= 3 && textNums.length) checks.push({ area: 'formatting', status: 'warn', message: `${textNums.length} number(s) stored as text (they won't add up): ${textNums.slice(0, 3).map((c) => c.addr).join(', ')}`, where: s.name })
    }
    // Totals that don't cover their column's data.
    for (const c of s.cells) {
      if (!c.formula) continue
      const m = /^=\s*(?:SUM|SUBTOTAL\(\s*\d+\s*,)\s*\(?\s*\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)\s*\)\s*$/i.exec(c.formula)
      if (!m || m[1] !== m[3]) continue
      const col = m[1].toUpperCase()
      const r1 = Number(m[2]), r2 = Number(m[4])
      if (r2 < c.row - 1 && col === c.addr.replace(/\d+/g, '')) {
        const between = s.cells.filter((x) => x.addr.replace(/\d+/g, '') === col && x.row > r2 && x.row < c.row && typeof x.value === 'number')
        if (between.length) checks.push({ area: 'numbers', status: 'fail', message: `Total ${c.formula} skips ${between.length} row(s) of data (${col}${r2 + 1}:${col}${c.row - 1})`, where: at(c.addr) })
      }
      if (col === c.addr.replace(/\d+/g, '') && r1 > 2 && r1 <= c.row) {
        const before = s.cells.filter((x) => x.addr.replace(/\d+/g, '') === col && x.row > 1 && x.row < r1 && typeof x.value === 'number' && !x.formula)
        if (before.length) checks.push({ area: 'numbers', status: 'fail', message: `Total ${c.formula} starts below the first data row (misses ${col}${before[0].row})`, where: at(c.addr) })
      }
    }
    tables.push({ rows: grid.map((r) => r.map((v, k) => (typeof v === 'number' && isDateFmt(s.cells.find((c) => c.col === k + 1)?.format) ? showValue(v, 'yyyy-mm-dd') : v === null ? '' : showValue(v)))), where: s.name })
  }
  const summary = `Excel, ${sheets.length} sheet(s): ${sheets.map((s) => `${s.name} (${s.rows} rows)`).join(', ')}, ${comp.formulas} formulas`
  return { checks, texts, tables, summary }
}

async function reviewPdf(data: Buffer, tmpPath?: string): Promise<{ checks: ReviewCheck[]; texts: TextItem[]; tables: Array<{ rows: string[][]; where: string }>; summary: string }> {
  const checks: ReviewCheck[] = []
  const { text, pages } = await pdfTextFrom(data, tmpPath)
  const perPage = text.split(/--- Page (\d+) ---/).slice(1)
  const texts: TextItem[] = []
  let emptyPages = 0
  for (let k = 0; k < perPage.length; k += 2) {
    const n = perPage[k], body = perPage[k + 1] ?? ''
    if (!body.trim()) { emptyPages++; continue }
    for (const para of body.split(/\n\s*\n|\n(?=[A-Z•\-\d])/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)) texts.push({ text: para, where: `page ${n}` })
  }
  if (pages && emptyPages === pages) checks.push({ area: 'content', status: 'fail', message: `No text on any of the ${pages} pages (scanned images? check it visually)` })
  else if (emptyPages) checks.push({ area: 'structure', status: 'warn', message: `${emptyPages} blank page(s)` })
  try {
    const fields = await pdfFields(data)
    const emptyReq = fields.filter((f) => f.required && (f.value === null || f.value === '' || f.value === false))
    if (emptyReq.length) checks.push({ area: 'content', status: 'fail', message: `Required form fields still empty: ${emptyReq.map((f) => f.name).slice(0, 8).join(', ')}` })
    else if (fields.length) {
      const empty = fields.filter((f) => f.type === 'text' && !f.value)
      checks.push({ area: 'content', status: empty.length ? 'warn' : 'pass', message: empty.length ? `${empty.length} of ${fields.length} form fields are empty: ${empty.slice(0, 6).map((f) => f.name).join(', ')}` : `All ${fields.length} form fields filled` })
    }
  } catch { /* not a form */ }
  return { checks, texts, tables: [], summary: `PDF, ${pages} page(s), ${texts.reduce((n, t) => n + (t.text.match(/\S+/g) ?? []).length, 0).toLocaleString('en-US')} words` }
}

async function pdfTextFrom(data: Buffer, path?: string): Promise<{ text: string; pages: number }> {
  if (path) return pdfText(path)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise
  const out: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent()
    out.push(`--- Page ${i} ---\n${(c.items as Array<{ str?: string; hasEOL?: boolean }>).map((x) => (x.str ?? '') + (x.hasEOL ? '\n' : '')).join('')}`)
  }
  await doc.cleanup()
  return { text: out.join('\n\n'), pages: doc.numPages }
}

// ------------------------------------------------------------------ entry

export async function reviewDocument(input: string | { data: Buffer; name: string }, o: ReviewOptions = {}): Promise<Review> {
  const name = typeof input === 'string' ? input : input.name
  const data = typeof input === 'string' ? readFileSync(input) : input.data
  const ext = extname(name).toLowerCase()
  let r: { checks: ReviewCheck[]; texts: TextItem[]; tables: Array<{ rows: string[][]; where: string }>; summary: string }
  switch (ext) {
    case '.docx': {
      r = reviewDocx(await inspectDocx(data))
      if (o.requireToc && !r.checks.some((c) => /table of contents/i.test(c.message) && c.status !== 'fail')) r.checks.push({ area: 'structure', status: 'fail', message: 'No table of contents (asked for one)' })
      break
    }
    case '.pptx': r = reviewPptx(await inspectPptx(data)); break
    case '.xlsx': case '.xlsm': r = await reviewXlsx(data); break
    case '.pdf': r = await reviewPdf(data, typeof input === 'string' ? input : undefined); break
    default: throw new Error(`review_document checks .docx, .xlsx, .pptx and .pdf files, not ${ext || 'this file'}.`)
  }
  const checks = [...r.checks]
  const ph = placeholderChecks(r.texts)
  checks.push(...(ph.length ? ph.slice(0, 15) : [{ area: 'content' as const, status: 'pass' as const, message: 'No placeholders (TBD, Lorem, [insert…])' }]))
  if (ext !== '.xlsx' && ext !== '.xlsm') {
    const dup = duplicateChecks(r.texts)
    checks.push(...(dup.length ? dup.slice(0, 10) : [{ area: 'content' as const, status: 'pass' as const, message: 'No duplicated paragraphs' }]))
  }
  const sp = spellingChecks(r.texts)
  checks.push(...(sp.length ? sp.slice(0, 20) : [{ area: 'spelling' as const, status: 'pass' as const, message: 'No common typos' }]))
  if (o.source) checks.push(...numberChecks(r.tables, r.texts.filter((t) => !/table/.test(t.where)), await loadSource(o.source)))
  const pass = !checks.some((c) => c.status === 'fail')
  return { file: basename(name), kind: ext.slice(1), pass, checks, summary: r.summary }
}

export function formatReview(r: Review): string {
  const fails = r.checks.filter((c) => c.status === 'fail'), warns = r.checks.filter((c) => c.status === 'warn'), passes = r.checks.filter((c) => c.status === 'pass')
  const line = (c: ReviewCheck) => `${c.status.toUpperCase()} [${c.area}] ${c.message}${c.where ? ` @ ${c.where}` : ''}`
  return [
    `Review of ${r.file} (${r.summary}): ${r.pass ? 'PASS' : 'FAIL'} — ${fails.length} to fix, ${warns.length} warning${warns.length === 1 ? '' : 's'}`,
    ...fails.map(line),
    ...warns.map(line),
    passes.length ? `Passed: ${passes.map((c) => c.message).join('; ')}` : '',
    fails.length ? 'Fix every FAIL (rebuild or edit the file), then run review_document again (at most 2 rounds). Fix warnings when they are real problems.' : warns.length ? 'No failures. Fix warnings that are real problems, then present the file.' : 'Ready to present.'
  ].filter(Boolean).join('\n')
}
