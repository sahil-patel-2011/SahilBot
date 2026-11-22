import type { Message } from '@shared/types'
import type { ThreadState, ToolDef } from './types'

// Working notes: the agent's durable memory for one long task, kept in the thread state (the database), never
// in the user's files. Structured in the same fixed sections the compaction summary uses (llm/summary-format.ts),
// capped and deduplicated, carried verbatim in the task brief after every compaction (context.ts taskBrief),
// and re-surfaced at milestones. The user's own constraints are captured into them automatically, by a
// deterministic rule over the user's own messages only: never tool output, web pages, relayed messages or the
// app's hidden notes (those are data, not instructions).

export const NOTE_SECTIONS = ['Goal', 'Constraints', 'Decisions', 'State', 'Files', 'Identifiers', 'Open questions', 'Failed attempts', 'Next steps'] as const
export type NoteSection = typeof NOTE_SECTIONS[number]
/** tainted: the agent wrote it after reading outside content this turn (the durable memory keeps it as an unverified fact). */
export interface NoteEntry { section: NoteSection; text: string; by: 'user' | 'agent'; at: number; tainted?: boolean }
export interface TaskNotes { entries: NoteEntry[]; /** User message ids already scanned for constraints (newest 200). */ scanned?: string[] }

/** One entry's most characters; a section's most entries (Constraints hold more); the whole rendering's default room. */
export const NOTE_ENTRY_CHARS = 400
export const NOTE_SECTION_MAX = 25
export const NOTE_CONSTRAINT_MAX = 40
export const NOTES_ROOM = 8000

const SECTION_HELP: Record<NoteSection, string> = {
  Goal: 'what the finished result is',
  Constraints: 'the user\'s rules and preferences (yours to follow, not to change)',
  Decisions: 'what you decided and why',
  State: 'progress and partial results, with their numbers',
  Files: 'paths you created, changed or need',
  Identifiers: 'IDs, numbers, URLs, branch and ticket names, and the NAMES of secrets (never their values)',
  'Open questions': 'what is still unknown or needs the user',
  'Failed attempts': 'what didn\'t work and why, so it isn\'t retried',
  'Next steps': 'what comes next'
}

/** Accepts the canonical section names and common variants ("constraint", "files", "failed", "todo"…). */
export function sectionOf(name: string | undefined): NoteSection | undefined {
  const n = (name ?? '').toLowerCase().replace(/[^a-z ]/g, '').trim()
  if (!n) return undefined
  const exact = NOTE_SECTIONS.find((s) => s.toLowerCase() === n)
  if (exact) return exact
  const table: Array<[RegExp, NoteSection]> = [
    [/^goal|objective|task/, 'Goal'], [/constraint|rule|preference|requirement/, 'Constraints'], [/decision|decided|choice/, 'Decisions'],
    [/state|progress|status|result|done/, 'State'], [/file|path/, 'Files'], [/ident|^ids?$|number|secret|credential|key/, 'Identifiers'],
    [/question|unknown|unclear/, 'Open questions'], [/fail|tried|dead end|didnt work/, 'Failed attempts'], [/next|todo|plan/, 'Next steps']
  ]
  return table.find(([re]) => re.test(n))?.[1]
}

const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}/._#$%-]+/gu, ' ').trim()

