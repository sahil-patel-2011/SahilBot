// Recall by meaning, not just by the same words: "email my boss" should find "Manager at work is Dana…",
// "near my place" the home address, "retirement money" the 401k. No model call, so it runs on every
// request: a small map of everyday concepts and a few request kinds that always need one kind of fact (the
// weather needs where the user lives; food needs their allergies and diet). Used to rank memories
// (memory.ts), to search the user's other chats (db.ts recallUserSaid) and to search memory (memory-system.ts).
//
// Matching is one-sided on purpose. A saved fact is about the user's life, so its plain words count
// ("Manager at work…"). A request is often not about the user at all ("report to the committee", "what is a
// home page", "heart rate zones"), so only phrases that point at the user's own world trigger a concept
// ("my boss", "our place", "the dog"). Short or ambiguous words (sat, sun, class, rate, number) aren't used.

/** Same as memory.ts normalizeText (kept here so the two modules don't import each other). */
const normalizeText = (s: string): string => s.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** One everyday concept: the phrases a request uses for it (`ask`), and the words a saved fact uses (`fact`). */
export interface Concept { ask: string[]; fact: string[] }

export const CONCEPTS: Concept[] = [
  { ask: ['my boss', 'the boss', 'my manager', 'my supervisor', 'my team lead', 'my line manager', 'my skip level', 'person i report to', 'i report to'], fact: ['boss', 'manager', 'supervisor', 'team lead', 'reports to', 'report to'] },
  { ask: ['my landlord', 'our landlord', 'the landlord', 'landlady', 'property manager', 'property management', 'owns our building', 'owns the building', 'building owner', 'owner of our building', 'our building', 'my rent', 'our rent', 'my lease', 'our lease', 'leasing office'], fact: ['landlord', 'landlady', 'property manager', 'property management', 'rents us', 'rents me', 'rent', 'lease'] },
  { ask: ['my wife', 'my husband', 'my spouse', 'my partner', 'the wife', 'the husband', 'the missus', 'my missus', 'the mrs', 'wifey', 'hubby', 'my hubby', 'other half', 'better half'], fact: ['wife', 'husband', 'spouse', 'partner', 'married to'] },
  { ask: ['my son', 'my daughter', 'my kid', 'my kids', 'the kid', 'the kids', 'our kid', 'our kids', 'our son', 'our daughter', 'kiddo', 'my kiddo', 'my child', 'my children', 'little one'], fact: ['son', 'daughter', 'kid', 'kids', 'child', 'children'] },
  { ask: ['my mom', 'my mother', 'my mum', 'mum', 'mama', 'mommy'], fact: ['mom', 'mother', 'mum'] },
  { ask: ['my dad', 'my father', 'papa', 'daddy', 'my pops'], fact: ['dad', 'father'] },
  { ask: ['my brother', 'my sister', 'my sibling', 'my bro', 'my sis', 'my brothers', 'my sisters'], fact: ['brother', 'sister', 'sibling'] },
  { ask: ['homeroom', 'his teacher', 'her teacher', 'their teacher', 'his school', 'her school', 'their school', 'kids school', 'kid school', 'school pickup', 'from school', 'at school', 'to school', 'what grade'], fact: ['school', 'teacher', 'elementary', 'grade', 'homeroom'] },
  { ask: ['dentist', 'dental', 'my teeth', 'tooth doctor', 'teeth cleaning', 'orthodontist'], fact: ['dentist', 'dental', 'orthodontist'] },
  { ask: ['my doctor', 'my physician', 'my pcp', 'my gp'], fact: ['doctor', 'physician', 'pcp'] },
  { ask: ['my dog', 'the dog', 'our dog', 'my cat', 'the cat', 'our cat', 'my pup', 'the pup', 'pup', 'puppy', 'doggo', 'pooch', 'kitty', 'the vet', 'a vet', 'vet', 'veterinarian', 'my pet', 'our pet'], fact: ['dog', 'cat', 'vet', 'veterinarian', 'animal clinic', 'animal hospital', 'puppy', 'pet'] },
  { ask: ['my car', 'our car', 'the car', 'oil change', 'my vehicle', 'the vehicle', 'other vehicle', 'my mechanic', 'license plate', 'my plate', 'car registration'], fact: ['car', 'vehicle', 'plate', 'registration'] },
  { ask: ['flight', 'flights', 'fly', 'flying', 'airline', 'airlines', 'plane ticket', 'aisle seat', 'window seat', 'airport'], fact: ['flight', 'airline', 'airlines', 'aisle', 'airport', 'mileage plan'] },
  { ask: ['hotel', 'staying at', 'where are we staying', 'lodging', 'airbnb', 'accommodation'], fact: ['hotel', 'staying at', 'airbnb', 'lodging'] },
  { ask: ['my retirement', 'our retirement', 'retirement money', 'retirement savings', 'retirement account', 'my 401k', 'our 401k', 'my ira', 'my roth', 'my pension', 'my brokerage', 'my investments'], fact: ['401k', 'ira', 'roth', 'pension', 'brokerage', 'retirement'] },
  { ask: ['my savings', 'savings account', 'my bank', 'our bank', 'checking account'], fact: ['savings', 'bank', 'checking'] },
  { ask: ['contractor', 'builder', 'builders', 'quote', 'quotes', 'bid', 'bids', 'remodel', 'renovation'], fact: ['contractor', 'builder', 'builders', 'quote', 'quotes', 'bid', 'remodel', 'renovation'] },
  { ask: ['charge', 'my rate', 'hourly rate', 'my fee', 'priciest', 'cheapest', 'how much do i charge', 'how much should i charge', 'what do i charge'], fact: ['rate', 'fee', 'price', 'per hour', 'hourly', '$'] },
  { ask: ['invoice', 'invoices', 'invoicing', 'bill them', 'billing', 'accounts payable', 'payment from', 'pay me', 'get paid', 'net 30'], fact: ['invoice', 'invoices', 'billing', 'accounts payable', 'ap', 'pays', 'paid', 'net 30'] },
  { ask: ['my client', 'the client', 'that client', 'our client', 'my customer'], fact: ['client', 'customer'] },
  { ask: ['coffee', 'latte', 'flat white', 'espresso', 'cappuccino', 'cafe'], fact: ['coffee', 'latte', 'flat white', 'espresso', 'cappuccino'] },
  { ask: ['gym', 'my workout', 'my session', 'my exercise'], fact: ['gym', 'workout', 'fitness'] },
  { ask: ['wifi', 'wi fi', 'router', 'my network', 'my internet', 'home network'], fact: ['wifi', 'wi fi', 'router', 'network'] },
  { ask: ['weekly report', 'status report', 'weekly update', 'weekly summary'], fact: ['weekly report', 'status report', 'weekly update'] },
  { ask: ['anniversary', 'wedding anniversary'], fact: ['anniversary', 'wedding'] },
  { ask: ['birthday', 'bday', 'b day'], fact: ['birthday', 'bday', 'born'] },
  { ask: ['allergy', 'allergic', 'allergies'], fact: ['allergy', 'allergic', 'allergies', 'intolerant'] },
  { ask: ['my place', 'our place', 'my house', 'our house', 'my home', 'our home', 'my apartment', 'our apartment', 'my address', 'our address', 'home address', 'where i live', 'where we live'], fact: ['home address', 'address', 'apartment'] },
  { ask: ['phone number', 'cell number', 'mobile number', 'my cell', 'his number', 'her number', 'their number', 'the number for'], fact: ['phone', 'cell', 'mobile'] },
  { ask: ['monday', 'mondays'], fact: ['monday', 'mondays'] }, { ask: ['tuesday', 'tues'], fact: ['tuesday', 'tues'] },
  { ask: ['wednesday', 'weds'], fact: ['wednesday', 'weds'] }, { ask: ['thursday', 'thurs'], fact: ['thursday', 'thurs'] },
  { ask: ['friday'], fact: ['friday'] }, { ask: ['saturday'], fact: ['saturday'] }, { ask: ['sunday'], fact: ['sunday'] }
]

