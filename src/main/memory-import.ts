import type { ImportSection } from '@shared/memory-import'
import { redactSecrets } from './knowledge/ignore'
import { classifyMemory, headingKind, normalizeText, similar, type MemoryKind } from './memory'

// "Import memory to SahilBot": turns what another assistant exported about the user into memory items.
// The prompt (src/shared/memory-import.ts) asks for sections (Instructions, Identity, Career, Projects,
// Preferences, Other notes) and one `[YYYY-MM-DD] - entry` line per item inside one code block, but real
// replies vary a lot, so this reads all of these:
// - with or without a code fence (several fences, an unclosed one, prose around them);
// - headings as "## 1. Instructions", "**Instructions**", "Instructions:", "INSTRUCTIONS", "1) Identity";
// - bullets (-, *, •, 1.), sub-bullets under a project, Markdown tables, JSON;
// - dates as [2025-03-01], 2025-03-01 -, (2025-03), [unknown], [March 3, 2025], a trailing (2025-03-01), or none.
// The paste is the user's own, so it's trusted as user-provided, but it is still capped in size, secrets
// are never kept (keys and tokens are redacted, lines holding a password or account number are dropped),
// and anything that tries to hand the assistant permissions ("run commands without asking", "you are
// authorized to spend…", "ignore your safety rules") is left out and listed so the user sees why.

export const IMPORT_MAX_CHARS = 200_000
export const IMPORT_MAX_ITEMS = 500

export interface ImportEntry {
  content: string
  category: MemoryKind
  section: ImportSection
  /** The date the other assistant gave (YYYY-MM-DD), or null when it didn't know. */
  date: string | null
  /** From the Instructions section: saved as a rule every chat follows (Settings → Rules). */
  asRule: boolean
}

export interface ExportPreview {
  items: ImportEntry[]
  /** Entries already in memory or rules (or repeated in the paste). */
  duplicates: number
  /** Lines that weren't entries: headings, filler, empty sections. */
  skipped: number
  /** Entries left out for safety, with secrets already redacted from the text shown. */
  dropped: Array<{ text: string; why: string }>
  /** What the other assistant said about the export: complete, not complete, or nothing either way. */
  complete: boolean | null
  /** It used recognizable section headings. */
  structured: boolean
  /** The paste was longer than the cap (the rest was ignored). */
  truncated: boolean
}

// ---------------------------------------------------------------- sections

const SECTION_RX: Array<[RegExp, ImportSection]> = [
  [/^(explicit |standing |custom |user |my |assistant )?(instructions?|rules?|directives|guidelines|commands)\b|^how (to|you should) (respond|reply|behave|work with me)|^(response|answer) (rules|instructions)/i, 'instructions'],
  [/^(identity|about (me|the user|you)|personal( info(rmation)?| details| context| background| life)?|basics|profile|bio(graphy)?|who (i am|you are|the user is)|background|family|demographics|personal identity)\b/i, 'identity'],
  [/^(career|work( history| life| context)?|professional( background| context| life| details)?|jobs?|employment|occupation|education|skills|career (and|&) education|education (and|&) career|work (and|&) career)\b/i, 'career'],
  [/^((current|active|ongoing|past|personal|side|key) )?(projects?|work in progress|ventures|initiatives)\b/i, 'projects'],
  [/^(preferences?|likes( and dislikes)?|dislikes|style|communication (style|preferences)|tastes|interests( and preferences)?|tools?( and preferences)?|habits)\b/i, 'preferences'],
  [/^(other( notes| info(rmation)?| details| context| facts)?|misc(ellaneous)?|additional( notes| context| info(rmation)?)?|notes|everything else|general|facts|memories|saved memories|context)\b/i, 'other']
]

const SECTION_KIND: Record<ImportSection, MemoryKind> = {
  instructions: 'rule', identity: 'profile', career: 'work', projects: 'project', preferences: 'preference', other: 'fact'
}

