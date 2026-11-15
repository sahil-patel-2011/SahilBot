import type { AliasKind, EntityType } from '@shared/context-engine'

// Entity resolution: is "Priya", "P. Patel", "priya@acme.com" or "@priyap" the same entity as "Priya
// Patel"? Exact identifiers (email, phone, handle) decide first; names match on their normalized form,
// known nickname pairs (Bob ↔ Robert), a first name that only one known person has, initials, and small
// typos in longer names. Everything here is pure, so it's tested directly.

/** Lowercase, accents dropped, punctuation to spaces, one space. */
export function normName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']s\b/g, '').replace(/[^\p{L}\p{N}@.+]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

export function normEmail(s: string): string { return s.trim().toLowerCase().replace(/^mailto:/, '') }
export function normPhone(s: string): string {
  const d = s.replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}
export function normHandle(s: string): string { return s.trim().toLowerCase().replace(/^@/, '') }

export function normAlias(kind: AliasKind, value: string): string {
  if (kind === 'email') return normEmail(value)
  if (kind === 'phone') return normPhone(value)
  if (kind === 'handle') return normHandle(value)
  return normName(value)
}

/** Common English nickname ↔ given-name pairs (both directions). */
const NICK_GROUPS: string[][] = [
  ['robert', 'bob', 'rob', 'bobby', 'robbie'], ['william', 'will', 'bill', 'billy', 'liam'], ['richard', 'rick', 'dick', 'rich', 'ricky'],
  ['elizabeth', 'liz', 'beth', 'lizzie', 'betty', 'eliza', 'libby'], ['katherine', 'kate', 'kathy', 'katie', 'kat', 'catherine', 'cathy'],
  ['margaret', 'maggie', 'meg', 'peggy'], ['james', 'jim', 'jimmy', 'jamie'], ['john', 'johnny', 'jack'], ['michael', 'mike', 'mikey', 'mick'],
  ['christopher', 'chris', 'kit'], ['christine', 'chris', 'christy', 'tina'], ['jennifer', 'jen', 'jenny'], ['jessica', 'jess', 'jessie'],
  ['joseph', 'joe', 'joey'], ['daniel', 'dan', 'danny'], ['david', 'dave', 'davey'], ['thomas', 'tom', 'tommy'], ['matthew', 'matt'],
  ['anthony', 'tony'], ['andrew', 'andy', 'drew'], ['alexander', 'alex', 'xander', 'sasha'], ['alexandra', 'alex', 'lexi', 'sasha'],
  ['nicholas', 'nick', 'nicky'], ['benjamin', 'ben', 'benny'], ['samuel', 'sam', 'sammy'], ['samantha', 'sam', 'sammy'], ['edward', 'ed', 'eddie', 'ted', 'ned'],
  ['patricia', 'pat', 'patty', 'trish'], ['patrick', 'pat', 'paddy'], ['rebecca', 'becca', 'becky'], ['victoria', 'vicky', 'tori'], ['susan', 'sue', 'suzy'],
  ['deborah', 'deb', 'debbie'], ['stephen', 'steve', 'stevie'], ['steven', 'steve', 'stevie'], ['timothy', 'tim', 'timmy'], ['kenneth', 'ken', 'kenny'],
  ['charles', 'charlie', 'chuck', 'chaz'], ['charlotte', 'charlie', 'lottie'], ['gregory', 'greg'], ['jonathan', 'jon', 'jonny'], ['zachary', 'zach', 'zack'],
  ['abigail', 'abby', 'gail'], ['amanda', 'mandy'], ['natalie', 'nat'], ['nathaniel', 'nate', 'nathan'], ['priyanka', 'priya'], ['rajesh', 'raj'],
  ['siddharth', 'sid'], ['aditya', 'adi'], ['sahil', 'sahi'], ['jayaprakash', 'jp'], ['mohammed', 'mo', 'mohamed', 'muhammad'], ['francis', 'frank', 'fran'],
  ['frances', 'fran', 'frannie'], ['gabriel', 'gabe'], ['gabriella', 'gabby', 'ella'], ['isabella', 'bella', 'izzy', 'isabel'], ['olivia', 'liv', 'livvy'],
  ['sophia', 'sophie'], ['theodore', 'theo', 'ted', 'teddy'], ['vincent', 'vince', 'vinny'], ['raymond', 'ray'], ['ronald', 'ron', 'ronnie'], ['donald', 'don', 'donny']
]
const NICK = new Map<string, Set<string>>()
for (const g of NICK_GROUPS) for (const a of g) { const s = NICK.get(a) ?? new Set<string>(); for (const b of g) if (b !== a) s.add(b); NICK.set(a, s) }

