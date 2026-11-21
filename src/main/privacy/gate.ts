import { createHash } from 'node:crypto'
import { PRIVACY_LABEL_TEXT, STRICT_LABELS, type PrivacyAction, type PrivacyAnswer, type PrivacyDocumentKind, type PrivacyGateItem, type PrivacyLabel, type PrivacySpan } from '@shared/privacy'
import type { WireMessage } from '../llm/client'
import { classifyDocument } from './documents'
import { scanPhi, type PhiType } from '../agent/tools/phi'

// The Privacy Gate's bookkeeping for one chat (pure; the loop and PII-Tracer supply the I/O).
//
// Before a cloud model gets a request, every part of the conversation it hasn't been checked yet goes
// through PII-Tracer on this Mac. New personal details pause the chat on a card; the user's choice is
// remembered per value, so each detail is asked about once per chat:
//   share   sent as is (never for passwords, keys, card, account or ID numbers unless the user says
//           they aren't personal);
//   masked  the cloud model sees a stand-in like [PERSON_1]; its replies and tool calls get the real
//           value back on this Mac (mask and restore), so it can plan with the details it never sees;
//   skipped the whole message or tool result is withheld from cloud models.
// "Process on my Mac" also moves the current task to a local model (the loop does that).

export interface PrivacyRecord {
  value: string
  label: PrivacyLabel
  /** [PERSON_1]: what cloud models see instead, unless shared. */
  placeholder: string
  share: boolean
}

export interface PrivacyThreadState {
  items: PrivacyRecord[]
  /** Fingerprints of conversation parts already checked. */
  scanned: string[]
  /** Fingerprints of parts withheld from cloud models ("Skip content"). */
  skipped: string[]
  /** "Don't ask again for this chat": the action for later finds. */
  remember?: PrivacyAction
  counters: Partial<Record<PrivacyLabel, number>>
}

export const emptyPrivacy = (): PrivacyThreadState => ({ items: [], scanned: [], skipped: [], counters: {} })

const fp = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32)
const keyOf = (value: string): string => value.trim().toLowerCase()
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const WITHHELD = '[Withheld by the Privacy Gate: this part of the conversation stays on the user\'s Mac. Ask the user if you need it.]'

/** A part of the conversation to check: one message's text. */
export interface Segment { key: string; text: string; source: string; index: number }

/**
 * Tool outputs the gate leaves alone: the vault never shows a saved value to any model (src/main/secure/redact.ts),
 * so cloud models keep using saved logins and cards through it; only item names and fill results come back.
 */
const UNCHECKED_TOOLS = new Set(['vault'])

function textOf(m: WireMessage): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) return m.content.map((p) => (p && typeof p === 'object' && 'text' in p && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n')
  return ''
}

function sourceOf(m: WireMessage): string {
  if (m.role === 'tool') return `${m.name || 'tool'} output`
  if (m.role === 'assistant') return 'An earlier reply'
  // SahilBot's own notes in the conversation (plan reminders, recalled memory, context).
  if (typeof m.content === 'string' && /^\[[A-Z][^\]]{2,60}\]/.test(m.content)) return 'Saved context'
  return 'Your message'
}

/** The conversation's parts (the system prompt is SahilBot's own and stays as it is). */
export function segmentsOf(wire: WireMessage[]): Segment[] {
  const out: Segment[] = []
  wire.forEach((m, index) => {
    if (m.role === 'system' || (m.role === 'tool' && m.name && UNCHECKED_TOOLS.has(m.name))) return
    const text = textOf(m)
    if (text.trim()) out.push({ key: fp(text), text, source: sourceOf(m), index })
  })
  return out
}

/** Parts not checked yet. */
export function unscanned(state: PrivacyThreadState, segments: Segment[]): Segment[] {
  const seen = new Set(state.scanned)
  return segments.filter((s) => !seen.has(s.key))
}

export interface Finding extends PrivacyGateItem {
  segment: string
  score: number
  /** PII-Tracer may be wrong here: a larger local model takes a second look in context before the user is asked. */
  unsure: boolean
}

