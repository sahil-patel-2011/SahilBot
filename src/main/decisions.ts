import { SECRETISH, normalizeText, similar, type Memory, type MemoryProvenance, type MemorySource } from './memory'
import { grantsPermissions, importSecret } from './memory-import'
import { hardStopText, looksInstructionLike, stem } from './agent/permissions'
import { plainOption } from './agent/questions/policy'

// The user's decisions, remembered so the agent can act the way they would (memory kind 'decision').
// Captured without a model call, only from the user's own answers, clicks and words:
//   - answers to the agent's clarifying questions ("Which format? → PDF"), when the choice generalizes;
//   - picks among options the agent offered in its reply ("Option B", "the second one", "Stripe");
//   - corrections ("use Postgres instead of MySQL", "never use em dashes", "make it shorter");
//   - approval patterns: the same kind of action approved or declined several times in a row.
// One memory per topic: a newer choice on the same topic replaces the older one in place (the old choice is
// kept as a short "(earlier: …)" note). Nothing from a web page, email, connected app, another bot or tool
// output ever becomes a decision, secrets never do, and an approval pattern is only ever a memory the agent
// reads (permissions.ts never reads memories; nothing here creates a rule or an "always allow").
// Pure functions plus saveDecision; the recorder that watches chats is learning/decisions.ts.

export type DecisionSource = 'answer' | 'pick' | 'correction' | 'approval'

export interface UserDecision {
  /** What the choice was about ("Which format for the weekly report?", "Postgres or MySQL"); '' for a standing instruction. */
  context: string
  /** What the user chose. */
  choice: string
  /** The other options that were on the table. */
  over?: string[]
  source: DecisionSource
}