export function nicknamesOf(first: string): string[] {
  return [...(NICK.get(first.toLowerCase()) ?? [])]
}

export function isNickname(a: string, b: string): boolean {
  return a === b || !!NICK.get(a)?.has(b)
}

function editDistance(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** Honorifics and suffixes that don't make a name different. */
const NOISE = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'jr', 'sr', 'ii', 'iii', 'md', 'phd', 'dds', 'esq'])
export const nameParts = (s: string): string[] => normName(s).split(' ').map((w) => w.replace(/\.+$/, '')).filter((w) => w && !NOISE.has(w.replace(/\./g, '')))

/**
 * How strongly two names name the same entity, 0..1. 1: same normalized name. 0.9: same first and last
 * with a nickname or initial ("Bob Smith" / "Robert Smith", "P. Patel" / "Priya Patel"). 0.8: a small
 * typo in a long name. 0.7: one is just the other's first name ("Priya" / "Priya Patel"). Different
 * last names never match.
 */
export function nameMatch(a: string, b: string, type?: EntityType): number {
  const A = nameParts(a), B = nameParts(b)
  if (!A.length || !B.length) return 0
  const ja = A.join(' '), jb = B.join(' ')
  if (ja === jb) return 1
  // Places, organizations and things: typos and "the" only.
  if (type && type !== 'person') {
    const sa = ja.replace(/^the /, ''), sb = jb.replace(/^the /, '')
    if (sa === sb) return 1
    const short = Math.min(sa.length, sb.length)
    if (short >= 6 && editDistance(sa, sb, 2) <= (short >= 10 ? 2 : 1)) return 0.8
    return 0
  }
  const firstSame = (x: string, y: string): boolean => isNickname(x, y) || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))
  if (A.length >= 2 && B.length >= 2) {
    const la = A[A.length - 1], lb = B[B.length - 1]
    if (la !== lb && !(Math.min(la.length, lb.length) >= 5 && editDistance(la, lb, 1) <= 1)) return 0
    if (firstSame(A[0], B[0])) return la === lb ? 0.9 : 0.8
    if (A[0].length >= 4 && B[0].length >= 4 && editDistance(A[0], B[0], 1) <= 1) return 0.8
    return 0
  }
  // One of them is a single word: a first name (or nickname) of the other.
  const [one, many] = A.length === 1 ? [A[0], B] : [B[0], A]
  if (many.length === 1) {
    if (isNickname(one, many[0])) return 0.85
    if (Math.min(one.length, many[0].length) >= 5 && editDistance(one, many[0], 1) <= 1) return 0.8
    return 0
  }
  if (one === many[0]) return 0.7
  if (isNickname(one, many[0])) return 0.6
  return 0
}

/** Things that look like a person's name: 1–4 capitalized words, not a sentence start word. */
const NOT_NAMES = new Set(['i', 'me', 'my', 'we', 'you', 'he', 'she', 'they', 'it', 'the', 'a', 'an', 'and', 'or', 'but', 'so', 'hi', 'hey', 'hello', 'thanks', 'thank', 'yes', 'no', 'ok', 'okay', 'please',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'yesterday', 'tonight',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'also', 'just', 'what', 'when', 'where', 'who', 'why', 'how', 'can', 'could', 'would', 'should', 'will', 'remember', 'note', 'sahilbot', 'dear', 'best', 'regards', 'cheers'])

export function plausibleName(s: string): boolean {
  const parts = s.trim().split(/\s+/)
  if (!parts.length || parts.length > 4) return false
  if (parts.some((p) => !/^[\p{Lu}][\p{L}'’.-]*$/u.test(p))) return false
  return !NOT_NAMES.has(parts[0].toLowerCase().replace(/[.'’]/g, ''))
}

/** Title case a name that was typed in lowercase ("priya patel" → "Priya Patel"). */
export function titleCase(s: string): string {
  return s.replace(/\b(\p{Ll})(\p{L}*)/gu, (_m, a: string, b: string) => a.toUpperCase() + b)
}
