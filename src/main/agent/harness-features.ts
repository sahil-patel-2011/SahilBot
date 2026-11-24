// The agent loop's harness features: what the runtime does around the model, beyond running its tool calls.
// All on in SahilBot. The harness benchmark (tests/unit/harness-bench.test.ts) also runs the same loop with
// some switched off, as behavior profiles of other agent harnesses. A profile is an approximation from each
// product's public documentation or open source (sources below); it is SahilBot's loop with features
// removed, not the other product.

export interface HarnessFeatures {
  /** A reply that announces an action with no tool call ("Publishing it now") gets made to do it (from Grok Build, Apache-2.0). */
  announceNudge: boolean
  /** A reply that stops to ask permission for its own next step ("Want me to…?") is told to go on. */
  continueNudge: boolean
  /** A reply that says something was done ("I've saved it") when nothing in the run changed anything is challenged. */
  falseClaimNudge: boolean
  /** The same step again and again: a nudge, then a stop (from Grok Build, Apache-2.0). */
  pollingGuard: boolean
  /** A repeated status check whose result says "still running" gets the wait-once nudge on the second check. */
  pendingPollNudge: boolean
  /** Code changed: the project's tests run before the answer is accepted (failures go back to the model). */
  testsAtEnd: boolean
  /** Code changed: the project's tests run right after the edit step (fast suites), so the next step sees them. */
  testsAfterEdit: boolean
  /** Tools can wait for the user to do something on a page (sign in, enter a code) instead of stopping to ask. */
  waitForUser: boolean
  /** A read that fails for a temporary reason (network, 5xx, timeout) is retried once by the runtime. */
  toolRetry: boolean
  /** The agent is reminded to write and update its plan. */
  planReminders: boolean
  /** A reply that gives up after a tool failed ("I couldn't get it") is sent to try another way first. */
  giveUpNudge: boolean
  /** A write whose result was uncertain (a timeout) isn't repeated, nor offered to the user to approve again, until the state is checked. */
  noBlindRepeat: boolean
  /** "I don't have access to your files" with no attempt at all: it's sent to try the tools it has first. */
  cantNudge: boolean
  /** A limit the user stated ("under $200") is checked against what the agent chose. */
  constraintCheck: boolean
  /** An answer given from page 1 of a paged result is sent back for the rest. */
  paginationCheck: boolean
  /** A medical answer's citations are checked against what was retrieved and against PubMed (exists, not retracted); a clinical answer needs research. */
  medicalCheck: boolean
  /** A run that's still making progress when its step budget runs out keeps going instead of asking the user to say "continue". */
  autoContinue: boolean
  /** Personal and health details are checked on this Mac before a cloud request (PII-Tracer) and kept local or replaced by stand-ins. */
  privacyGate: boolean
}

export const ALL_FEATURES: HarnessFeatures = {
  announceNudge: true, continueNudge: true, falseClaimNudge: true, pollingGuard: true, pendingPollNudge: true,
  testsAtEnd: true, testsAfterEdit: true, waitForUser: true, toolRetry: true, planReminders: true, giveUpNudge: true, noBlindRepeat: true, cantNudge: true, constraintCheck: true, paginationCheck: true, medicalCheck: true, autoContinue: true, privacyGate: true
}

const NONE: HarnessFeatures = Object.fromEntries(Object.keys(ALL_FEATURES).map((k) => [k, false])) as unknown as HarnessFeatures