/** "## 1. Instructions (explicit rules)" → "Instructions". */
function bareHeading(s: string): string {
  return s
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[*_]{1,3}|[*_]{1,3}$/g, '')
    .replace(/^[*_]{1,3}|[*_]{1,3}$/g, '')
    .replace(/^(\d{1,2}|[ivx]{1,4}|[a-f])[.):]\s+/i, '')
    .replace(/^(section|part)\s+\d+\s*[:.-]\s*/i, '')
    .replace(/[*_]{2}/g, '')
    .replace(/\s*[:：]\s*$/, '')
    .replace(/\s*\([^)]{0,60}\)\s*$/, '')
    .replace(/^=+\s*|\s*=+$/g, '')
    .trim()
}

export function sectionOf(heading: string): ImportSection | undefined {
  const h = bareHeading(heading)
  if (!h || h.length > 60) return undefined
  return SECTION_RX.find(([rx]) => rx.test(h))?.[1]
}

/** The line is a heading (and its text), or null. */
function headingOf(raw: string): string | null {
  const s = raw.trim()
  if (/^#{1,6}\s+\S/.test(s)) return bareHeading(s)
  // **Instructions** / __Identity__ / **1. Career:** (nothing after it)
  if (/^(\*\*|__)[^*_]{2,70}(\*\*|__):?$/.test(s)) return bareHeading(s)
  // === Instructions ===
  if (/^={2,}\s*[^=]{2,60}\s*={2,}$/.test(s)) return bareHeading(s)
  // "1. Instructions" / "Instructions:" / "INSTRUCTIONS" (short, and naming a known section)
  const bare = bareHeading(s)
  if (bare.length <= 60 && !/[.!?]$/.test(bare) && !/https?:/i.test(s) && !/^\s*[-*+•]/.test(raw) && !/[:：]\s*\S/.test(s)) {
    const titleCase = bare.split(/\s+/).length <= 3 && bare.split(/\s+/).every((w) => /^[A-Z&]/.test(w) || /^(and|of|the|to|for|&)$/.test(w))
    if (sectionOf(s) && (/:$/.test(s) || /^\d{1,2}[.)]\s/.test(s) || /^[A-Z][A-Z &/-]{3,}$/.test(s) || titleCase)) return bare
    if (/^[^.!?]{2,40}:$/.test(s)) return bare
  }
  return null
}

// ---------------------------------------------------------------- dates

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec'
const UNKNOWN = /^(unknown|unknown date|date unknown|undated|no date|n\/?a|none|\?+|tbd|-)$/i
const pad2 = (n: number): string => String(n).padStart(2, '0')

/** A date the other assistant wrote → YYYY-MM-DD (month or year precision gets the 1st), or null. */
export function parseDate(s: string): string | null {
  const t = s.trim().replace(/^date:\s*/i, '').replace(/^(saved|added|noted|updated|learned)( on)?\s+/i, '')
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m) return valid(+m[1], +m[2], +m[3])
  m = t.match(/^(\d{4})[-/.](\d{1,2})$/)
  if (m) return valid(+m[1], +m[2], 1)
  m = t.match(/^(\d{4})$/)
  if (m) return valid(+m[1], 1, 1)
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return valid(+m[3], +m[1], +m[2])
  if (new RegExp(`^(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(st|nd|rd|th)?,?\\s+\\d{4}$|^\\d{1,2}\\s+(${MONTHS})[a-z]*\\.?,?\\s+\\d{4}$|^(${MONTHS})[a-z]*\\.?\\s+\\d{4}$`, 'i').test(t)) {
    const d = new Date(t.replace(/(\d)(st|nd|rd|th)/, '$1'))
    if (!Number.isNaN(d.getTime())) return valid(d.getFullYear(), d.getMonth() + 1, /^(\w+)\.?\s+\d{4}$/.test(t) ? 1 : d.getDate())
  }
  return null
}