/** Below this, a span isn't a finding at all. */
export const MIN_SCORE = 0.5

/**
 * Finds worth a second look (not too strict): lower confidence, or a shape that's often not personal on its
 * own: a bare place name as an "address", a date with no digits ("tomorrow"), a one-word "name". Passwords,
 * keys and account numbers are never second-guessed.
 */
export function unsureFinding(label: PrivacyLabel, value: string, score: number): boolean {
  if (STRICT_LABELS.has(label)) return false
  if (score < 0.9) return true
  const words = value.split(/\s+/).filter(Boolean).length
  if (label === 'private_address') return !/\d/.test(value) && words <= 3
  if (label === 'private_date') return !/\d/.test(value)
  if (label === 'private_person') return words === 1
  if (label === 'other_pii') return true
  return false
}

/** New personal details in the checked parts (each value once; ones already decided in this chat are left out). */
export function findings(state: PrivacyThreadState, found: Array<{ segment: Segment; spans: PrivacySpan[] }>, minScore = 0): Finding[] {
  const known = new Set(state.items.map((i) => keyOf(i.value)))
  const out: Finding[] = []
  const seen = new Set<string>()
  for (const { segment, spans } of found) {
    for (const s of spans) {
      const value = (s.text ?? segment.text.slice(s.start, s.end)).trim()
      const k = keyOf(value)
      if (value.length < 2 || s.score < Math.max(minScore, MIN_SCORE) || known.has(k) || seen.has(k)) continue
      seen.add(k)
      out.push({ id: fp(`${s.label}:${k}`).slice(0, 12), label: s.label, value, source: segment.source, strict: STRICT_LABELS.has(s.label), segment: segment.key, score: s.score, unsure: unsureFinding(s.label, value, s.score) })
    }
  }
  return out
}

export interface DocumentFinding { segment: string; kind: PrivacyDocumentKind; source: string }

/** Whole personal records among the checked parts (a bank statement, a bill, a pay stub). */
export function documentFindings(segments: Segment[], sensitivity: Map<string, number> = new Map()): DocumentFinding[] {
  return segments.flatMap((s) => {
    const kind = classifyDocument(s.text) ?? ((sensitivity.get(s.key) ?? 0) >= SENSITIVE_PASSAGE && s.text.length >= 300 ? 'sensitive_text' : undefined)
    return kind ? [{ segment: s.key, kind, source: s.source }] : []
  })
}

/**
 * The PHI scanner's identifiers it is almost never wrong about (phi_scan, the HIPAA Safe Harbor rules): one
 * detector with PII-Tracer, so an SSN or a record number is caught even when the model misses it.
 */
const PHI_STRICT: Partial<Record<PhiType, PrivacyLabel>> = { ssn: 'account_number', mrn: 'account_number', health_plan_id: 'account_number', account: 'account_number', license: 'account_number' }
export function phiSpans(text: string): PrivacySpan[] {
  return scanPhi(text).findings.filter((f) => f.confidence === 'high' && PHI_STRICT[f.type]).map((f) => ({ start: f.start, end: f.end, label: PHI_STRICT[f.type]!, score: 0.99, text: text.slice(f.start, f.end) }))
}