/**
 * Feature-ablation profiles for the benchmark: SahilBot's own loop with runtime features switched off, roughly
 * where each product has no equivalent built in. They keep SahilBot's approvals, injection defenses, plan
 * check and verification, and model nothing the products do differently (Claude Code's user-configured hooks,
 * Codex's sandbox and retries of model errors, a chat agent's takeover UI). Not the products themselves:
 * - claude-code: the loop runs tools until the model ends its turn with text; tool errors go back to the model;
 *   no runtime nudges or test runs (the model runs tests when it decides to); TodoWrite with reminders.
 *   Source: code.claude.com/docs (how Claude Code works, hooks are user-configured).
 * - codex-cli: the turn ends when the model replies; approvals policy decides what runs; plan tool; no
 *   runtime nudges, retries of tool calls or automatic test runs. Source: github.com/openai/codex (Apache-2.0).
 * - grok-build: the turn loop's task discipline (announced-but-not-done) and polling-loop detection; no
 *   automatic tests. Source: github.com/xai-org/grok-build (Apache-2.0).
 * - chat-agent: a consumer chat agent (ChatGPT agent mode, the Grok app): asks before continuing, hands the
 *   browser to the user at sign-ins, no runtime nudges or test runs. Source: their public help pages.
 */
export const PROFILES: Record<'sahilbot' | 'claude-code' | 'codex-cli' | 'grok-build' | 'chat-agent', HarnessFeatures> = {
  sahilbot: ALL_FEATURES,
  'claude-code': { ...NONE, planReminders: true },
  'codex-cli': { ...NONE, planReminders: true },
  'grok-build': { ...NONE, announceNudge: true, pollingGuard: true, planReminders: true },
  // Takeover at sign-ins: the user signs in, the agent carries on.
  'chat-agent': { ...NONE, waitForUser: true }
}

/** Curly apostrophes and quotes ("I’ve sent it", which models often write) read like straight ones. */
export const straight = (t: string): string => (t ?? '').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"')

/** "I've saved it", "It's been sent", "Done: created the event": a reply saying an action happened. */
/** Tools that look at the work (for "I checked / verified / tested it"). */
const LOOKS = ['read', 'fetch', 'browser', 'search', 'run_tests', 'run_command', 'code', 'review', 'agent_control', 'screenshot', 'computer', 'list', 'file_info', 'open_file', 'snapshot', 'get', 'grep', 'glob']
/** Tool-name stems that do what a claimed verb says ("published" ↔ publish_post, "it's live" ↔ deploy). */
const CLAIM_STEMS: Record<string, string[]> = {
  saved: ['save', 'write', 'create', 'note', 'edit', 'export', 'memory'], sent: ['send', 'email', 'mail', 'message', 'reply', 'post'], emailed: ['email', 'send', 'mail'],
  published: ['publish', 'post', 'deploy', 'release'], posted: ['post', 'publish', 'send'], deployed: ['deploy', 'publish', 'release'],
  uploaded: ['upload', 'put', 'save'], booked: ['book', 'reserve'], scheduled: ['schedule', 'create_event', 'calendar'], rescheduled: ['schedule', 'update', 'calendar', 'event'],
  deleted: ['delete', 'remove', 'trash', 'file_manage', 'manage_bot', 'schedule'], removed: ['remove', 'delete', 'trash', 'file_manage', 'manage_bot', 'schedule'], filed: ['file', 'create', 'submit'],
  submitted: ['submit', 'send', 'post'], shared: ['share', 'send'], moved: ['move', 'rename', 'file_manage', 'schedule', 'update_bot', 'manage_bot'], renamed: ['rename', 'move', 'file_manage', 'update_bot', 'manage_bot'],
  installed: ['install'], ordered: ['order', 'buy', 'purchase'], paid: ['pay', 'purchase'], replied: ['reply', 'send'],
  messaged: ['message', 'send'], texted: ['text', 'send', 'message'], live: ['publish', 'deploy', 'post', 'launch', 'release'],
  created: ['create', 'write', 'save', 'make', 'new', 'add', 'export', 'schedule', 'file_manage'], wrote: ['write', 'save', 'create', 'edit'], written: ['write', 'save', 'create', 'edit'],
  added: ['add', 'create', 'write', 'edit', 'update', 'insert', 'append', 'schedule', 'memory'], updated: ['update', 'edit', 'write', 'set', 'patch', 'modify', 'save', 'schedule', 'manage_bot'],
  fixed: ['edit', 'write', 'patch', 'fix', 'apply', 'update', 'schedule'], cancelled: ['cancel', 'delete', 'remove', 'update', 'schedule'], canceled: ['cancel', 'delete', 'remove', 'update', 'schedule'],
  downloaded: ['download', 'fetch', 'save', 'export'], copied: ['copy', 'write', 'save', 'duplicate', 'file_manage'],
  completed: ['complete', 'submit', 'update', 'todo'],
  // "I checked the link", "I tested it": something that looks (a read, a page, a test run, the screen) backs it.
  verified: LOOKS, checked: LOOKS, tested: LOOKS, confirmed: LOOKS, 'double-checked': LOOKS,
  'signed in': ['sign', 'login', 'log_in', 'auth', 'browser'], 'logged in': ['login', 'log_in', 'sign', 'auth', 'browser']
}