/** Request kinds that need one kind of fact even when no word is shared. The fact must be about the user. */
const NEEDS: Array<{ ask: RegExp; fact: RegExp; categories?: string[]; weight: number }> = [
  // Where they are: the weather, "near me", shipping to them, their time zone. Not "Mom lives in Phoenix".
  { ask: /\b(weather|forecast|near (me|us|here|my place|our place)|nearby|around here|close to (me|us|home)|in my (area|city|town|neighbou?rhood)|my (city|town|neighbou?rhood)|what time ?zone|my time ?zone|sunset|sunrise|ship (it|this|that|them) (to me|home)|deliver(ed)? (to me|here|home)|my commute)\b/i, fact: /^((i|we) )?(lives?|living|based|moved|located)\b|^home address\b|^(my |our )?address\b|^(my |our )?time ?zone\b/i, weight: 0.65 },
  // Their own address ("forget my address", "what's my address"): where they live, however it was worded.
  { ask: /\b(my (home |street |mailing )?address|our (home )?address|home address|where (i|we) live|where do (i|we) live|my (house|apartment|place)|our (house|apartment|place))\b/i, fact: /^((the )?user |i |we )?(lives?|living|based|moved|located|resides?)\b|^home\s*(address)?\s*[:\-]|^(my |our |home )?address\b|\b\d+ [\w.' -]{2,40} (street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|place|pl|terrace|parkway|pkwy)\b/i, weight: 0.65 },
  // Their own birthday: "born on…" counts even without the word birthday.
  { ask: /\b(my (birthday|bday|birth ?date|date of birth)|when (i was|i'?m|was i|am i) born|how old am i)\b/i, fact: /^((the )?user |i )?(was )?born\b|^(my |the user'?s )?(birthday|bday|birth ?date|date of birth)\b/i, weight: 0.65 },
  // Food: their allergies and diet always matter (safety), whatever the dish is called.
  { ask: /\b(eat|eating|food|dinner|lunch|breakfast|brunch|recipes?|restaurants?|meals?|menu|cook(ing)?|snacks?|takeout|groceries|grocery|cuisine|paella|sushi|pizza|curry|tacos?|chowder|catering)\b/i, fact: /\b(allerg\w*|vegetarian|vegan|gluten|dairy[- ]free|kosher|halal|intoleran\w*|can'?t eat|doesn'?t eat|don'?t eat)\b/i, weight: 0.6 },
  // "Like I like", "the usual", "keep it short": how they like things done.
  { ask: /\b(like i like|the way i like|how i like|my usual|the usual|as usual|keep it (short|brief) like|my style|my tone)\b/i, fact: /./, categories: ['preference', 'rule'], weight: 0.5 },
  // What they charge: their rate and payment terms.
  { ask: /\b(how much (should|do) i (charge|bill|ask)|what('?s| is| do i charge for) my (rate|fee)|my hourly|quote (them|a client|a new client) a price)\b/i, fact: /\b(rate|per hour|hourly|net \d+)\b/i, weight: 0.55 }
]

const termRx = new Map<string, RegExp>()
function rx(term: string): RegExp {
  let r = termRx.get(term)
  if (!r) {
    const n = term === '$' ? '' : normalizeText(term)
    r = n ? new RegExp(`(^| )${n}(s|es)?( |$)`) : /\$/
    termRx.set(term, r)
  }
  return r
}
const has = (normalized: string, raw: string, term: string): boolean => term === '$' ? raw.includes('$') : rx(term).test(normalized)

/** A request without the text it quotes ("translate 'my place or yours'"): quoted words aren't about the user. */
const unquoted = (q: string): string => q.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, ' ')

/** The concepts a request points at (its own-world phrases), or a fact mentions (its plain words). */
function groupsIn(text: string, side: 'ask' | 'fact'): Set<number> {
  if (side === 'ask') text = unquoted(text)
  const t = normalizeText(text)
  const out = new Set<number>()
  CONCEPTS.forEach((c, i) => { if (c[side].some((w) => has(t, text, w))) out.add(i) })
  return out
}

/**
 * How well `text` (a saved fact, a past message) fits `query` by meaning, 0..1. One shared concept is a hint
 * (0.5), two a match (0.75), three or more a strong one (0.9); a request kind it serves gives that kind's weight.
 * 0 when nothing links them.
 */
export function conceptScore(query: string, text: string, category?: string): number {
  if (!query.trim() || !text.trim()) return 0
  const q = groupsIn(query, 'ask')
  let best = 0
  if (q.size) {
    const t = groupsIn(text, 'fact')
    const shared = [...q].filter((g) => t.has(g)).length
    if (shared) best = shared >= 3 ? 0.9 : shared === 2 ? 0.75 : 0.5
  }
  for (const n of NEEDS) {
    if (!n.ask.test(unquoted(query))) continue
    const fits = n.categories ? !!category && n.categories.includes(category) && n.fact.test(text) : n.fact.test(text.trim())
    if (fits) best = Math.max(best, n.weight)
  }
  return Math.min(1, best)
}

/** The fact-side words for the request's concepts (single words, for keyword search): "my boss" → manager, supervisor… */
export function expansionTerms(query: string, opts: { singleWords?: boolean } = {}): string[] {
  const t = normalizeText(unquoted(query))
  const out = new Set<string>()
  for (const c of CONCEPTS) {
    if (!c.ask.some((w) => has(t, query, w))) continue
    for (const w of c.fact) if (w !== '$' && !has(t, query, w) && (!opts.singleWords || !w.includes(' '))) out.add(w)
  }
  return [...out]
}

/**
 * Keyword alternatives for the request, by the concept each phrase points at: one entry per concept the request
 * names, the words a message about it would use. db.ts recallUserSaid counts each as one word of the request.
 */
export function conceptAlternatives(query: string, max = 6): Array<{ concept: number; words: string[] }> {
  const t = normalizeText(unquoted(query))
  const out: Array<{ concept: number; words: string[] }> = []
  CONCEPTS.forEach((c, i) => {
    if (!c.ask.some((w) => has(t, query, w))) return
    out.push({ concept: i, words: [...new Set(c.fact.filter((w) => w !== '$' && w.length >= 3).map(normalizeText))].slice(0, max) })
  })
  return out
}

/** A whole-word test (plural s/es allowed) on normalized text: "son" never matches "season" or "person". */
export function hasWord(text: string, word: string): boolean {
  return rx(word).test(normalizeText(text))
}

/**
 * Message flags that mean the text isn't the user's own words (a reminder from the app, another bot's handoff,
 * a recording, a link, an app or MCP client, a scheduled or helper run, a replaced reply, a relay). Neither
 * cross-chat search (db.ts recallUserSaid) nor earlier-in-chat recall (memory-system.ts earlierSaid) quotes them
 * as "what the user said".
 */
export const NOT_OWN_WORDS = ['hidden', 'handoff', 'teach', 'helperTask', 'fromLink', 'mcpClientId', 'fromApp', 'scheduled', 'goalRun', 'superseded', 'relayed', 'untrusted'] as const

/** A request's word as a search unit: whole words starting with it, past its plural or tense ("invoices" → invoice…). */
export function wordStem(w: string): string {
  const n = normalizeText(w)
  if (n.length >= 6 && n.endsWith('ing')) return n.slice(0, -3)
  if (n.length >= 5 && n.endsWith('es')) return n.slice(0, -2)
  if (n.length >= 5 && n.endsWith('ed')) return n.slice(0, -2)
  if (n.length >= 4 && n.endsWith('s') && !n.endsWith('ss')) return n.slice(0, -1)
  return n
}

/** Whether normalized text has a whole word starting with `stem` (word-start only: "son" never in "person"). */
export function hasStem(normalized: string, stem: string): boolean {
  return (' ' + normalized).includes(' ' + stem)
}

export { normalizeText as normalizeForRecall }