export { DECISION_HEADER } from './memory'
const ARROW = ' → '
const MAX_CONTEXT = 160
const MAX_CHOICE = 160

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s)
const cap = (s: string): string => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase())
const words = (s: string): string[] => squash(s).split(' ').filter(Boolean)
const strip = (s: string): string => squash(s.replace(/\*\*|__|`|~~/g, '').replace(/^[“"'(\[]+|[”"')\].,;:!]+$/g, ''))

// ---------------------------------------------------------------- the stored text

/** "Which format for the weekly report? → PDF (over Word)"; a standing instruction is just its sentence. */
export function decisionText(d: UserDecision): string {
  const choice = clip(squash(d.choice), MAX_CHOICE)
  if (!d.context.trim()) return /[.!?…]$/.test(choice) ? cap(choice) : `${cap(choice)}.`
  const over = (d.over ?? []).map(squash).filter((o) => o && normalizeText(o) !== normalizeText(choice)).slice(0, 3)
  return `${cap(clip(squash(d.context), MAX_CONTEXT))}${ARROW}${choice}${over.length ? ` (over ${over.join(', ')})` : ''}`
}

/** Reads a decision memory's text back: its context, the choice and the alternatives (null: a standing instruction or hand-written). */
export function parseDecision(text: string): { context: string; choice: string; over: string[]; earlier?: string } | null {
  const i = text.indexOf(ARROW)
  if (i <= 0) return null
  const context = text.slice(0, i).trim()
  let rest = text.slice(i + ARROW.length).trim()
  let earlier: string | undefined
  const e = rest.match(/\s*\(earlier: ([^)]*)\)\s*$/)
  if (e) { earlier = e[1].trim(); rest = rest.slice(0, e.index).trim() }
  let over: string[] = []
  const o = rest.match(/\s*\(over ([^)]*)\)\s*$/)
  if (o) { over = o[1].split(/,\s*/).map((x) => x.trim()).filter(Boolean); rest = rest.slice(0, o.index).trim() }
  return { context, choice: rest.replace(/[.]$/, ''), over, ...(earlier ? { earlier } : {}) }
}

const TOPIC_STOP = new Set(('a an the to for of on in at by with and or any me my mine i you your it its this that these those do does did ' +
  'should would will can could shall be is are was were am which what how when where who whom whose want like prefer please use using ' +
  'there here than then so if just also into about over from up out now next time one each agent user wants go choose pick option options').split(' '))

/** A topic's comparable key: its significant words, stemmed and sorted ("Which format…?" ≈ "Which FORMAT…"). */
export function topicKey(context: string): string {
  const ws = context.toLowerCase().replace(/[“”"'’]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !TOPIC_STOP.has(w))
  return [...new Set(ws.map(stem))].sort().join(' ')
}

const jaccard = (a: string, b: string): number => {
  const x = new Set(a.split(' ').filter(Boolean)), y = new Set(b.split(' ').filter(Boolean))
  if (!x.size || !y.size) return 0
  let n = 0
  for (const w of x) if (y.has(w)) n++
  return n / (x.size + y.size - n)
}

/** The same decision asked again: the same topic words (or nearly), or the same set of options on the table. */
export function sameTopic(a: { context: string; choice: string; over?: string[] }, b: { context: string; choice: string; over?: string[] }): boolean {
  const ka = topicKey(a.context), kb = topicKey(b.context)
  if (ka && kb && (ka === kb || jaccard(ka, kb) >= 0.6)) return true
  const set = (x: typeof a): Set<string> => new Set([x.choice, ...(x.over ?? [])].map((s) => normalizeText(s)).filter(Boolean))
  const sa = set(a), sb = set(b)
  if (sa.size < 2 || sb.size < 2) return false
  let n = 0
  for (const s of sa) if (sb.has(s)) n++
  return n >= 2
}

// ---------------------------------------------------------------- what may become a decision

const ADDRESS = /(https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+/i
/** Words that hand the agent permission ("without asking", "auto-approve"): never a decision (permissions are the user's, per action). */
const PERMISSIONISH = /\b(without (asking|approval|confirm\w*|checking)|don'?t (ask|check with)|no need to (ask|confirm|check)|skip (the )?(approval|confirmation|review)|auto-?approve|always (allow|approve)|bypass)\b/i
const ACTION_ORDER = /\b(send|forward|upload|transfer|pay|wire|delete|install|run|execute)\b/i

/** Why this can't be remembered as a decision, or null. */
export function decisionBlocked(d: UserDecision, secretValues: string[] = []): string | null {
  const all = [d.context, d.choice, ...(d.over ?? [])].join('\n')
  if (!d.choice.trim()) return 'empty'
  if (SECRETISH.test(all) || importSecret(all)) return 'secret'
  const low = all.toLowerCase()
  if (secretValues.some((v) => v && v.length >= 4 && low.includes(v.toLowerCase()))) return 'secret'
  if (ADDRESS.test(all)) return 'address'
  if (grantsPermissions(all) || PERMISSIONISH.test(all)) return 'permission'
  return null
}

// ---------------------------------------------------------------- 1. answers to clarifying questions

/** Questions about taste or habit ("Which format do you prefer…?", "How often…?"). Shared with agent/questions/learn.ts. */
export const PREFERENCE_QUESTION = /\b(prefer|preference|would you like|do you want|want me to|which (style|format|tone|time|day|layout|font|colou?r|language|length|channel|file type|template|voice|currency|unit)|how (often|long|formal|detailed|much detail|should i (format|name|sign|address))|what (tone|style|format|time|day|name)|favou?rite|by default|usually|from now on|every time)\b/i

/** Not an answer at all: the user left it to the agent. */
const NON_ANSWER = /^\(?\s*(no answer|use your (best )?judge?ment|nobody can answer|skip(ped)?|you (decide|choose|pick)|your call|whatever|either( is fine| one| works)?|any( is fine| one)?|both|none|neither|doesn'?t matter|no preference|idk|i don'?t know|not sure|up to you|dunno)\b/i
const YES_NO = /^(yes|yeah|yep|yup|sure|ok(ay)?|no|nope|nah|y|n|go ahead|do it|please do|sounds good|fine|correct|right)\b[\s.!]*$/i
/** One-off questions: confirming, choosing which existing thing, or whether to go on. */
const ONE_OFF = /^(is|are|was|were|did|does|has|have|had|can you confirm|could you confirm|do you mean|did you mean|is this|is that|shall i|ready|ok to|okay to)\b|\b(go ahead|proceed|continue|carry on|start now|send it now|which (one|of (these|those|them|the following))|which (file|folder|document|doc|person|contact|account|thread|message|email|event|meeting|version|branch|commit|row|item|link|page|tab|window|record|order|invoice))\b|\bdo you mean\b|\bdid you mean\b/i
/** A one-off time ("tomorrow at 3pm"), not a habit. */
const WHEN_ONCE = /\b(today|tonight|tomorrow|yesterday|right now|now|later|asap|soon|this (morning|afternoon|evening|week|weekend)|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i

/**
 * "A or B?" in a question: the options it offers ("Use Stripe or Paddle?" → Stripe, Paddle; "Formal or
 * casual?" → Formal, casual). [] when there's no clear either/or.
 */
export function inlineOptions(question: string): string[] {
  const q = squash(question).replace(/\?+\s*$/, '')
  const sentence = q.split(/(?<=[.!?])\s+/).pop() ?? q
  if (!/\sor\s/i.test(sentence)) return []
  const clause = sentence.split(/[:;—–]\s*/).pop()!
  const parts = clause.split(/,\s*(?:or\s+)?|\s+or\s+/i).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2 || parts.length > 4) return []
  // The last option ends before a trailing qualifier ("Paddle for payments").
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\s+(for|in|on|to|with|as|when|by|this time|instead|here|there|then)\b.*$/i, '').trim()
  // The first one starts after the lead-in ("Should I use Stripe" → Stripe).
  const first = parts[0]
  const lead = [...first.matchAll(/\b(use|using|go with|choose|pick|prefer|want|like|be|make it|is it|it|as|in|to)\s+/gi)].pop()
  let head = lead ? first.slice(lead.index! + lead[0].length) : first
  const k = Math.max(1, Math.min(4, words(parts[parts.length - 1]).length))
  if (words(head).length > k + 1) head = words(head).slice(-k).join(' ')
  parts[0] = head.replace(/^(a|an|the)\s+/i, '')
  const opts = parts.map((p) => strip(p)).filter(Boolean)
  if (opts.length < 2 || opts.some((o) => words(o).length > 5)) return []
  if (opts.every((o) => WHEN_ONCE.test(o))) return []
  return opts
}

/** Same option: equal, or one is the other's whole words ("casual" ~ "casual tone"). */
function optionMatch(answer: string, option: string): boolean {
  const a = normalizeText(answer).replace(/^(a|an|the) /, ''), o = normalizeText(option).replace(/^(a|an|the) /, '')
  if (!a || !o) return false
  if (a === o) return true
  const pad = (s: string): string => ` ${s} `
  return (a.length >= 3 && pad(o).includes(pad(a))) || (o.length >= 3 && pad(a).includes(pad(o)) && words(a).length <= words(o).length + 2)
}

/**
 * The user's answer to one of the agent's questions, as a decision when it generalizes: it picks one of the
 * offered options (listed, or "A or B" in the question), or it answers a taste question. Not: one-off
 * confirmations ("Is that right?"), which-file questions, times, yes/no to anything risky, answers left to
 * the agent, addresses, orders ("send it to…"), or anything after the run read outside content.
 */
export function decisionFromAnswer(q: { question: string; options?: string[]; preference?: boolean }, answer: string, o: { tainted?: boolean } = {}): UserDecision | null {
  if (o.tainted) return null
  const question = clip(squash(q.question ?? ''), 300)
  const a = strip(plainOption(String(answer ?? '')))
  if (!question || !a || a.length > 300 || NON_ANSWER.test(a)) return null
  const pref = q.preference === true || PREFERENCE_QUESTION.test(question)
  const listed = (q.options ?? []).map((x) => strip(plainOption(x))).filter(Boolean)
  const options = listed.length ? listed : inlineOptions(question)
  const picked = options.find((x) => optionMatch(a, x))
  if (YES_NO.test(a)) {
    if (!pref || ONE_OFF.test(question) || hardStopText(question)) return null
  } else if (!picked) {
    // Their own answer: a short one, to a taste question or one with options (they chose something else).
    if (!(pref || options.length) || a.length > 80 || words(a).length > 10) return null
  }
  if (ONE_OFF.test(question) && !pref) return null
  if (WHEN_ONCE.test(a) && !pref) return null
  // Yes to something risky, or an answer that is itself an action order.
  if (hardStopText(a) || (hardStopText(question) && (YES_NO.test(a) || /credential|password/.test(hardStopText(question) ?? '')))) return null
  if (looksInstructionLike(a) && ACTION_ORDER.test(a)) return null
  const choice = picked ?? a
  const d: UserDecision = { context: question, choice, over: options.filter((x) => x !== picked && !optionMatch(choice, x)), source: 'answer' }
  return decisionBlocked(d) ? null : d
}

// ---------------------------------------------------------------- 2. picks among options the agent offered

interface Offered { label?: string; title: string }

const LIST_ITEM = /^\s*(?:[-*+•]|(\d{1,2})[.)]|([A-Ha-h])[.)])\s+(.+)$/
const OPTION_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:option|plan|approach|choice)\s+([A-H1-8])\b\s*(?:\*\*|__)?\s*[:.)\-–—]?\s*(?:\*\*|__)?\s*(.*)$/i
const INVITES = /\?|\b(pick|choose|which|prefer|let me know|go with|want me to|your call|which one)\b/i

/** The title of one offered option: its bold or first part ("**Postgres** — battle-tested" → Postgres). */
function optionTitle(raw: string): string {
  const s = raw.trim()
  const bold = s.match(/^\*\*([^*]{1,80})\*\*/) ?? s.match(/^__([^_]{1,80})__/)
  if (bold) return strip(bold[1])
  const head = strip(s).split(/\s+[—–-]\s+|:\s+|\s+\(/)[0]
  return clip(head, 80)
}

/** The reply's last question, one line ("Which one?"), markdown and list markers stripped. */
function lastQuestion(reply: string): string | undefined {
  return [...reply.matchAll(/[^.!?\n]*\?/g)].map((x) => strip(x[0].replace(/^\s*(?:[-*+•]|\d{1,2}[.)])\s+/, ''))).filter((x) => x.length >= 6).pop()
}

/** The options an agent reply lays out (a numbered, lettered or bulleted list, or "Option A / B" headings) and the line that introduces them. */
export function offeredOptions(reply: string): { options: Offered[]; intro?: string; question?: string; lettered: boolean } | null {
  const lines = reply.replace(/\r\n?/g, '\n').split('\n')
  const heads: Offered[] = []
  const items: Array<Offered & { line: number }> = []
  let lettered = false
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(OPTION_HEAD)
    if (h) { heads.push({ label: h[1].toUpperCase(), title: h[2] ? optionTitle(h[2]) : `Option ${h[1].toUpperCase()}` }); if (/[A-H]/i.test(h[1])) lettered = true; continue }
    const m = lines[i].match(LIST_ITEM)
    if (m && !/^\s{2,}/.test(lines[i])) {
      if (m[2]) lettered = true
      items.push({ label: m[1] ?? m[2]?.toUpperCase(), title: optionTitle(m[3]), line: i })
    }
  }
  // The last question in the reply asks for the choice.
  const tail = reply.slice(-500)
  const question = lastQuestion(reply)
  if (heads.length >= 2 && heads.length <= 8) return INVITES.test(tail) ? { options: heads, question, lettered } : null
  if (items.length < 2 || items.length > 8 || !INVITES.test(tail)) return null
  // One run of consecutive list lines (blank lines between are fine), the list being the choice.
  const first = items[0].line
  const intro = lines.slice(0, first).map((l) => l.trim()).filter(Boolean).pop()
  return { options: items.map(({ label, title }) => ({ label, title })), intro: intro && /:$/.test(intro) && intro.length <= 160 ? intro : undefined, question, lettered }
}

const ORDINAL: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4 }
const NEGATIVE = /\b(neither|none of|not (any|those|these|that|this|it)|something else|other ideas?|different (one|option|ideas?)|don'?t like|no good)\b/i

/** Which offered option the reply picks (by letter, number, ordinal or name), or -1. */
export function pickedIndex(reply: string, offered: { options: Offered[]; lettered: boolean }): number {
  const u = squash(reply).replace(/[.!]+$/, '')
  if (!u || words(u).length > 15 || NEGATIVE.test(u)) return -1
  const n = offered.options.length
  const lead = /^(?:(?:ok(?:ay)?|yes|yeah|yep|sure|great|perfect|nice|cool|hmm+)[,!.\s]+)?(?:let'?s\s+(?:do\s+|go with\s+|use\s+|try\s+)?|(?:i'?ll\s+)?(?:go|going) with\s+|pick\s+|choose\s+|use\s+|do\s+|take\s+|i'?ll take\s+|i (?:like|prefer|want|choose|pick|vote for)\s+|prefer\s+)?(?:the\s+)?/i
  const body = u.replace(lead, '')
  const marked = body.match(/^(?:option|plan|approach|choice|number|no\.?|#)\s*([a-h]|[1-8])\b/i)
  const bare = body.match(/^([a-h]|[1-8])(?=$|[\s,;:)!.-])/i)
  const tok = marked?.[1] ?? (bare && (/\d/.test(bare[1]) || offered.lettered || body.length <= 2) ? bare[1] : undefined)
  if (tok) {
    const i = /\d/.test(tok) ? Number(tok) - 1 : tok.toLowerCase().charCodeAt(0) - 97
    const byLabel = offered.options.findIndex((o) => o.label?.toLowerCase() === tok.toLowerCase())
    const idx = byLabel >= 0 ? byLabel : i
    return idx >= 0 && idx < n ? idx : -1
  }
  const ord = body.match(/^(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b(?:\s+(?:one|option|choice|plan|idea))?/i)
  if (ord && words(u).length <= 8) { const k = ord[1].toLowerCase(); const i = k === 'last' ? n - 1 : ORDINAL[k]; return i < n ? i : -1 }
  // By name: exactly one option named in a short reply.
  const hits = offered.options.map((o, i) => ({ i, ok: o.title.length >= 3 && optionMatch(u, o.title) })).filter((x) => x.ok)
  return hits.length === 1 && words(u).length <= 10 ? hits[0].i : -1
}

/** "Here are three names for your app:" → "Names for your app". */
function introTopic(intro: string): string {
  return cap(strip(intro.replace(/:$/, ''))
    .replace(/^(ok(ay)?|sure|great|got it)[,!.\s]+/i, '')
    .replace(/^(here (are|is)|here'?re|these are|i (came up with|have|found|see|suggest)|a few|some|there are)\s+/i, '')
    .replace(/^(a few|some|several|the|my|two|three|four|five|six|\d+)\s+/i, ''))
}

/**
 * The user's reply picking one of the options the agent's last reply offered ("B", "the second one",
 * "let's go with Postgres"), as a decision. The caller checks that the agent's turn read no outside content.
 */
export function decisionFromPick(agentReply: string, userReply: string): UserDecision | null {
  let offered = offeredOptions(agentReply)
  // No list: an either/or in the reply's last question ("Should I use Stripe or Paddle?").
  if (!offered) {
    const question = lastQuestion(agentReply)
    const inline = question ? inlineOptions(question) : []
    if (inline.length < 2) return null
    offered = { options: inline.map((title) => ({ title })), question, lettered: false }
  }
  const i = pickedIndex(userReply, offered)
  if (i < 0) return null
  const titles = offered.options.map((o) => o.title)
  // The topic: the line that introduced the options, else the question, else the options themselves.
  const meaningful = (x?: string): x is string => !!x && x.length <= MAX_CONTEXT && topicKey(x).split(' ').filter(Boolean).length >= 1
  const intro = offered.intro ? introTopic(offered.intro) : undefined
  const context = meaningful(intro) ? intro : meaningful(offered.question) && !/^(want me to|should i (start|go|proceed|begin)|shall i)\b/i.test(offered.question) ? offered.question : `Choosing between ${titles.slice(0, 4).join(', ')}`
  const d: UserDecision = { context, choice: titles[i], over: titles.filter((_t, j) => j !== i), source: 'pick' }
  if (hardStopText(d.choice)) return null
  return decisionBlocked(d) ? null : d
}

// ---------------------------------------------------------------- 3. corrections

const STANDING = /^(?:(?:and|also|ok(?:ay)?|please|pls|so|oh|btw|one more thing)[,\s]+)*(always|never|don'?t ever|do not ever|never ever|from now on|going forward|in (the )?future|next time|every time|whenever)\b/i
const SHORTER = /\b(too long|too wordy|(make|keep) (it|them|this) (shorter|brief|briefer|concise|tighter|short)|shorter,? please|^shorter\b|more concise|less wordy|cut it down|trim it( down)?|tl;?dr)\b/i
const LONGER = /\b(too short|too brief|(make|keep) (it|them|this) (longer|more detailed)|^longer\b|more detail(ed)?|expand on (it|this|that)|go deeper)\b/i
const CASUAL = /\b(too (formal|stiff|corporate|robotic)|(more|less) (casual|relaxed|friendly|conversational|formal|stiff)|make (it|them|this) (casual|friendlier|warmer|more casual|more friendly|less formal)|sounds? (too )?(robotic|stiff))\b/i
const FORMAL = /\b(too (casual|informal|chatty)|more (formal|professional)|less (casual|chatty|informal)|make (it|them|this) (more )?(formal|professional))\b/i

/** Two named alternatives in the user's words: "use X instead of Y", "X, not Y", "X rather than Y". */
function preferOver(s: string): { x: string; y: string } | null {
  const t = squash(s).replace(/^(no|nope|nah|actually|hmm+)[,.!\s]+/i, '')
  const word = '([\\w][\\w .+#/-]{0,38}?)'
  const pats: Array<[RegExp, 'xy' | 'yx']> = [
    [new RegExp(`\\b(?:use|go with|pick|choose|try|switch to|do)\\s+${word}\\s+instead of\\s+${word}(?=[.!,;?]|$)`, 'i'), 'xy'],
    [new RegExp(`\\b(?:use|go with|pick|choose|prefer|i prefer|i'?d rather|rather)\\s+${word}\\s+(?:rather than|over|not)\\s+${word}(?=[.!,;?]|$)`, 'i'), 'xy'],
    [new RegExp(`^(?:i said\\s+)?${word},?\\s+not\\s+${word}(?=[.!,;?]|$)`, 'i'), 'xy'],
    [new RegExp(`^not\\s+${word},\\s*(?:use\\s+)?${word}(?=[.!,;?]|$)`, 'i'), 'yx']
  ]
  for (const [rx, order] of pats) {
    const m = t.match(rx)
    if (!m) continue
    const [x, y] = order === 'xy' ? [m[1], m[2]] : [m[2], m[1]]
    const cx = strip(x).replace(/^(the|a|an)\s+/i, ''), cy = strip(y).replace(/^(the|a|an)\s+/i, '')
    if (!cx || !cy || words(cx).length > 4 || words(cy).length > 4 || normalizeText(cx) === normalizeText(cy)) continue
    if (/^(it|that|this|them|me|you|one)$/i.test(cx) || /^(it|that|this|them|me|you|one)$/i.test(cy)) continue
    return { x: cx, y: cy }
  }
  return null
}

/**
 * Decisions in a short message the user typed: a named preference over an alternative ("use Postgres
 * instead of MySQL"), a standing instruction ("never use em dashes", "from now on…"), and feedback on the
 * agent's draft ("too long", "make it more casual": only right after a reply). Long messages (pasted
 * text), permission grants ("don't ask before…"), addresses and secrets are left alone.
 */
export function decisionsFromCorrection(text: string, o: { afterReply?: boolean } = {}): UserDecision[] {
  const t = squash(text)
  if (!t || t.length > 300 || text.split('\n').filter((l) => l.trim()).length > 3 || /^[>"“]/.test(t)) return []
  const out: UserDecision[] = []
  const sentences = t.split(/(?<=[.!?])\s+/).slice(0, 3)
  for (const s of sentences) {
    const p = preferOver(s)
    if (p) { out.push({ context: `${cap(p.x)} or ${p.y}`, choice: p.x, over: [p.y], source: 'correction' }); continue }
    if (STANDING.test(s) && words(s).length >= 3 && words(s).length <= 40) {
      const sentence = strip(s.replace(/^(?:(?:and|also|ok(?:ay)?|please|pls|so|oh|btw|one more thing)[,\s]+)+/i, ''))
      out.push({ context: '', choice: sentence, source: 'correction' })
    }
  }
  if (o.afterReply && words(t).length <= 25) {
    if (SHORTER.test(t)) out.push({ context: 'Length of drafts and replies', choice: 'shorter and more concise', source: 'correction' })
    else if (LONGER.test(t)) out.push({ context: 'Length of drafts and replies', choice: 'longer, with more detail', source: 'correction' })
    if (FORMAL.test(t)) out.push({ context: 'Tone of drafts and replies', choice: 'more formal and professional', source: 'correction' })
    else if (CASUAL.test(t)) {
      const formalWanted = /\b(more formal|less casual)\b/i.test(t)
      out.push({ context: 'Tone of drafts and replies', choice: formalWanted ? 'more formal and professional' : 'more casual and friendly', source: 'correction' })
    }
  }
  return out.filter((d) => !decisionBlocked(d) && !hardStopText(d.choice) && !(looksInstructionLike(d.choice) && ACTION_ORDER.test(d.choice) && d.context === ''))
}

// ---------------------------------------------------------------- 4. approval patterns

export interface ApprovalKind {
  key: string
  /** "When the agent wants to send an email". */
  context: string
  /** What declining it usually means ("wants to review emails before they're sent"). */
  declined: string
  /** A money or credential action: an approval streak is never remembered (only declines are). */
  risky: boolean
}

const HOME = /^(?:~|\/Users\/[^/]+)(?=\/|$)/

/** The folder a path is in, as the user would say it ("~/Documents"). */
export function folderOf(path: string): string | null {
  const p = path.trim().replace(/\\/g, '/')
  if (!p || /^[a-z]+:\/\//i.test(p)) return null
  const home = p.match(HOME)
  if (home) {
    const seg = p.slice(home[0].length).split('/').filter(Boolean)
    return seg.length > 1 ? `~/${seg[0]}` : '~'
  }
  if (!p.startsWith('/')) return 'the workspace'
  const seg = p.split('/').filter(Boolean)
  return seg.length > 1 ? `/${seg.slice(0, Math.min(2, seg.length - 1)).join('/')}` : '/'
}

/** The kind of action an approval card was for, in words ("send an email", "save files in ~/Documents"). */
export function approvalKind(tool: string, args: Record<string, unknown> = {}, o: { label?: string; summary?: string } = {}): ApprovalKind | null {
  const action = typeof args.action === 'string' ? args.action.toLowerCase() : ''
  const hay = `${tool} ${action}`.toLowerCase().replace(/[_-]+/g, ' ')
  const stop = hardStopText(o.summary, tool, action) ?? ''
  const risky = /money|credential/.test(stop)
  if (/\b(mail|gmail|outlook|email|e mail)\b/.test(hay) && /\b(send|reply|forward|send draft)\b/.test(hay)) {
    return { key: 'email.send', context: 'When the agent wants to send an email', declined: 'wants to review emails before they\'re sent', risky }
  }
  if (/\b(slack|imessage|messages|sms|whatsapp|telegram|discord|teams|message)\b/.test(hay) && /\b(send|post|reply)\b/.test(hay)) {
    return { key: 'message.send', context: 'When the agent wants to send a message (Slack, Messages…)', declined: 'wants to review messages before they\'re sent', risky }
  }
  if (/\b(tweet|publish|post)\b/.test(hay)) return { key: 'post.publish', context: 'When the agent wants to post or publish something', declined: 'wants to review posts before they go out', risky }
  if (/\b(calendar|event|invite)\b/.test(hay) && /\b(create|add|update|invite|schedule|edit)\b/.test(hay)) {
    return { key: 'calendar.write', context: 'When the agent wants to add or change calendar events', declined: 'wants to review calendar changes first', risky }
  }
  const path = [args.path, args.to, args.dest, args.destination, args.file, args.out, args.output].find((v): v is string => typeof v === 'string' && !!v.trim())
  if ((tool === 'file_manage' && /delete|trash|remove/.test(action)) || /\b(delete|trash|remove)\b/.test(hay) && /\bfile/.test(hay)) {
    return { key: 'file.delete', context: 'When the agent wants to delete files', declined: 'wants to delete files themselves, or review first', risky }
  }
  if (/^(file_write|file_manage|create_document|file_edit|doc_export)$/.test(tool) && path) {
    const dir = folderOf(path)
    if (dir) return { key: `file.write:${dir}`, context: `When the agent wants to save files in ${dir}`, declined: `doesn't want files saved in ${dir} without asking`, risky }
  }
  if (tool === 'run_command' && typeof args.command === 'string') {
    const first = args.command.trim().split(/\s+/)[0]?.replace(/^.*\//, '') ?? ''
    if (/^[\w.-]{1,24}$/.test(first)) return { key: `command:${first}`, context: `When the agent wants to run \`${first}\` commands in Terminal`, declined: `wants to run \`${first}\` commands themselves, or review first`, risky }
  }
  if (!/^[\w.:-]{1,64}$/.test(tool)) return null
  const what = `${o.label && o.label.length <= 40 ? o.label : tool}${action && /^[\w -]{1,24}$/.test(action) ? ` (${action})` : ''}`
  return { key: `tool:${tool}${action ? `.${action}` : ''}`, context: `When the agent wants to use ${what}`, declined: 'wants to review this kind of action first', risky }
}

/** The decision a streak of the same answer makes ("usually declines; wants to review emails first (declined 3 times in a row)"). */
export function approvalDecision(k: ApprovalKind, allowed: boolean, streak: number): UserDecision {
  const tally = `${allowed ? 'approved' : 'declined'} ${streak} times in a row`
  return { context: k.context, choice: allowed ? `usually approves (${tally})` : `usually declines; ${k.declined} (${tally})`, source: 'approval' }
}

// ---------------------------------------------------------------- saving (one per topic, newest wins)

/** What saveDecision needs from the memory store (MemoryStore has it all). */
export interface DecisionMemory {
  readonly enabled?: boolean
  list(spaceId?: string | null): Memory[]
  save(content: string, category: string, spaceId: string | null, source?: MemorySource, provenance?: MemoryProvenance): { memory: Memory; replaced?: string }
  update(id: string, content: string, patch?: { category?: string }): Memory | undefined
}

/**
 * Saves a decision as a 'decision' memory in `spaceId` (null = shared). The same topic decided again
 * updates that memory in place (an "(earlier: …)" note keeps the previous choice when it changed). Returns
 * null when it may not be saved: memory or automatic memory is off, it isn't the user's own (untrusted),
 * or it holds a secret, an address or a permission grant.
 */
export function saveDecision(mem: DecisionMemory, d: UserDecision, spaceId: string | null, o: { provenance?: MemoryProvenance; source?: MemorySource; auto?: boolean; secretValues?: string[] } = {}): { memory: Memory; superseded?: string; refreshed?: boolean } | null {
  if (o.provenance === 'untrusted' || mem.enabled === false || o.auto === false) return null
  if (decisionBlocked(d, o.secretValues)) return null
  const text = decisionText(d)
  const peers = mem.list(spaceId).filter((m) => m.spaceId === spaceId && m.category === 'decision' && m.provenance !== 'untrusted')
  const same = peers.find((m) => normalizeText(m.content) === normalizeText(text) || similar(m.content, text))
  if (d.context.trim()) {
    const prior = peers.filter((m) => { const p = parseDecision(m.content); return !!p && sameTopic(p, d) }).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (prior) {
      const p = parseDecision(prior.content)!
      const changed = normalizeText(p.choice) !== normalizeText(d.choice)
      // Changed its mind: the old choice stays as a short note; the same choice again: just refreshed.
      const earlier = changed ? p.choice : p.earlier
      const next = earlier && normalizeText(earlier) !== normalizeText(d.choice) ? `${text} (earlier: ${clip(earlier, 60)})` : text
      const m = mem.update(prior.id, next, { category: 'decision' })
      return m ? { memory: m, ...(changed ? { superseded: prior.content } : { refreshed: true }) } : null
    }
  }
  if (same) {
    const m = mem.update(same.id, text, { category: 'decision' })
    return m ? { memory: m, refreshed: true } : null
  }
  const r = mem.save(text, 'decision', spaceId, o.source ?? 'chat', 'trusted')
  return { memory: r.memory, ...(r.replaced && r.replaced !== r.memory.content ? { superseded: r.replaced } : {}) }
}
