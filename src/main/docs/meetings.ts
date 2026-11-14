// Meeting notes: transcripts (plain text, "Name: text", Zoom/Teams .vtt, .srt) to structured notes with
// decisions, action items (owner, task, due date resolved against the meeting date) and open questions.
// The model usually writes the summary and items itself; the extraction here catches what it missed and
// is the fallback when no items are given.

export interface ActionItem {
  task: string
  owner?: string
  /** As said ("Friday", "next week", "11/20"). */
  due?: string
  /** Resolved date (YYYY-MM-DD). */
  due_date?: string
  status?: string
}

export interface MeetingInput {
  title?: string
  /** Meeting date (YYYY-MM-DD or any common format); due dates resolve against it. */
  date?: string
  time?: string
  location?: string
  facilitator?: string
  attendees?: string[]
  absent?: string[]
  summary?: string
  decisions?: string[]
  actions?: ActionItem[]
  topics?: Array<{ title: string; notes: string[] }>
  questions?: string[]
  next_meeting?: string
}

export interface Extracted {
  speakers: string[]
  decisions: string[]
  actions: ActionItem[]
  questions: string[]
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const iso = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
const day = (d: Date, n: number): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n))

/** Midnight UTC of a date string (or today). */
export function baseDate(s?: string, now = new Date()): Date {
  const m = s && /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  const t = s ? Date.parse(s) : NaN
  const d = Number.isFinite(t) ? new Date(t) : now
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
}

/** Resolves a spoken due date against the meeting date. */
export function resolveDue(text: string, base: Date): string | undefined {
  const t = text.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  let m: RegExpExecArray | null
  if (/\b(today|eod|end of (the )?day|tonight)\b/.test(t)) return iso(base)
  if (/\btomorrow\b/.test(t)) return iso(day(base, 1))
  if ((m = /\bin (\d+|a|one|two|three) (day|week|month)s?\b/.exec(t))) {
    const n = ({ a: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[m[1]] ?? Number(m[1])
    return iso(m[2] === 'day' ? day(base, n) : m[2] === 'week' ? day(base, 7 * n) : new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + n, base.getUTCDate())))
  }
  if (/\b(eow|end of (the |this )?week)\b/.test(t)) return iso(day(base, ((5 - base.getUTCDay() + 7) % 7) || 7))
  if (/\b(eom|end of (the |this )?month)\b/.test(t)) return iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)))
  if (/\bnext week\b/.test(t)) return iso(day(base, ((1 - base.getUTCDay() + 7) % 7) || 7))
  if (/\bnext month\b/.test(t)) return iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1)))
  if ((m = /\b(next |this )?(sun|mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?)(day)?\b/.exec(t))) {
    const key = m[2].slice(0, 3)
    const wd = WEEKDAYS.findIndex((w) => w.startsWith(key))
    let ahead = (wd - base.getUTCDay() + 7) % 7 || 7
    // "next Friday" said early in the week means the Friday of next week.
    if (m[1]?.trim() === 'next' && base.getUTCDay() + ahead <= 6 && base.getUTCDay() !== 0) ahead += 7
    return iso(day(base, ahead))
  }
  if ((m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t))) return iso(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])))
  const later = (mo: number, d: number, y?: number): string => {
    let dt = new Date(Date.UTC(y ?? base.getUTCFullYear(), mo, d))
    if (!y && dt < base) dt = new Date(Date.UTC(base.getUTCFullYear() + 1, mo, d))
    return iso(dt)
  }
  if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t))) return later(+m[1] - 1, +m[2], m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : undefined)
  if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?\b/.exec(t))) return later(MONTHS.indexOf(m[1]), +m[2], m[3] ? +m[3] : undefined)
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)? (?:of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?: (\d{4}))?\b/.exec(t))) return later(MONTHS.indexOf(m[2]), +m[1], m[3] ? +m[3] : undefined)
  return undefined
}