// Verbs for actions in the world (not "I've written a summary below", which is the reply itself).
const VERBS = '(saved|sent|emailed|published|posted|deployed|uploaded|booked|scheduled|rescheduled|deleted|removed|filed|submitted|shared|moved|renamed|installed|ordered|paid|replied|messaged|texted|cancell?ed|canceled|downloaded|signed in|logged in)'
// Checking verbs: "I've verified the totals", "I tested it on three photos" (said of itself only).
const CHECKS = '(verified|checked|tested|confirmed|double-checked)'
// Verbs that also describe the reply itself ("I've added a section below", "I wrote a short poem"): a claim only when
// the sentence names something concrete in the world (a file, a path, an event, an order…).
const TARGETED = '(created|wrote|written|added|updated|fixed|copied|completed)'
const TARGET = /\b[\w-]+\.(pdf|docx?|xlsx|csv|txt|md|py|js|ts|tsx|json|html?|pptx|key|numbers|pages|png|jpe?g|zip|ics|sh|rb|go|swift)\b|~\/|\/Users\/|\b(file|folder|document|spreadsheet|workbook|calendar|event|reminder|contact|repo|repository|branch|pull request|account|order|subscription|booking|reservation|invoice|app|website|site|playlist|ticket|issue)s?\b/i
const claimRe = (verbs: string): RegExp => new RegExp(`\\b(i('ve| have)?|we('ve| have)?)\\s+(just\\s+|now\\s+|already\\s+)?${verbs}\\b|\\b(it'?s|has|have|was|were)\\s+(now\\s+)?been\\s+${verbs}\\b`, 'i')
const CLAIM = new RegExp(`${claimRe(VERBS).source}|${claimRe(CHECKS).source}|\\b(it'?s|it is|they'?re|they are)\\s+(now\\s+)?(live|saved|sent|published|posted|booked|scheduled|deployed)\\b`, 'i')
// Terse forms: "The meeting is booked for 3pm.", "Your email is sent.", "Saved to ~/Downloads.", "Invoice sent." (Not in a
// sentence about what would or will happen: "Dry run: I would email them that the invoice is paid.")
const TERSE = new RegExp(`\\b(the|your|that|this)\\s+(\\w+\\s+){1,3}(is|are|has been|have been)\\s+(now\\s+|all\\s+)?${VERBS}\\b`
  + `|^\\s*(done[,.:!]?\\s*|all\\s+)?${VERBS}(\\s+(to|for|at|in|on|as|into|from|with|it|them|the|your|all|both|and)\\b|\\s+[\\w-]+\\.[a-z]{2,5}\\b|\\s+~?\\/|\\s*[.!:,]|\\s*$)`
  + `|^\\s*[\\w-]+(\\s+[\\w-]+){0,2}\\s+${VERBS}\\s*[.!]?\\s*$`, 'i')
