// Recall by meaning, not just by the same words: "email my boss" should find "Manager at work is Dana…",
// "near my place" the home address, "retirement money" the 401k. No model call, so it runs on every
// request: a small map of everyday concepts (each a group of words people use for the same thing) and a
// few request kinds that always need one kind of fact (the weather needs where the user lives; food needs
// their allergies and diet). Used to rank memories (memory.ts), to search the user's other chats
// (db.ts recallUserSaid) and to search memory (memory-system.ts recall).

/** Same as memory.ts normalizeText (kept here so the two modules don't import each other). */
const normalizeText = (s: string): string => s.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Words people use for the same thing. A request that uses one finds facts that use any. */
export const CONCEPTS: string[][] = [
  ['boss', 'manager', 'supervisor', 'team lead', 'line manager', 'skip level', 'report to', 'reports to'],
  ['landlord', 'landlady', 'property manager', 'property management', 'rent', 'rents', 'lease', 'leasing office', 'building manager', 'owns our building', 'owns the building', 'building owner', 'owner of our building', 'our building'],
  ['wife', 'husband', 'spouse', 'partner', 'hubby', 'missus', 'mrs', 'wifey', 'other half', 'better half'],
  ['kid', 'kiddo', 'son', 'daughter', 'child', 'children', 'little one'],
  ['mom', 'mother', 'mum', 'mama', 'mommy'],
  ['dad', 'father', 'papa', 'daddy', 'pops'],
  ['brother', 'sister', 'sibling', 'bro', 'sis'],
  ['teacher', 'school', 'class', 'classroom', 'grade', 'elementary', 'middle school', 'high school', 'principal', 'homework', 'absent', 'pickup', 'pick up', 'practice'],
  ['dentist', 'dental', 'teeth', 'tooth', 'orthodontist'],
  ['doctor', 'physician', 'pcp', 'checkup', 'check up', 'gp'],
  ['vet', 'veterinarian', 'animal clinic', 'animal hospital', 'dog', 'cat', 'pet', 'puppy', 'pup', 'doggo', 'pooch', 'kitty', 'kitten'],
  ['car', 'vehicle', 'oil change', 'mechanic', 'tires', 'plate', 'registration'],
  ['flight', 'fly', 'flying', 'airline', 'airlines', 'plane', 'seat', 'seats', 'airport', 'boarding'],
  ['hotel', 'staying', 'lodging', 'airbnb', 'accommodation'],
  ['trip', 'travel', 'vacation', 'holiday', 'itinerary'],
  ['retirement', '401k', 'ira', 'roth', 'pension', 'brokerage', 'investments', 'invest'],
  ['savings', 'bank', 'checking'],
  ['contractor', 'builder', 'builders', 'quote', 'quotes', 'estimate', 'bid', 'remodel', 'renovation'],
  ['price', 'cost', 'charge', 'rate', 'fee', 'how much', 'pricing', 'quote', 'quotes'],
  ['invoice', 'bill', 'billing', 'payment', 'pays', 'paid', 'net 30', 'accounts payable', 'ap'],
  ['client', 'customer'],
  ['coffee', 'latte', 'flat white', 'espresso', 'cappuccino', 'cafe'],
  ['gym', 'workout', 'exercise', 'fitness'],
  ['wifi', 'wi fi', 'router', 'network', 'internet'],
  ['weekly report', 'status report', 'weekly update', 'weekly summary'],
  // Days, as people shorten them.
  ['monday', 'mon'], ['tuesday', 'tue', 'tues'], ['wednesday', 'wed', 'weds'], ['thursday', 'thu', 'thur', 'thurs'], ['friday', 'fri'], ['saturday', 'sat'], ['sunday', 'sun', 'sundays'],
  ['anniversary', 'wedding', 'married'],
  ['birthday', 'bday', 'born'],
  ['allergy', 'allergic', 'allergies', 'intolerant'],
  ['home', 'house', 'my place', 'address', 'apartment', 'where i live', 'lives in', 'live in'],
  ['phone', 'cell', 'mobile', 'number'],
  ['email', 'e mail', 'inbox']
]