function valid(y: number, mo: number, d: number): string | null {
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${pad2(mo)}-${pad2(d)}`
}

/** Pulls a leading or trailing date off an entry. `date` undefined = it had none; null = "[unknown]". */
function takeDate(s: string): { text: string; date?: string | null } {
  let t = s.trim()
  // Leading: [2025-03-01] - x, **[2025-03-01]** x, (2025-03) x, 2025-03-01 - x, 2025-03-01: x, [unknown] - x
  const lead = t.match(/^(\*\*|__)?\s*[[(]\s*([^\])]{1,30}?)\s*[\])]\s*(\*\*|__)?\s*(?:[-–—:|·•]+\s*)?(.*)$/)
  if (lead) {
    const inner = lead[2]
    const d = parseDate(inner)
    if (d) return { text: lead[4], date: d }
    if (UNKNOWN.test(inner)) return { text: lead[4], date: null }
  }
  const bare = t.match(/^(\d{4}-\d{1,2}(?:-\d{1,2})?)\s*(?:[-–—:|·]+)\s*(.+)$/)
  if (bare) {
    const d = parseDate(bare[1])
    if (d) return { text: bare[2], date: d }
  }
  const unk = t.match(/^(unknown( date)?|undated|date unknown)\s*[-–—:|]\s*(.+)$/i)
  if (unk) return { text: unk[3], date: null }
  // Trailing: x (2025-03-01) / x [2025-03] / x — 2025-03-01 / x (saved March 3, 2025)
  const tail = t.match(/^(.*?)\s*(?:[-–—|·]\s*)?[[(]\s*([^\])]{4,30})\s*[\])]\s*\.?$/)
  if (tail) {
    const d = parseDate(tail[2])
    if (d) return { text: tail[1], date: d }
    if (UNKNOWN.test(tail[2])) return { text: tail[1], date: null }
  }
  const tail2 = t.match(/^(.*?)\s+[-–—|]\s+(\d{4}-\d{1,2}(?:-\d{1,2})?)\.?$/)
  if (tail2) {
    const d = parseDate(tail2[2])
    if (d) return { text: tail2[1], date: d }
  }
  t = t.trim()
  return { text: t }
}

// ---------------------------------------------------------------- filler, completeness

const FILLER = [
  /^(here('|’)?s|here is|here are|below (is|are)|these are|this is|sure[,!]?|okay[,!]?|ok[,!]|of course|absolutely|certainly|great question)\b.{0,120}\b(remember|memor|know|saved|stored|export|learned|about you|information)/i,
  /^(saved memories|memories|memory|my memories|updated saved memory|memory updated|manage memories|personalization|export|memory export|user (profile|memory) export|full export|everything i know about you)[:.]?$/i,
  /^(let me know|i don'?t have|i do not have|i can'?t|i cannot|feel free|hope this helps|is there anything|if you('d)? (like|want)|would you like|note:? i (only|don'?t)|as an ai|i('ve| have) (organized|grouped|formatted|listed|included))/i,
  /^[-=_*~#\s|:]{3,}$/,
  /^(none|n\/?a|nothing( (stored|saved|recorded|yet|here))?|no (entries|items|instructions|projects|preferences|notes|information)( (stored|saved|recorded|available|found))?|\(?none (recorded|saved|stored)\)?|\(empty\)|—|-|\.{3}|…)\.?$/i,
  /^(entry|entries|date|category|section)$/i
]

const COMPLETE_NO = /\b(not (fully |entirely |quite )?complete|incomplete|partial(ly)?( export)?|truncated|there (is|may be|might be|could be) more|couldn'?t include|could not include|wasn'?t able to include|not everything|only (a|some) (part|portion|subset|sample)|more (that )?i (couldn'?t|could not|can'?t)|cut off|ran out of (room|space))\b/i
const COMPLETE_YES = /\b((this|the|my) (export|list|summary) (is|should be|appears|looks|seems) (to be )?(complete|comprehensive|everything|exhaustive)|(this|it|that) (is|looks|seems) complete|complete\?\s*yes|(represents|includes|contains|covers) (all|everything)( (of )?the (information|memories|details))?( (i have|i'?ve) (saved|stored|got))?|all (the )?(information|memories|details) i (have|'?ve) (saved|stored)|export (is )?complete|that'?s everything|this is everything|this (covers|includes) everything|complete export|nothing (else|more)( is)? (stored|saved|to add|recorded)|includes everything|that'?s all (i have|i know|of it|that'?s stored))\b/i

/** What the reply says about completeness: true, false, or null when it doesn't say. */
export function completeness(lines: string[]): boolean | null {
  for (const l of lines) if (COMPLETE_NO.test(l)) return false
  for (const l of lines) if (COMPLETE_YES.test(l)) return true
  return null
}

const isMeta = (s: string): boolean => FILLER.some((rx) => rx.test(s)) || ((COMPLETE_NO.test(s) || COMPLETE_YES.test(s)) && /\b(export|list|everything|all|include|complete)\b/i.test(s) && s.length < 260)

// ---------------------------------------------------------------- safety

/** Words that mean a secret is right there (a value, or the user's own credential). */
const SECRET_VALUE = /\b(password|passcode|passphrase|pin|api[ _-]?key|secret key|token|secret|ssn|social security( number)?|card number|cvv|cvc|routing number|account number|iban|license key|seed phrase|recovery phrase|private key)\b\s*(?:[:=]|\bis\b|\bwas\b)\s*\S{3,}/i
const SECRET_LATER = /\b(password|passcode|passphrase|pin|api[ _-]?key|token|secret)\b[^.!?\n]{0,40}?\b(is|was)\s*[:=]?\s*["'`]?[^\s"'`]{4,}/i
const OWN_SECRET = /\b(my|your|their|his|her|the user'?s|user'?s)\s+(\w+\s+)?(password|passcode|passphrase|pin( number| code)?|api[ _-]?keys?|access tokens?|tokens?|secret keys?|ssn|social security number|credit card( number)?|card number|cvv|bank account( number)?|routing number|account number|seed phrase|recovery phrase|private key)\b/i
const CARDISH = /\b(?:\d[ -]?){13,19}\b|\b\d{3}-\d{2}-\d{4}\b/
/** Long random-looking runs: keys and tokens without a known prefix. */
const KEYISH = /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/

/** Trying to hand the assistant permissions or switch its safeguards off. */
const GRANTS: RegExp[] = [
  /\b(without|no need (to|for)|don'?t|do not|never|stop|skip)\s+(ask(ing)?|confirm(ing|ation)?|check(ing)?( in)?( with me)?|getting (my )?(approval|permission|ok)|approval|permission|prompt(ing)?)\b.{0,60}\b(run|running|execut\w*|command\w*|terminal|shell|sudo|delet\w*|remov\w*|send\w*|email\w*|buy\w*|purchas\w*|pay\w*|spend\w*|transfer\w*|install\w*|push\w*|post\w*|publish\w*|book\w*|submit\w*|wire\w*|money|card|bank|files?|anything|actions?)\b/i,
  /\b(run|execut\w*|delet\w*|send\w*|buy\w*|purchas\w*|pay\w*|spend\w*|transfer\w*|install\w*|push\w*|publish\w*|submit\w*)\b.{0,60}\b(without (asking|confirmation|confirming|approval|permission|checking)|no questions asked)\b/i,
  /\b(you (have|are given|are granted|get)|i (give|grant) you|i authori[sz]e you|you('re| are) (allowed|authori[sz]ed|permitted|cleared)|you may always|you can always|consider yourself (authori[sz]ed|allowed))\b.{0,80}\b(access|permission|control|run|execute|send|spend|buy|purchase|delete|use my|log ?in|sign ?in|transfer|pay)\b/i,
  /\b(bypass|disable|turn off|switch off|skip|ignore|override|remove|lift)\b.{0,30}\b(approvals?|confirmations?|safety|safeguards?|security|permissions?|sandbox|guard ?rails?|limits?|budget|spending cap|restrictions?|filters?|hard stops?)\b/i,
  /\b(auto[- ]?(approve|confirm|accept|run)|full access|bypass mode|root access|admin(istrator)? access|god mode|developer mode|jailbreak|dan mode)\b/i,
  /\b(ignore|disregard|forget|override)\b.{0,25}\b(previous|prior|above|earlier|all|your|system|other|any)\b.{0,25}\b(instructions?|rules?|prompts?|guidelines?|directives)\b/i,
  /\b(use|with|here'?s|here is)\s+(my|this|the)\s+(api[ _-]?key|token|password|credentials?|login)\b/i
]

/** Why this entry must not be kept, or null. `text` is already redacted. */
function unsafe(original: string, redacted: string): string | null {
  if (redacted !== original || KEYISH.test(original)) return 'It held a key or token (never stored).'
  if (SECRET_VALUE.test(original) || SECRET_LATER.test(original) || CARDISH.test(original)) return 'It held a password, key or account number (never stored).'
  if (OWN_SECRET.test(original)) return 'It is about a password, key or account number (never stored).'
  if (GRANTS.some((rx) => rx.test(original))) return 'It tries to give the assistant permissions or switch off a safeguard.'
  return null
}

/** For showing a left-out line: values after "is" / ":" / "=", long digit runs and key-shaped words go. */
function maskSecrets(text: string): string {
  return text
    .replace(new RegExp(KEYISH.source, 'g'), '[redacted]')
    .replace(/((?:\bis|\bwas|[:=])\s*["'`]?)(?!\[redacted\])[^\s"'`]{3,}/gi, '$1[redacted]')
    .replace(/(?:\d[ -]?){6,}/g, '[redacted]')
}

/** Also used when saving: true when text holds or names a secret (keys, passwords, account numbers). */
export function importSecret(text: string): boolean {
  return redactSecrets(text) !== text || KEYISH.test(text) || SECRET_VALUE.test(text) || SECRET_LATER.test(text) || CARDISH.test(text) || OWN_SECRET.test(text)
}

export function grantsPermissions(text: string): boolean {
  return GRANTS.some((rx) => rx.test(text))
}

// ---------------------------------------------------------------- lines

const BULLET = /^(\s*)(?:[-*+•·▪◦‣–—>]|\d{1,3}[.)]|\[[ xX]?\]|\([a-z0-9]\))\s+/

function cleanText(s: string): string {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/^["“”']+|["“”']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "The user prefers…" reads better as "Prefers…". */
function tidy(s: string): string {
  let t = s.replace(/^(entry|item|memory|note|fact)\s*:\s*/i, '')
  t = t.replace(/^(the )?user('s)?\s+(?=[a-z])/i, (_m, _a, poss) => (poss ? 'Their ' : ''))
  t = t.replace(/^\p{Ll}/u, (c) => c.toUpperCase())
  return /[.!?…)"”]$/.test(t) ? t : `${t}.`
}

interface Raw { text: string; section: ImportSection; hint?: MemoryKind; date: string | null; indent: number; bullet: boolean }

function tableCells(line: string): string[] | null {
  const s = line.trim()
  if (!/^\|.*\|$/.test(s)) return null
  return s.slice(1, -1).split('|').map((c) => c.trim())
}

/** JSON exports: an array of strings or objects, or an object keyed by section. */
function fromJson(text: string): Raw[] | null {
  const t = text.trim().replace(/^```(?:json)?\s*\n?|\n?```\s*$/gi, '').trim()
  if (!/^[[{]/.test(t)) return null
  let v: unknown
  try { v = JSON.parse(t) } catch { return null }
  const out: Raw[] = []
  const add = (x: unknown, section: ImportSection): void => {
    if (typeof x === 'string') { out.push({ text: x, section, date: null, indent: 0, bullet: true }); return }
    if (!x || typeof x !== 'object') return
    const r = x as Record<string, unknown>
    const body = r.content ?? r.memory ?? r.text ?? r.value ?? r.entry ?? r.fact ?? r.description
    if (typeof body !== 'string') return
    const sec = typeof (r.section ?? r.category ?? r.type) === 'string' ? sectionOf(String(r.section ?? r.category ?? r.type)) : undefined
    const d = typeof (r.date ?? r.created_at ?? r.createdAt ?? r.updated_at) === 'string' ? parseDate(String(r.date ?? r.created_at ?? r.createdAt ?? r.updated_at).slice(0, 10)) : null
    out.push({ text: body, section: sec ?? section, date: d, indent: 0, bullet: true })
  }
  if (Array.isArray(v)) { for (const x of v) add(x, 'other'); return out }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const list = o.memories ?? o.items ?? o.entries
    if (Array.isArray(list)) { for (const x of list) add(x, 'other'); return out }
    let any = false
    for (const [k, val] of Object.entries(o)) {
      const sec = sectionOf(k)
      if (!sec) continue
      any = true
      if (Array.isArray(val)) for (const x of val) add(x, sec)
      else add(val, sec)
    }
    return any ? out : null
  }
  return null
}

/** The paste → raw entries with their section, date and indentation. */
function readLines(text: string): { raws: Raw[]; skipped: number; outside: string[]; structured: boolean } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const fenced = lines.some((l) => /^\s*(```|~~~)/.test(l))
  const raws: Raw[] = []
  const outside: string[] = []
  let skipped = 0
  let inFence = false
  let section: ImportSection = 'other'
  let hint: MemoryKind | undefined
  let structured = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    const s = line.trim()
    if (!s) continue
    if (!inFence) outside.push(s)
    const h = headingOf(line)
    if (h !== null) {
      const sec = sectionOf(h)
      if (sec) { section = sec; hint = undefined; structured = true } else { section = 'other'; hint = headingKind(h) }
      skipped++
      continue
    }
    const cells = tableCells(line)
    if (cells) {
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || !c) || cells.every((c) => /^(date|entry|entries|item|category|section|memory|details?|notes?|when|what)?$/i.test(c))) { skipped++; continue }
      let date: string | null = null
      let sec: ImportSection | undefined
      const rest: string[] = []
      for (const c of cells) {
        const bare = c.replace(/^\[|\]$/g, '')
        const d = parseDate(bare)
        if (d && !date) { date = d; continue }
        if (UNKNOWN.test(bare)) continue
        const cs = c.length <= 30 ? sectionOf(c) : undefined
        if (cs && !sec) { sec = cs; continue }
        if (c) rest.push(c)
      }
      const body = rest.sort((a, b) => b.length - a.length)[0]
      if (body) raws.push({ text: body, section: sec ?? section, hint, date, indent: 0, bullet: true })
      else skipped++
      continue
    }
    const bm = line.match(BULLET)
    const bullet = !!bm
    const indent = (bm ? bm[1] : line.match(/^\s*/)![0]).replace(/\t/g, '    ').length
    let body = bm ? line.slice(bm[0].length) : s
    // A second bullet marker ("- 1. foo", "* - foo").
    body = body.replace(/^(?:[-*+•]|\d{1,3}[.)])\s+/, '')
    // Prose around fenced output (the intro, the "is it complete" line) isn't an entry.
    if (fenced && !inFence && !bullet && !/^\s*[[(]?\d{4}-\d{1,2}/.test(body) && !/^\s*\[(unknown|undated)/i.test(body)) { skipped++; continue }
    if (isMeta(cleanText(body))) { skipped++; continue }
    // "**Work:** Physician at Emory" / "Preferences: likes tea": a section label inline, for this line.
    const inline = body.match(/^(?:\*\*|__)?([A-Za-z][A-Za-z &/-]{2,30}?)(?::\*\*|\*\*:|:)\s+(.+)$/)
    let lineSection = section
    if (inline) {
      const sec = sectionOf(inline[1])
      if (sec) { lineSection = sec; body = inline[2] }
    }
    const { text: t, date } = takeDate(body)
    raws.push({ text: t, section: lineSection, hint, date: date ?? null, indent, bullet })
  }
  return { raws, skipped, outside: fenced ? outside : outside.filter((l) => /\b(export|list|everything|memor\w*|includ\w*|complete|all)\b/i.test(l)), structured }
}

const PROJECT_DETAIL = /^(status|current status|stage|phase|key decisions?|decisions?( made)?|what( it is)?|description|goal|goals|next steps?|stack|tech( stack)?|notes?|timeline|role|outcome|started|due)\s*[:：-]/i

/** Sub-bullets and "Status: …" lines under a project (or under a line ending with ":") join their parent. */
function mergeContinuations(raws: Raw[]): Raw[] {
  const out: Raw[] = []
  for (const r of raws) {
    const prev = out.at(-1)
    const child = prev && r.section === prev.section && (
      (r.indent > prev.indent && (prev.section === 'projects' || /:$/.test(prev.text.trim()))) ||
      (prev.section === 'projects' && PROJECT_DETAIL.test(r.text.trim()) && !r.date)
    )
    if (child && prev) {
      const p = prev.text.trim().replace(/[.;]$/, '')
      prev.text = /:$/.test(p) ? `${p} ${r.text.trim()}` : `${p}; ${r.text.trim()}`
      if (!prev.date && r.date) prev.date = r.date
      continue
    }
    out.push({ ...r })
  }
  return out
}

/** Long prose paragraphs (Claude-style summaries) become one entry per sentence. */
function splitProse(r: Raw): Raw[] {
  const t = cleanText(r.text)
  if (r.bullet || t.length <= 120 || r.section === 'projects' || !/[.!?]\s+[A-Z“"(]/.test(t)) return [{ ...r, text: t }]
  return t.split(/(?<=[.!?])\s+(?=[A-Z“"(])/).map((p) => ({ ...r, text: p }))
}

function kindFor(text: string, section: ImportSection, hint?: MemoryKind): MemoryKind {
  if (section === 'instructions') return 'rule'
  if (section === 'projects') return 'project'
  if (section === 'preferences') return 'preference'
  if (section === 'career') {
    const k = classifyMemory(text, 'work')
    return k === 'project' || k === 'link' || k === 'date' ? k : 'work'
  }
  if (section === 'identity') {
    const k = classifyMemory(text, 'profile')
    return (['profile', 'person', 'location', 'date', 'trip', 'link'] as MemoryKind[]).includes(k) ? k : 'profile'
  }
  const k = classifyMemory(text, hint ?? SECTION_KIND[section])
  return k === 'worklog' ? 'fact' : k
}

/**
 * Parses an export. `existing`: memory texts already saved; `existingRules`: rule texts already saved
 * (both for dedupe). Nothing is saved here.
 */
export function parseExport(input: string, o: { existing?: string[]; existingRules?: string[] } = {}): ExportPreview {
  const truncated = input.length > IMPORT_MAX_CHARS
  const text = truncated ? input.slice(0, IMPORT_MAX_CHARS) : input
  const json = fromJson(text)
  const read = json ? { raws: json, skipped: 0, outside: [] as string[], structured: json.some((r) => r.section !== 'other') } : readLines(text)
  const complete = completeness(read.outside)

  const existing = o.existing ?? []
  const rules = o.existingRules ?? []
  const seen = new Set<string>([...existing, ...rules].map(normalizeText))
  const items: ImportEntry[] = []
  const dropped: ExportPreview['dropped'] = []
  let duplicates = 0
  let skipped = read.skipped

  for (const r of mergeContinuations(read.raws).flatMap(splitProse)) {
    const original = cleanText(r.text)
    if (!original) continue
    if (original.length < 3 || !/\p{L}/u.test(original) || isMeta(original)) { skipped++; continue }
    const redacted = redactSecrets(original)
    const why = unsafe(original, redacted)
    if (why) { dropped.push({ text: maskSecrets(redacted).slice(0, 200), why }); continue }
    let s = original
    const cap = r.section === 'projects' ? 700 : 500
    if (s.length > cap) s = s.slice(0, cap - 3).replace(/\s+\S*$/, '') + '…'
    s = tidy(s)
    const key = normalizeText(s)
    if (!key) { skipped++; continue }
    const pool = r.section === 'instructions' ? [...rules, ...existing] : existing
    if (seen.has(key) || pool.some((e) => similar(e, s)) || items.some((i) => similar(i.content, s))) { duplicates++; continue }
    seen.add(key)
    if (items.length >= IMPORT_MAX_ITEMS) { skipped++; continue }
    items.push({ content: s, category: kindFor(s, r.section, r.hint), section: r.section, date: r.date, asRule: r.section === 'instructions' })
  }
  return { items, duplicates, skipped, dropped, complete, structured: read.structured, truncated }
}

/** An import item's date → a timestamp (noon UTC that day), or undefined for unknown or future dates. */
export function importTime(date: string | null | undefined, now = Date.now()): number | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const t = Date.parse(`${date}T12:00:00Z`)
  return Number.isFinite(t) && t <= now ? t : undefined
}

/** A short rule name from its text: "Always reply in bullet points" → "imported-always-reply-in-bullet". */
export function ruleName(text: string, taken: (name: string) => boolean): string {
  const base = `imported-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 5).join('-') || 'rule'}`.slice(0, 48).replace(/-+$/, '')
  if (!taken(base)) return base
  for (let i = 2; i < 1000; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${Date.now()}`
}