const CLAIM_TARGETED = claimRe(TARGETED)
const MODAL = /\b(would|will|won'?t|could|might|should|going to|i'?d|i'?ll|once|when|if)\b/i
// Judged sentence by sentence: "I've saved it. Nothing was deleted." is a claim; "Nothing has been sent yet" isn't.
const NEGATED = new RegExp(`\\b(not|never|nothing|n't|yet to|unable|couldn'?t|wasn'?t)\\b[^.!?]{0,30}(${VERBS.slice(1, -1)}|${TARGETED.slice(1, -1)}|${CHECKS.slice(1, -1)})`, 'i')

/** The verbs a reply claims as done, sentence by sentence (a long reply: its first and last 1,500 characters). */
function claimedVerbs(text: string): string[] {
  let t = straight(text).trim()
  if (!t) return []
  if (t.length > 3000) t = `${t.slice(0, 1500)}\n${t.slice(-1500)}`
  const out = new Set<string>()
  for (const sentence of t.split(/(?<=[.!?])\s+|\n+/)) {
    const plain = CLAIM.test(sentence) || (TERSE.test(sentence) && !MODAL.test(sentence)), targeted = CLAIM_TARGETED.test(sentence) && TARGET.test(sentence)
    if ((!plain && !targeted) || NEGATED.test(sentence)) continue
    // Not a claim about this run: a question, a conditional, a quote of the past ("you already saved…").
    if (/\?\s*$/.test(sentence) || /\b(if you|once you|when you|you('ve| have)? (already )?(saved|sent|created))\b/i.test(sentence)) continue
    const low = sentence.toLowerCase()
    for (const v of Object.keys(CLAIM_STEMS)) if (new RegExp(`\\b${v}\\b`).test(low)) out.add(v)
  }
  return [...out]
}

/**
 * A "done" claim that a successful tool of this run backs by its name: "Published at …" after publish_post, even
 * when a connector labels that tool read-only (many do). Every verb the reply claims needs a matching tool.
 */
export function claimBacked(text: string, okTools: string[]): boolean {
  const claimed = claimedVerbs(text)
  if (!claimed.length || !okTools.length) return false
  // A short stem ("get", "read", "post") must be a whole word of the name (getIssue, read_file, posts), never a piece
  // of another word (budget_*, thread_*, postgres); a long one ("publish", "file_manage") may sit anywhere in it.
  const tools = okTools.map((n) => ({ n: n.toLowerCase(), parts: n.split(/__|[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).map((x) => x.toLowerCase()).filter(Boolean) }))
  const fits = (stem: string, t: { n: string; parts: string[] }): boolean => stem.length >= 5
    ? t.parts.some((part) => part.startsWith(stem)) || t.n.includes(stem)
    : t.parts.some((part) => part.startsWith(stem) && /^(s|es|ed|ing|er|ers)?$/.test(part.slice(stem.length)))
  return claimed.every((v) => CLAIM_STEMS[v].some((stem) => tools.some((t) => fits(stem, t))))
}

const CHECK_VERBS = new Set(['verified', 'checked', 'tested', 'confirmed', 'double-checked'])
/** Every "done" the reply claims is a check ("I've double-checked the math"), not an action in the world. */
export function claimsOnlyChecks(text: string): boolean {
  const v = claimedVerbs(text)
  return v.length > 0 && v.every((x) => CHECK_VERBS.has(x))
}

/** The reply claims something went out (sent, posted, booked, paid…): a general tool backs it only by doing that. */
export function claimsOutward(text: string): boolean {
  return claimedVerbs(text).some((v) => OUTWARD.has(v))
}
const OUTWARD = new Set(['sent', 'emailed', 'published', 'posted', 'booked', 'ordered', 'paid', 'replied', 'messaged', 'texted', 'submitted', 'shared'])

export function claimsDone(text: string): boolean {
  return claimedVerbs(text).length > 0
}

/**
 * The reply ends on a question for the user ("Which date works, Friday or Saturday?", "What's the address?"): their
 * answer is what comes next, so the run ends there. A closing "Anything else?" or "Let me know…?" isn't one.
 */
export function asksUserNow(text: string): boolean {
  const t = straight(text).trim()
  if (!/\?\s*(\([^)]*\))?\s*$/.test(t)) return false
  const last = t.split(/(?<=[.!])\s+|\n+/).pop() ?? t
  return !/\b(anything else|something else|any(thing)? more|any (other )?questions|need anything|help with anything|other (way|thing)s? i can|let me know|sound good|make sense|how does (that|this) (look|sound))\b/i.test(last)
}

/** "I couldn't get the churn rate: the report doesn't exist." A reply that gives up on the task. */
export function givesUp(text: string): boolean {
  const t = straight(text).trim()
  if (!t || t.length > 2000) return false
  // "I couldn't get the report", not "I couldn't find a slot Tuesday, but Wednesday works".
  const m = /\b(i (couldn'?t|could not|wasn'?t able to|was not able to|was unable to|am unable to|'m unable to)|unable to|(failed|failing) to)\s+(get|find|access|load|open|reach|complete|retrieve|fetch|pull|download|send|log ?in|sign ?in|connect|create|book|run|verify|finish|submit|upload|save|install)\b[^.!?]*/i.exec(t)
  return !!m && !/\b(but|however|instead|so here'?s|here'?s)\b/i.test(m[0] + t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 60))
}

const money = (t: string): number => Number(t.replace(/[,$\s]/g, ''))

/**
 * The user's price limit ("under $200", "no more than $1,500", "max 80 dollars") against what was chosen: an
 * item the results priced over the limit that the reply names or a write's arguments mention.
 */
export function overLimit(userText: string, reply: string, toolText: string, writeArgs: string): { limitText: string; item: string; priceText: string } | undefined {
  userText = straight(userText)
  const m = /\b(under|below|less than|no more than|at most|max(?:imum)?|cheaper than|within|up to|budget(?: of| is)?)\s*(?:a |an )?\$\s?([\d,]+(?:\.\d+)?)|\b(under|below|less than|no more than|at most|max(?:imum)?|up to)\s*([\d,]+(?:\.\d+)?)\s*(?:dollars|usd)\b/i.exec(userText)
  if (!m) return undefined
  const limitRaw = m[2] ?? m[4]
  // "$2k", "$1.5m": not parsed here, so not checked (better silent than wrong).
  if (new RegExp(`${limitRaw.replace(/[.$]/g, '\\$&')}\\s*(k|m|mm|b|bn|thousand|million|billion|grand)\\b`, 'i').test(userText)) return undefined
  const limit = money(limitRaw)
  if (!(limit > 0)) return undefined
  const STOP = /^(price|prices|total|subtotal|shipping|tax|taxes|fee|fees|was|now|save|from|per|cost|costs|amount|balance|starting at|only)$/i
  const args = writeArgs.toLowerCase()
  const said = reply.toLowerCase()
  for (const line of toolText.split('\n')) {
    const p = /^\W*([A-Za-z][^$\n]{2,60}?)\s*[-–:,(]?\s*\$\s?([\d,]+(?:\.\d+)?)/.exec(line)
    if (!p) continue
    const price = money(p[2])
    const name = p[1].replace(/[\s,:–-]+$/, '').trim()
    // Totals, fees and estimates aren't something chosen ("Order total: $75", "Shipping estimate $12").
    if (!(price > limit) || name.length < 4 || STOP.test(name) || /\b(total|subtotal|fee|fees|tax|taxes|shipping|estimate|revenue|budget|balance|savings?)$/i.test(name)) continue
    const n = name.toLowerCase()
    // Chosen: in what a write did, or named in the reply without being set aside ("skipped X, it's over budget").
    const i = said.indexOf(n)
    const near = i >= 0 ? said.slice(Math.max(0, i - 45), i + n.length + 45) : ''
    const setAside = /\b(skipp|exclud|over (your|the)? ?budget|above|instead of|not |avoid|too expensive|ruled out|left out|didn'?t)/.test(near)
    if (args.includes(n) || (i >= 0 && !setAside)) return { limitText: `${m[1] ?? m[3]} $${limitRaw}`, item: name, priceText: `$${p[2]}` }
  }
  return undefined
}

/** A count the user set for the reply ("exactly 150 words", "under 280 characters", "3 bullet points"). */
type CountAsk = { n: number; unit: 'words' | 'characters' | 'bullets'; exact: boolean }
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
export function countAsk(ask: string): CountAsk | undefined {
  const t = straight(ask).toLowerCase()
  const max = /\b(?:under|fewer than|less than|at most|no more than|max(?:imum)?(?: of)?|within|up to)\s+(\d[\d,]*)\s*(words|characters|chars)\b|\b(\d[\d,]*)\s*(words|characters|chars) or (?:less|fewer)\b/.exec(t)
  if (max) return { n: Number((max[1] ?? max[3]).replace(/,/g, '')), unit: /^w/.test(max[2] ?? max[4]) ? 'words' : 'characters', exact: false }
  const exact = /\bexactly\s+(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten)\s*(words|characters|chars|bullets?|bullet points)\b/.exec(t)
  if (exact) { const n = NUM[exact[1]] ?? Number(exact[1].replace(/,/g, '')); return { n, unit: /^w/.test(exact[2]) ? 'words' : /^c/.test(exact[2]) ? 'characters' : 'bullets', exact: true } }
  const bullets = /\b(\d|one|two|three|four|five|six|seven|eight|nine|ten)\s+bullet(?:s| points)\b/.exec(t)
  if (bullets) return { n: NUM[bullets[1]] ?? Number(bullets[1]), unit: 'bullets', exact: true }
  return undefined
}

/** The reply's count against the user's: a note for one rewrite when it's off, else undefined. Markdown markers don't count. */
export function countMiss(ask: string, reply: string): string | undefined {
  const c = countAsk(ask)
  if (!c || !(c.n > 0)) return undefined
  const text = reply.trim()
  const plain = text.replace(/[*_`#>]+/g, '').replace(/^\s*[-•]\s+/gm, '')
  const got = c.unit === 'words' ? plain.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
    : c.unit === 'characters' ? [...text].length
      : text.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length
  if (c.exact ? got === c.n : got <= c.n) return undefined
  return `[From the app] Your reply has ${got} ${c.unit}; the user asked for ${c.exact ? 'exactly' : 'at most'} ${c.n}. Rewrite it to fit, and output only the rewritten reply.`
}

/** "page 1 of 3", "next_cursor=p2", "has_more: true", "more results": the result has more pages. */
export function morePages(toolText: string): string | undefined {
  const t = toolText.slice(-4000)
  const page = /\bpage (\d+) of (\d+)\b/i.exec(t)
  if (page && Number(page[1]) < Number(page[2])) return page[0]
  const cursor = /\b(next_cursor|next_page_token|nextPageToken|next_page)["']?\s*[:=]\s*["']?(?!null\b|none\b|undefined\b|false\b|0\b|["',}\s])([\w-]+)/i.exec(t)
  if (cursor) {
    // "next_page": 1 with "total_pages": 1 is the last page.
    const total = /\b(total_pages|totalPages|page_count)["']?\s*[:=]\s*(\d+)/i.exec(t)
    if (!(/^\d+$/.test(cursor[2]) && total && Number(cursor[2]) > Number(total[2]))) return cursor[0]
  }
  const more = /\b(has_more|hasMore|more_results)["']?\s*[:=]\s*true\b|\bmore results (are )?available\b/i.exec(t)
  return more?.[0]
}

/**
 * "I don't have access to your Mac", "I can't browse the web", "I'm not able to open that file": a claim it
 * can't, about access or ability, not a refusal on safety grounds ("I can't help with that" is left alone).
 */
export function claimsCant(text: string): boolean {
  const t = straight(text).trim()
  if (!t || t.length > 2500) return false
  return /\b(i (don'?t|do not) have (the )?(ability|access|a way|permission|tools?)|i\s?(can'?t|cannot|am not able to|'m not able to|am unable to|'m unable to) (access|browse|open|see|view|read|reach|control|run|check|look at|search|get into|log ?in|send|use)|i have no (way|access|ability)|(beyond|outside) (my|of my) (capabilities|abilities|reach)|as an ai,? i (can'?t|cannot|don'?t))\b/i.test(t)
}