/** Request kinds that need one kind of fact even when no word is shared. */
const NEEDS: Array<{ ask: RegExp; fact: RegExp; categories?: string[]; weight: number }> = [
  // Where they are: the weather, "near me", shipping, time zones, local places.
  { ask: /\b(weather|forecast|rain|snow|temperature|near (me|my|here|us)|nearby|around here|local|restaurants?|deliver|ship(ping)?|time ?zone|commute|my place|sunset|sunrise)\b/i, fact: /\b(lives? in|living in|based in|home address|address|time ?zone|moved to)\b/i, categories: ['location'], weight: 0.7 },
  // Food: allergies and diet always matter (safety), whatever the dish is called.
  { ask: /\b(eat|eating|food|dinner|lunch|breakfast|brunch|recipes?|restaurants?|meals?|menu|cook(ing)?|snacks?|takeout|groceries|grocery|dish|cuisine|paella|sushi|pizza|curry|bake|catering)\b/i, fact: /\b(allerg\w*|vegetarian|vegan|gluten|dairy[- ]free|diet|kosher|halal|intoleran\w*|doesn'?t eat|can'?t eat)\b/i, weight: 0.75 },
  // "Like I like", "the usual", "keep it short": how they like things done.
  { ask: /\b(like i like|the way i like|how i like|my usual|the usual|as usual|keep it (short|brief)|my style|my tone)\b/i, fact: /./, categories: ['preference', 'rule'], weight: 0.6 },
  // Money they're owed or charge: their rate and payment terms.
  { ask: /\b(charge|bill|invoice|rate|quote (them|a price)|how much should i)\b/i, fact: /\b(rate|per hour|hourly|net \d+|pays)\b/i, weight: 0.6 }
]

const termRx = new Map<string, RegExp>()
function rx(term: string): RegExp {
  let r = termRx.get(term)
  if (!r) { r = new RegExp(`(^| )${normalizeText(term).replace(/ /g, ' ')}(s|es)?( |$)`); termRx.set(term, r) }
  return r
}
const has = (padded: string, term: string): boolean => rx(term).test(padded)

/** The concept groups a text mentions. */
function groupsIn(text: string): Set<number> {
  const t = normalizeText(text)
  const out = new Set<number>()
  CONCEPTS.forEach((g, i) => { if (g.some((w) => has(t, w))) out.add(i) })
  return out
}

/**
 * How well `text` (a saved fact, a past message) fits `query` by meaning, 0..1: the share of the request's
 * concepts the text shares (any word of each), and the request kinds it serves. 0 when nothing links them.
 */
export function conceptScore(query: string, text: string, category?: string): number {
  if (!query.trim() || !text.trim()) return 0
  const q = groupsIn(query)
  let best = 0
  if (q.size) {
    const t = groupsIn(text)
    const shared = [...q].filter((g) => t.has(g)).length
    if (shared) best = 0.55 + 0.45 * (shared / q.size)
  }
  for (const n of NEEDS) {
    if (!n.ask.test(query)) continue
    const ofKind = !!n.categories && !!category && n.categories.includes(category)
    // A request kind with a category matches facts of that kind, or facts that say the thing outright.
    const fits = n.categories ? (ofKind && n.fact.test(text)) || (n.fact.source !== '.' && n.fact.test(text)) : n.fact.test(text)
    if (fits) best = Math.max(best, n.weight)
  }
  return Math.min(1, best)
}

/** The other words for the request's concepts (single words, for keyword search): "boss" → manager, supervisor… */
export function expansionTerms(query: string, opts: { singleWords?: boolean } = {}): string[] {
  const t = normalizeText(query)
  const out = new Set<string>()
  for (const g of CONCEPTS) {
    if (!g.some((w) => has(t, w))) continue
    for (const w of g) if (!has(t, w) && (!opts.singleWords || !w.includes(' '))) out.add(w)
  }
  return [...out]
}

/**
 * For a word of the request: it and the other words for the same thing (keyword search alternatives). With the
 * whole request, a phrase it uses counts too ("weekly update" → weekly report, status report).
 */
export function alternativesFor(word: string, query = ''): string[] {
  const w = normalizeText(word)
  const q = normalizeText(query)
  const out = new Set([w])
  for (const g of CONCEPTS) {
    const hit = g.some((x) => { const n = normalizeText(x); return n === w || n + 's' === w || n === w + 's' || (n.includes(' ') && n.split(' ').includes(w) && has(q, x)) })
    if (hit) for (const x of g) out.add(normalizeText(x))
  }
  return [...out]
}