// Secret values never go in the notes: names only. Values that look like keys, tokens or passwords are cut.
const KEY_SHAPES = /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const ASSIGNED = /\b((?:password|passcode|passwd|pwd|api[ _-]?key|secret|token|pin|private[ _-]?key)\b[^\n:=]{0,20}?(?:[:=]|\bis\b)\s*)(["']?)([^\s"',;]{4,})\2/gi
const ENV_VALUE = /\b([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)[A-Z0-9_]*)=(\S{4,})/g
/** The text with anything that looks like a secret value replaced by [redacted] (names stay). */
export function redactSecrets(text: string, known: string[] = []): string {
  let out = text.replace(KEY_SHAPES, '[redacted]').replace(ENV_VALUE, '$1=[redacted]').replace(ASSIGNED, (all, lead: string, _q: string, value: string) => (/^[A-Z][A-Z0-9_]+$/.test(value) || value === '[redacted]' ? all : `${lead}[redacted]`))
  for (const v of known) if (v && v.length >= 4) out = out.split(v).join('[redacted]')
  return out
}

/**
 * The answer with any live secret it copied out of a file or command output (an API key read from .env) hidden,
 * keeping its first characters so it's clear which key is meant. Secrets the user typed themselves stay.
 */
export function hideCopiedSecrets(answer: string, outputs: string, userText: string): string {
  const fromOutputs = new Set<string>()
  for (const m of outputs.matchAll(new RegExp(KEY_SHAPES.source, 'g'))) fromOutputs.add(m[0])
  for (const m of outputs.matchAll(new RegExp(ENV_VALUE.source, 'g'))) if (m[2].length >= 8) fromOutputs.add(m[2])
  let out = answer
  for (const v of [...fromOutputs].sort((a, b) => b.length - a.length)) {
    if (!out.includes(v) || userText.includes(v)) continue
    out = out.split(v).join(`${v.slice(0, Math.min(7, Math.floor(v.length / 3)))}…[hidden]`)
  }
  return out
}

const clip = (t: string, n = NOTE_ENTRY_CHARS): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

export function notesOf(state: Pick<ThreadState, 'taskNotes'>): TaskNotes {
  return (state.taskNotes ??= { entries: [] }) as TaskNotes
}

/**
 * Adds one entry (deduplicated: an entry already there, or one this new one contains, isn't kept twice).
 * A full section drops its oldest agent entry; the user's constraints are never dropped. Returns what happened.
 */
export function addNote(state: Pick<ThreadState, 'taskNotes'>, section: NoteSection, text: string, by: 'user' | 'agent' = 'agent', known: string[] = [], o: { tainted?: boolean } = {}): { added: boolean; dropped?: string; reason?: string } {
  const notes = notesOf(state)
  const t = clip(redactSecrets(text.replace(/\s+/g, ' ').trim(), known))
  if (!t) return { added: false, reason: 'empty' }
  const k = norm(t)
  const same = notes.entries.filter((e) => e.section === section)
  const dup = same.find((e) => norm(e.text) === k || norm(e.text).includes(k))
  if (dup) {
    // The user's words outrank the agent's for the same rule.
    if (by === 'user' && dup.by === 'agent') dup.by = 'user'
    return { added: false, reason: 'already in the notes' }
  }
  // A longer version of an entry replaces it (in place, so the order stays).
  const shorter = same.find((e) => k.includes(norm(e.text)) && e.by === by)
  if (shorter) { shorter.text = t; shorter.at = Date.now(); if (o.tainted) shorter.tainted = true; return { added: true } }
  const cap = section === 'Constraints' ? NOTE_CONSTRAINT_MAX : NOTE_SECTION_MAX
  let dropped: string | undefined
  if (same.length >= cap) {
    const oldest = same.find((e) => e.by === 'agent')
    if (!oldest) return { added: false, reason: `${section} is full (${cap} entries from the user): nothing was dropped` }
    notes.entries.splice(notes.entries.indexOf(oldest), 1)
    dropped = oldest.text
  }
  notes.entries.push({ section, text: t, by, at: Date.now(), ...(o.tainted ? { tainted: true } : {}) })
  return { added: true, dropped }
}

/** Entries of a section that contain `match` (case-insensitive), or all of them. */
const matching = (notes: TaskNotes, section: NoteSection, match?: string): NoteEntry[] => notes.entries.filter((e) => e.section === section && (!match || e.text.toLowerCase().includes(match.toLowerCase())))

/** The notes as text: fixed section order, newest last; over `room` characters the oldest agent entries are left out. */
export function renderNotes(state: Pick<ThreadState, 'taskNotes' | 'notes'>, room = NOTES_ROOM): string {
  const entries = (state.taskNotes as TaskNotes | undefined)?.entries ?? []
  const scratch = state.notes?.trim() ? clip(state.notes.trim(), 3000) : ''
  if (!entries.length && !scratch) return ''
  // Over the room: drop the oldest agent entries of the least critical sections first (never the user's).
  const order: NoteSection[] = ['Next steps', 'Open questions', 'State', 'Files', 'Decisions', 'Identifiers', 'Failed attempts', 'Goal', 'Constraints']
  const keep = new Set(entries)
  const size = (): number => [...keep].reduce((n, e) => n + e.text.length + 4, 0) + scratch.length + 200
  let left = 0
  for (const s of order) {
    for (const e of entries.filter((x) => x.section === s && x.by === 'agent')) {
      if (size() <= room) break
      keep.delete(e)
      left++
    }
  }
  const out: string[] = []
  for (const s of NOTE_SECTIONS) {
    const es = entries.filter((e) => e.section === s && keep.has(e))
    if (es.length) out.push(`### ${s}\n${es.map((e) => `- ${e.text}${e.by === 'user' ? ' (the user said)' : ''}`).join('\n')}`)
  }
  if (scratch) out.push(`### Scratch (from todo)\n${scratch}`)
  if (left) out.push(`(${left} older entries not shown to save room: notes action "read" shows them all.)`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------------
// Auto-capture of the user's constraints
// ---------------------------------------------------------------------------------------------------

/** Words that make a sentence of the user's a rule for the task ("don't touch the API folder", "use pnpm, not npm"). */
const RULE = /\b(?:don'?t|do not|never|always|must(?:n'?t| not)?|only|avoid|make sure|ensure|no more than|at most|at least|without|not allowed|forbidden|stay (?:under|within|below|inside)|keep (?:all|every|everything|it|them|the|\w+) [\w\s$.,-]{0,40}?\b(?:in|under|below|within|as|at|to)\b|(?:use|prefer) [\w./-]+,? (?:not|instead of|rather than|over)|instead of|ask (?:me )?(?:first|before)|before you|under (?:\$|€|£)?\d|no (?:emails?|deletes?|deletions?|changes|pushes?|commits?)\b|leave [\w./-]+ (?:alone|as is|untouched))/i

/** The rule-like sentences of one message of the user's (pure: tests and the capture below). */
export function extractConstraints(text: string): string[] {
  const body = text.replace(/^<context[^>]*>[\s\S]*?<\/context>\n*/, '').replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, (u) => u)
  const out: string[] = []
  for (const raw of body.split(/(?<=[.!?;])\s+|\n+/)) {
    const s = raw.replace(/^[\s>*•-]+/, '').trim()
    if (s.length < 8 || s.length > 400 || s.endsWith('?')) continue
    if (RULE.test(s)) out.push(s)
  }
  return out.slice(0, 8)
}

/** Message metas that mean a user-role message isn't the user's own words (see context.ts RELAYED_META). */
const NOT_OWN = ['handoff', 'teach', 'helperTask', 'fromLink', 'mcpClientId', 'fromApp', 'hidden', 'goalRun'] as const
export const ownUserMessage = (m: Message): boolean => m.role === 'user' && !NOT_OWN.some((k) => { const v = m.meta?.[k]; return v !== undefined && v !== null && v !== false && v !== '' })

/**
 * Captures the constraints in the user's own messages not scanned yet into the notes' Constraints section.
 * Only role "user" messages the user typed count: never tool output, relayed messages or the app's notes.
 * Returns the constraints added.
 */
export function captureConstraints(state: Pick<ThreadState, 'taskNotes'>, messages: Message[], known: () => string[] = () => []): string[] {
  // Only the user's own messages are ever read (relayed and hidden ones aren't even looked at).
  const done = new Set(state.taskNotes?.scanned ?? [])
  const fresh = messages.filter((m) => ownUserMessage(m) && !done.has(m.id))
  if (!fresh.length) return []
  const notes = notesOf(state)
  const scanned = new Set(notes.scanned ?? [])
  const added: string[] = []
  let secrets: string[] | undefined
  for (const m of fresh) {
    scanned.add(m.id)
    for (const c of extractConstraints(m.content)) if (addNote(state, 'Constraints', c, 'user', (secrets ??= known())).added) added.push(c)
  }
  notes.scanned = [...scanned].slice(-200)
  return added
}

// ---------------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------------

type NotesArgs = { action: 'add' | 'update' | 'remove' | 'read' | 'recall' | 'memory'; section?: string; text?: string; match?: string; query?: string }

export function notesTool(): ToolDef<NotesArgs> {
  return {
    name: 'notes',
    label: 'Notes',
    core: true,
    effect: 'read',
    description: `Working notes for this task: kept in this chat and carried word for word whenever older messages are summarized. Everything is also saved for good in the task's memory (the project's, shared by its chats). Record as you go, especially at milestones: decisions and why, files, exact IDs and numbers, partial results, open questions, what failed (so it isn't retried). Secret names only, never values. The user's constraints are added to Constraints automatically. Sections: ${NOTE_SECTIONS.join(', ')}. add: an entry (one per line); update: replace the section's entries containing \`match\` (no match: the whole section); remove: drop entries containing \`match\`; read: show all; recall: search everything saved, older entries too (\`text\`: words, a path, an ID); memory: list everything saved.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'read', 'recall', 'memory'] },
        section: { type: 'string', enum: [...NOTE_SECTIONS], description: NOTE_SECTIONS.map((x) => `${x}: ${SECTION_HELP[x]}`).join('; ') },
        text: { type: 'string', description: 'The entry (one per line for several; recall: what to look for). Exact names, paths, IDs and numbers.' },
        match: { type: 'string', description: 'update/remove: text the entries to change contain' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async run({ action, section, text, match, query }, ctx) {
      const st = ctx.state
      const sec = sectionOf(section)
      const notes = notesOf(st)
      const show = (): string => renderNotes(st, Number.MAX_SAFE_INTEGER) || '(no notes yet)'
      const mem = ctx.taskMemory
      const tainted = !!ctx.tainted
      if (action === 'read') return { text: show(), display: `${notes.entries.length} notes` }
      if (action === 'recall' || action === 'memory') {
        if (!mem) return { text: action === 'memory' ? show() : 'Saved task memory isn\'t available here; these are the notes:\n\n' + show(), display: 'notes' }
        const q = (query ?? text ?? match ?? '').trim()
        if (action === 'recall' && !q) throw new Error('Give text: what to look for (words, a path, an ID).')
        const r = action === 'recall' ? mem.recall(q, 15) : mem.full()
        return { text: r.text, untrusted: r.untrusted, display: action === 'recall' ? `recall "${clip(q, 40)}": ${r.count}` : `${r.count} saved` }
      }
      if (!sec) throw new Error(`Give a section: ${NOTE_SECTIONS.join(', ')}.`)
      const lines = (text ?? '').split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean)
      const userOwned = (es: NoteEntry[]): NoteEntry[] => es.filter((e) => e.by === 'user')
      if (action === 'add') {
        if (!lines.length) throw new Error('Give the text to add.')
        const r = lines.map((l) => addNote(st, sec, l, 'agent', [], { tainted }))
        // Written through to the durable memory as well (deduplicated there; nothing is dropped from it).
        for (const l of lines) mem?.note(sec, l, { tainted })
        const dropped = r.map((x) => x.dropped).filter(Boolean)
        const skipped = r.filter((x) => !x.added).map((x) => x.reason)
        return { text: `${r.filter((x) => x.added).length} added to ${sec}.${dropped.length ? ` ${sec} was full; dropped the oldest: ${dropped.map((d) => `"${d}"`).join(', ')}.` : ''}${skipped.length ? ` Skipped: ${[...new Set(skipped)].join('; ')}.` : ''}\n\n${show()}`, display: `${sec}: ${clip(lines[0], 60)}` }
      }
      const hit = matching(notes, sec, match)
      // The user's own rules stay: the agent can't edit or drop them (if the user changed a rule, their newer words win).
      if (userOwned(hit).length && match) throw new Error(`"${match}" matches the user's own constraint, which stays in the notes. If the user changed it, add the new rule as they said it; their latest words win.`)
      const mine = hit.filter((e) => e.by === 'agent')
      if (action === 'remove') {
        if (!match) throw new Error('Give match: text the entries to remove contain.')
        if (!mine.length) throw new Error(`No ${sec} entry contains "${match}".`)
        notes.entries = notes.entries.filter((e) => !mine.includes(e))
        // In the durable memory the removed entries become history (superseded, not deleted).
        for (const e of mine) mem?.retire(sec, e.text)
        return { text: `Removed ${mine.length} from ${sec}.\n\n${show()}`, display: `${sec}: removed ${mine.length}` }
      }
      // update
      if (match && !mine.length) throw new Error(`No ${sec} entry contains "${match}". Use add for a new entry.`)
      const at = mine.length ? notes.entries.indexOf(mine[0]) : -1
      notes.entries = notes.entries.filter((e) => !mine.includes(e))
      const fresh: NoteEntry[] = []
      for (const e of mine) mem?.retire(sec, e.text)
      for (const l of lines) {
        const before = notes.entries.length
        if (addNote(st, sec, l, 'agent', [], { tainted }).added && notes.entries.length > before) fresh.push(notes.entries.pop()!)
        mem?.note(sec, l, { tainted })
      }
      if (at >= 0) notes.entries.splice(Math.min(at, notes.entries.length), 0, ...fresh)
      else notes.entries.push(...fresh)
      return { text: `Updated ${sec} (${mine.length} replaced, ${fresh.length} written).\n\n${show()}`, display: `${sec}: updated` }
    }
  }
}

/** A short line for the todo result at a milestone (an item newly done): what to record before moving on. */
export function milestoneHint(doneNow: string[]): string {
  if (!doneNow.length) return ''
  return `\n\nMilestone: "${clip(doneNow[doneNow.length - 1], 80)}" is done. Before the next item, record what it settled with the notes tool: decisions and why, files, exact IDs and numbers, partial results, and anything that failed.`
}
