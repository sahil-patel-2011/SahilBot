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
}

export const ALL_FEATURES: HarnessFeatures = {
  announceNudge: true, continueNudge: true, falseClaimNudge: true, pollingGuard: true, pendingPollNudge: true,
  testsAtEnd: true, testsAfterEdit: true, waitForUser: true, toolRetry: true, planReminders: true, giveUpNudge: true, noBlindRepeat: true, cantNudge: true, constraintCheck: true, paginationCheck: true, medicalCheck: true, autoContinue: true
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
export function claimsDone(text: string): boolean {
  const t = straight(text).trim()
  if (!t || t.length > 1500) return false
  // Verbs for actions in the world (not "I've written a summary below", which is the reply itself).
  const verbs = '(saved|sent|emailed|published|posted|deployed|uploaded|booked|scheduled|deleted|removed|filed|submitted|shared|moved|renamed|installed|ordered|paid|replied|messaged|texted)'
  const claim = new RegExp(`\\b(i('ve| have)?|we('ve| have)?)\\s+(just\\s+|now\\s+|already\\s+)?${verbs}\\b|\\b(it'?s|has|have|was|were)\\s+(now\\s+)?been\\s+${verbs}\\b|\\b(it'?s|it is|they'?re|they are)\\s+(now\\s+)?(live|saved|sent|published|posted|booked|scheduled|deployed)\\b`, 'i')
  // Judged sentence by sentence: "I've saved it. Nothing was deleted." is a claim; "Nothing has been sent yet" isn't.
  const negated = new RegExp(`\\b(not|never|nothing|n't|yet to|unable|couldn'?t|wasn'?t)\\b[^.!?]{0,30}${verbs}`, 'i')
  for (const sentence of t.split(/(?<=[.!?])\s+/)) {
    if (!claim.test(sentence) || negated.test(sentence)) continue
    // Not a claim about this run: a question, a conditional, a quote of the past ("you already saved…").
    if (/\?\s*$/.test(sentence) || /\b(if you|once you|when you|you('ve| have)? (already )?(saved|sent|created))\b/i.test(sentence)) continue
    return true
  }
  return false
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