export function dueLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** Removes WebVTT/SRT cue numbers and timestamps; turns "<v Name>text" into "Name: text". */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/^WEBVTT.*$/m, '')
    .split('\n')
    .filter((l) => !/^\s*\d+\s*$/.test(l) && !/-->/.test(l) && !/^NOTE\b/.test(l))
    .map((l) => l.replace(/^<v\s+([^>]+)>(.*?)(<\/v>)?$/, '$1: $2').replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .join('\n')
}

const DUE_RE = /\b(?:by|before|due|until|on|no later than)\s+((?:next |this |the )?(?:end of (?:the )?(?:day|week|month)|eod|eow|eom|tomorrow|today|next week|next month|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*))/i
const TIME_RE = /\b(tomorrow|today|eod|eow|next week|end of (?:the )?(?:day|week|month))\b/i

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const NAME = "[A-Z][a-z]+(?:\\s[A-Z][a-z]+)?"
const notName = /^(I|We|You|They|He|She|It|This|That|The|Let|Can|Could|So|And|But|Okay|Ok|Yes|No|Also|Then|Maybe|Everyone|Team|Someone)$/

/** Heuristic extraction from a transcript or rough notes. */
export function extractFromTranscript(raw: string, meetingDate?: string): Extracted {
  const base = baseDate(meetingDate)
  const text = cleanTranscript(raw)
  const speakers = new Set<string>()
  const decisions: string[] = [], questions: string[] = []
  const actions: ActionItem[] = []
  for (const line of text.split('\n')) {
    const sp = new RegExp(`^(${NAME})\\s*(?:\\([^)]*\\))?\\s*:\\s*(.*)$`).exec(line)
    const speaker = sp && !notName.test(sp[1]) ? sp[1] : undefined
    if (speaker) speakers.add(speaker)
    const said = sp && speaker ? sp[2] : line
    for (const sentence of said.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const s = sentence.trim().replace(/^[-*•]\s*/, '')
      if (s.length < 6) continue
      if (/\b(we (decided|agreed|are going with|will go with|'ll go with)|decision\s*[:\-]|agreed\s*[:\-]|(is|was|got) approved|let's go with|we're going with|final decision|consensus is)\b/i.test(s)) {
        decisions.push(cap(s.replace(/^(decision|agreed)\s*[:\-]\s*/i, '').replace(/[.!]+$/, '')))
        continue
      }
      let owner: string | undefined, task: string | undefined
      let m: RegExpExecArray | null
      if ((m = /^(?:action(?: item)?|ai|todo|to-do|follow[- ]up)\s*[:\-]\s*(.+)$/i.exec(s))) {
        task = m[1]
        const o = new RegExp(`(?:@|\\b(?:owner|assigned to)\\s*[:\\-]?\\s*|\\(|[—–-]\\s*)(${NAME})\\)?\\s*$`).exec(task) ?? new RegExp(`^(${NAME})\\s+(?:to|will)\\s+`).exec(task)
        if (o && !notName.test(o[1])) { owner = o[1]; task = task.replace(o[0], ' ').trim() }
      } else if ((m = new RegExp(`^(${NAME})\\s+(?:will|is going to|to|needs to|should|has to|agreed to|volunteered to)\\s+(.+)$`).exec(s)) && !notName.test(m[1])) {
        owner = m[1]; task = m[2]
      } else if (speaker && (m = /^(?:ok(?:ay)?,?\s*|sure,?\s*|yes,?\s*|and\s+)?(?:I'll|I will|I can|I'm going to|let me)\s+(.+)$/i.exec(s))) {
        owner = speaker; task = m[1]
      } else if ((m = new RegExp(`^(${NAME}),\\s*(?:can|could) you\\s+(.+?)\\??$`).exec(s)) && !notName.test(m[1])) {
        owner = m[1]; task = m[2]
      } else if ((m = new RegExp(`^(?:can|could) you\\s+(.+?),\\s*(${NAME})\\??$`).exec(s)) && !notName.test(m[2])) {
        owner = m[2]; task = m[1]
      }
      if (task && /^(think|guess|mean|agree|see|know|hope|feel)\b/i.test(task)) task = undefined
      if (task) {
        const dm = DUE_RE.exec(task) ?? TIME_RE.exec(task)
        const due = dm ? (dm[1] ?? dm[0]).trim() : undefined
        const clean = cap(task.replace(DUE_RE, '').replace(TIME_RE, '').replace(/\s+([,.!?])/g, '$1').replace(/[\s,]+$/g, '').replace(/[.!?]+$/, '').trim())
        if (clean.length >= 4) {
          const dd = due ? resolveDue(due, base) : undefined
          actions.push({ task: clean, ...(owner ? { owner } : {}), ...(due ? { due } : {}), ...(dd ? { due_date: dd } : {}) })
        }
        continue
      }
      if (/\?$/.test(s) && /\b(should we|do we|how (do|will|should) we|what (if|about)|who (will|owns|is)|when (do|will|should))\b/i.test(s)) questions.push(cap(s))
      else if (/\b(open question|tbd|to be decided|need to (figure out|decide|confirm)|still unclear|not sure yet)\b/i.test(s)) questions.push(cap(s.replace(/[.!]+$/, '')))
    }
  }
  const uniq = <T>(xs: T[], k: (x: T) => string) => xs.filter((x, i) => xs.findIndex((y) => k(y) === k(x)) === i)
  return {
    speakers: [...speakers],
    decisions: uniq(decisions, (d) => d.toLowerCase()).slice(0, 20),
    actions: uniq(actions, (a) => a.task.toLowerCase()).slice(0, 40),
    questions: uniq(questions, (q) => q.toLowerCase()).slice(0, 12)
  }
}

/** Fills in due dates from what was said; returns warnings for items missing an owner or date. */
export function normalizeActions(actions: ActionItem[], meetingDate?: string): { actions: ActionItem[]; warnings: string[] } {
  const base = baseDate(meetingDate)
  const warnings: string[] = []
  const out = actions.map((a) => {
    const x = { ...a, task: a.task.trim() }
    if (x.due && !x.due_date) {
      const d = resolveDue(x.due, base)
      if (d) x.due_date = d
      else warnings.push(`Couldn't turn "${x.due}" into a date for "${x.task}".`)
    }
    if (x.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(x.due_date)) {
      const d = resolveDue(x.due_date, base)
      if (d) x.due_date = d
    }
    return x
  })
  const noOwner = out.filter((a) => !a.owner?.trim())
  if (noOwner.length) warnings.push(`${noOwner.length} action item(s) have no owner: ${noOwner.slice(0, 4).map((a) => `"${a.task}"`).join(', ')}.`)
  const noDue = out.filter((a) => !a.due_date && !a.due)
  if (noDue.length) warnings.push(`${noDue.length} action item(s) have no due date.`)
  return { actions: out, warnings }
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** The body of the notes (the meeting_notes template adds the title and details table). */
export function meetingMarkdown(m: MeetingInput): string {
  const out: string[] = []
  if (m.summary?.trim()) out.push('## Summary', m.summary.trim())
  out.push('## Decisions', m.decisions?.length ? m.decisions.map((d) => `- ${d}`).join('\n') : '- No decisions were recorded.')
  if (m.actions?.length) {
    out.push('## Action items', [
      '| # | Action | Owner | Due | Status |',
      '|---:|---|---|---|---|',
      ...m.actions.map((a, i) => `| ${i + 1} | ${esc(a.task)} | ${esc(a.owner?.trim() || 'Unassigned')} | ${a.due_date ? dueLabel(a.due_date) : esc(a.due ?? '—')} | ${esc(a.status ?? 'Open')} |`)
    ].join('\n'))
  } else out.push('## Action items', '- No action items were recorded.')
  for (const t of m.topics ?? []) if (t.title?.trim() && t.notes?.length) out.push(`## ${t.title.trim()}`, t.notes.map((n) => `- ${n}`).join('\n'))
  if (m.questions?.length) out.push('## Open questions', m.questions.map((q) => `- ${q}`).join('\n'))
  if (m.next_meeting?.trim()) out.push('## Next meeting', m.next_meeting.trim())
  return out.join('\n\n') + '\n'
}