/** PII-Tracer's spans plus the PHI scanner's, overlaps resolved in PII-Tracer's favour unless the scanner's span is longer. */
export function mergeSpans(model: PrivacySpan[], rules: PrivacySpan[]): PrivacySpan[] {
  const out = [...model]
  for (const r of rules) {
    const hit = out.findIndex((m) => m.start < r.end && r.start < m.end)
    if (hit < 0) out.push(r)
    else if (r.end - r.start > out[hit].end - out[hit].start) out[hit] = r
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Above this, PII-Tracer's whole-text sensitivity marks a long passage as personal even with few tagged details. */
export const SENSITIVE_PASSAGE = 0.95

/**
 * Detection with the conversation around it: PII-Tracer reads the text just before the part too (whether a
 * name is the user's or a public figure's depends on context), and only spans inside the part count.
 */
export async function detectInContext(all: Segment[], segment: Segment, detect: (text: string) => Promise<{ spans: PrivacySpan[]; sensitivity?: number }>, contextChars = 1200): Promise<{ spans: PrivacySpan[]; sensitivity: number }> {
  const before = all.filter((s) => s.index < segment.index).map((s) => s.text).join('\n\n').slice(-contextChars)
  const prefix = before ? `${before}\n\n` : ''
  const { spans, sensitivity } = await detect(prefix + segment.text)
  const mine = spans.filter((s) => s.start >= prefix.length).map((s) => ({ ...s, start: s.start - prefix.length, end: s.end - prefix.length, text: segment.text.slice(s.start - prefix.length, s.end - prefix.length) }))
  return { spans: mergeSpans(mine, phiSpans(segment.text)), sensitivity: sensitivity ?? 0 }
}

/** How a "not personal" answer is remembered across chats: the label and the value, case and spacing ignored. */
export const notPersonalKey = (label: PrivacyLabel | string, value: string): string => `${label}:${value.trim().toLowerCase().replace(/\s+/g, ' ')}`

/** Finds the local model judged not personal: remembered as shareable, so they aren't asked about again. */
export function recordNotPersonal(state: PrivacyThreadState, found: Finding[]): void {
  for (const f of found) state.items.push({ value: f.value, label: f.label, placeholder: '', share: true })
}

/** Marks parts as checked (call after the user answered, or when nothing was found). */
export function markScanned(state: PrivacyThreadState, segments: Segment[]): void {
  const set = new Set(state.scanned)
  for (const s of segments) set.add(s.key)
  // Keep the record bounded: the newest fingerprints matter most.
  state.scanned = [...set].slice(-2000)
}

/**
 * Records the user's answer for these finds. Personal records (`docs`) stay on this Mac for every choice
 * but "Share anyway": cloud models see a withheld note and ask the local model (ask_on_mac) about them.
 */
export function applyAnswer(state: PrivacyThreadState, found: Finding[], answer: PrivacyAnswer, docs: DocumentFinding[] = []): void {
  const notPersonal = new Set(answer.notPersonal)
  for (const f of found) {
    const share = notPersonal.has(f.id) || (answer.action === 'share' && !f.strict)
    const n = (state.counters[f.label] ?? 0) + 1
    state.counters[f.label] = n
    state.items.push({ value: f.value, label: f.label, placeholder: `[${PRIVACY_LABEL_TEXT[f.label].placeholder}_${n}]`, share })
  }
  const withheld = new Set(state.skipped)
  if (answer.action === 'skip') for (const f of found) if (!notPersonal.has(f.id)) withheld.add(f.segment)
  if (answer.action !== 'share') for (const d of docs) withheld.add(d.segment)
  state.skipped = [...withheld]
  if (answer.remember) state.remember = answer.action
}

const masked = (state: PrivacyThreadState): PrivacyRecord[] => state.items.filter((i) => !i.share).sort((a, b) => b.value.length - a.value.length)

/** Text with every masked value replaced by its stand-in (case-insensitive). */
export function maskText(text: string, state: PrivacyThreadState, json = false): string {
  let out = text
  for (const i of masked(state)) {
    const needle = json ? JSON.stringify(i.value).slice(1, -1) : i.value
    // Whole words only where the value starts or ends with a letter or digit ("Ann" never touches "annual").
    const pre = /^[\p{L}\p{N}]/u.test(needle) ? '(?<![\\p{L}\\p{N}])' : ''
    const post = /[\p{L}\p{N}]$/u.test(needle) ? '(?![\\p{L}\\p{N}])' : ''
    out = out.replace(new RegExp(`${pre}${escapeRe(needle)}${post}`, 'giu'), i.placeholder)
  }
  return out
}

/** Provider-native blocks (Claude's): text and tool inputs masked; signed thinking blocks left exactly as they are. */
function maskRaw(raw: unknown, state: PrivacyThreadState): unknown {
  if (typeof raw === 'string') return maskText(raw, state)
  if (Array.isArray(raw)) return raw.map((x) => maskRaw(x, state))
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (o.type === 'thinking' || o.type === 'redacted_thinking' || typeof o.signature === 'string' || typeof o.encrypted_content === 'string') return raw
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'id' || k === 'tool_use_id' || k === 'type' ? v : maskRaw(v, state)]))
  }
  return raw
}

/** The request as a cloud model may see it. */
export function maskWire(wire: WireMessage[], state: PrivacyThreadState): WireMessage[] {
  if (!state.items.some((i) => !i.share) && !state.skipped.length) return wire
  const skipped = new Set(state.skipped)
  return wire.map((m) => {
    if (m.role === 'system') return { ...m, content: typeof m.content === 'string' ? maskText(m.content, state) : m.content }
    if (skipped.size && skipped.has(fp(textOf(m)))) return { ...m, content: WITHHELD, raw: undefined }
    const content = typeof m.content === 'string' ? maskText(m.content, state)
      : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p === 'object' && 'text' in p && typeof (p as { text?: unknown }).text === 'string' ? { ...p, text: maskText((p as { text: string }).text, state) } : p)) as typeof m.content
      : m.content
    return {
      ...m,
      content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map((c) => ({ ...c, function: { ...c.function, arguments: maskText(c.function.arguments, state, true) } })) } : {}),
      ...(m.raw !== undefined ? { raw: maskRaw(m.raw, state) } : {})
    }
  })
}

/** The real values back in what a cloud model wrote (its reply, its tool calls). */
export function restoreText(text: string, state: PrivacyThreadState, json = false): string {
  if (!text.includes('[')) return text
  return text.replace(/\[([A-Z]+)_(\d+)\]/g, (whole) => {
    const hit = state.items.find((i) => !i.share && i.placeholder === whole)
    return hit ? (json ? JSON.stringify(hit.value).slice(1, -1) : hit.value) : whole
  })
}

/** Restores stand-ins in streamed text, holding back a stand-in that's split across chunks. */
export class StreamRestorer {
  private held = ''
  constructor(private state: PrivacyThreadState) {}
  push(text: string): string {
    const all = this.held + text
    const open = all.lastIndexOf('[')
    // Hold a possible stand-in that hasn't closed yet ("[PERS", "[EMAIL_1").
    if (open >= 0 && !all.includes(']', open) && all.length - open <= 24 && /^\[[A-Z]*_?\d*$/.test(all.slice(open))) {
      this.held = all.slice(open)
      return restoreText(all.slice(0, open), this.state)
    }
    this.held = ''
    return restoreText(all, this.state)
  }
  flush(): string { const out = restoreText(this.held, this.state); this.held = ''; return out }
}

/** "1 name · 2 email addresses" for the card and notices. */
export function describe(items: Array<{ label: PrivacyLabel }>): string {
  const counts = new Map<PrivacyLabel, number>()
  for (const i of items) counts.set(i.label, (counts.get(i.label) ?? 0) + 1)
  return [...counts].map(([l, n]) => `${n} ${n === 1 ? PRIVACY_LABEL_TEXT[l].one : PRIVACY_LABEL_TEXT[l].many}`).join(' · ')
}

/** The answer string from the card (JSON), checked; anything else is "Skip content". */
export function parseAnswer(raw: string): PrivacyAnswer {
  try {
    const a = JSON.parse(raw) as Partial<PrivacyAnswer>
    if (a && ['local', 'split', 'share', 'skip'].includes(a.action as string)) {
      return { action: a.action as PrivacyAction, notPersonal: Array.isArray(a.notPersonal) ? a.notPersonal.filter((x): x is string => typeof x === 'string') : [], remember: a.remember === true }
    }
  } catch { /* a stop or a deny */ }
  return { action: 'skip', notPersonal: [], remember: false }
}
