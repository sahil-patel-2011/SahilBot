import { statSync } from 'node:fs'
import type { Attachment, Effort, Tier } from '@shared/types'
import { cadSignals } from '../cad/cad-intent'
import { VIDEO_RE } from '../agent/video-intent'
import { autoEffort } from './auto-effort'

// One decision for every request: what kind of task it is (the routing table's category, routing-table.ts),
// how hard (difficulty 0-3), whether it runs as a chat or as the full agent (agent/intent.ts), and how hard Auto
// thinks (auto-effort.ts). Local and instant: features over the request text plus what the app already knows
// (attachments, the chat's project folder, the bot's role, voice, the mode toggles, the previous turn). It never
// calls a model. The labels it is measured against follow the rubrics in docs/model-routing.md ("Rubrics"),
// scored by tests/unit/routing-eval.test.ts on tests/fixtures/routing-eval.json.
//
// STABLE API: classifyTask(text, ctx) → TaskClass (category, difficulty, kind, effort, confidence…).
// agent/intent.ts classifyTask (chat or agent) is this same decision, so the two never contradict.

export type TaskCategory =
  | 'coding' // agentic, multi-file coding and debugging
  | 'code-quick' // a quick question about code
  | 'computer-use' // drive the Mac or a browser: click, type, fill in
  | 'research' // deep research and synthesis with citations
  | 'long-context' // very large inputs (200K+ tokens)
  | 'writing' // writing and editing: tone, polish
  | 'office' // documents, spreadsheets, decks, data analysis
  | 'math' // math and careful reasoning
  | 'vision' // images and screenshots
  | 'agent-tools' // tool-heavy tasks with connectors (mail, calendar, files)
  | 'chat' // small talk and simple questions
  | 'voice' // a spoken conversation (low latency)
  | 'cad' // CAD and mechanical design: parts, assemblies, 3D printing

/** Every category. New ones go at the end (the routing table needs a row for each). */
export const TASK_CATEGORIES: TaskCategory[] = ['coding', 'code-quick', 'computer-use', 'research', 'long-context', 'writing', 'office', 'math', 'vision', 'agent-tools', 'chat', 'voice', 'cad']

/** In words, for the "routed" label ("Claude Sonnet 5.5 · coding"). */
export const CATEGORY_LABEL: Record<TaskCategory, string> = {
  coding: 'coding',
  'code-quick': 'code question',
  'computer-use': 'computer use',
  research: 'research',
  'long-context': 'long document',
  writing: 'writing',
  office: 'docs & data',
  math: 'math & reasoning',
  vision: 'image',
  'agent-tools': 'tools & apps',
  chat: 'chat',
  voice: 'voice',
  cad: 'CAD & design'
}

export type TaskKind = 'chat' | 'agent'

export interface TaskContext {
  attachments?: Attachment[]
  /** Images on the message (pasted screenshots). */
  images?: number
  /** Non-image files and folders attached, when `attachments` isn't given (agent/intent.ts passes counts). */
  files?: number
  folders?: number
  /** The previous request's tier, category, kind and effort (follow-ups like "yes, do it" keep them). */
  previousTier?: Tier
  previousCategory?: TaskCategory
  previousKind?: TaskKind
  previousEffort?: Effort
  /** The previous request was school work (a follow-up stays school work). */
  previousStudy?: boolean
  /** A real-time voice conversation. */
  voice?: boolean
  /** The chat has an unfinished plan. */
  openPlan?: boolean
  /** The chat's folder is a code project (.git, package.json…). */
  codeProject?: boolean
  /** Heavy (several attempts + a judge), a Team of Experts, Deep Research, Plan first, Council. */
  heavy?: boolean
  team?: boolean
  deepResearch?: boolean
  planFirst?: boolean
  council?: boolean
  /** A helper agent, a routine or goal wake-up (unattended), a group chat: always the full agent. */
  helper?: boolean
  unattended?: boolean
  group?: boolean
  /** The bot answering: its name and instructions. A weak prior for vague requests ("fix it", "any news?"). */
  role?: string
  /** Estimated tokens of the new material (the message and its attached files): a huge one is a long-document task. */
  inputTokens?: number
  /** Estimated prompt size in tokens (new material plus the history that will be sent): the window must fit it. */
  contextTokens?: number
}

/** What the effort rubric reads besides the category and difficulty (auto-effort.ts). */
export interface TaskSignals {
  stakes: boolean
  deliverable: boolean
  longOutput: boolean
  /** 0 no tools, 1 one call, 2 a few, 3 many steps. */
  toolDepth: number
  /** A level asked for in words. */
  explicit?: Effort
  followUp: boolean
  /** School work: homework, studying, a class or a school subject. Routed to fast, low-cost models. */
  study?: boolean
  /**
   * An obviously quick ask (quickAsk): a sum, a unit conversion, a translation of a short sentence, a typo fix of
   * a short text. Routed to the instant row (a quick model), and Auto's brain may skip its read for it.
   */
  quick?: QuickAsk
}

export interface TaskClass {
  category: TaskCategory
  /** 0 instant, 1 light, 2 standard, 3 hardest (the mode floors applied). */
  difficulty: Tier
  /** confidence >= CONFIDENT. */
  confident: boolean
  /** How often this decision path is right on the eval set (calibrated, 0-1). */
  confidence: number
  /** Why, in words ("coding · changes code"). */
  why: string
  /** Chat (lean prompt, answers right away) or agent (plan, work tools, self-check). */
  kind: TaskKind
  kindWhy: string
  /** The level Auto thinks at for this request (a level chosen by hand replaces it: resolveEffort). */
  effort: Effort
  signals: TaskSignals
  /** Has images: the model must see. */
  needsVision: boolean
  /** Estimated prompt tokens: the model's window must fit it. */
  contextTokens: number
  /** Replies should start fast (voice). */
  lowLatency: boolean
  /** The decision path, for the eval and the calibration table. */
  rule: string
  /**
   * For writing: whose words these are. 'professional' (emails, replies, memos, proposals, cover letters: what a
   * person will receive) uses the business-writing row (routing-table PROFESSIONAL_WRITING); 'creative' (poems,
   * stories, lyrics) the creative-writing one.
   */
  voice?: WritingVoice
  /** A specialised engineering domain with its own evidence-based row (routing-table ELECTRICAL_ENGINEERING). */
  domain?: 'electrical'
}

export type WritingVoice = 'professional' | 'creative' | 'technical'

const ELECTRICAL = /\b(circuits?|schematics?|pcb|resistors?|capacitors?|inductors?|voltage (divider|drop|regulator)|op-?amps?|mosfets?|transistors?|ohm'?s law|kirchhoff|buck converter|boost converter|wire gauge|awg|circuit breaker|amperage|three[- ]phase|led driver|current limiting|impedance|h-bridge|motor driver|bypass cap|pull-?up resistor)\b/

const CREATIVE = /\b(poem|poetry|haiku|sonnet|limerick|story|short story|fiction|novel|chapter|lyrics|song|screenplay|script for a (film|movie|play)|fairy tale|fable|rap|verse|toast|eulogy|wedding speech|fan ?fic)\b/
const PROFESSIONAL = /\b(e-?mails?|replies|reply|respond|response to|memo|cover letter|proposal|client|customer|colleague|boss|manager|recruiter|hiring|follow[- ]up|status (update|report)|update (to|for) (the )?(team|client|stakeholders)|linkedin|bio|resume|cv|press release|announcement|newsletter|slack message|message to|letter (to|for)|thank[- ]you note|apology|complaint|invoice note|out of office|more formal|less formal|professional|polite|sound like me|executive summary|meeting notes|minutes)\b/

/** Whose words a writing request is (see TaskClass.voice). Creative wins when both match ("a poem for my boss"). */
export function writingVoice(text: string): WritingVoice {
  const t = (text ?? '').toLowerCase()
  if (CREATIVE.test(t)) return 'creative'
  if (PROFESSIONAL.test(t)) return 'professional'
  return 'technical'
}

/** Very large inputs: above this, only the 1M-window cloud models fit (local windows stop at 128K). */
export const LONG_CONTEXT_TOKENS = 200_000
/** Confidence at or above this is "confident" (below it a tie-breaker may be asked: route-tiebreak.ts). */
export const CONFIDENT = 0.75

// ---------------------------------------------------------------------------------------------------
// Normalizing: typos (one edit away from a word the rules know), shorthand, and other languages (keywords
// glossed into English so the same rules read them).
// ---------------------------------------------------------------------------------------------------

const SHORTHAND: Record<string, string> = { u: 'you', ur: 'your', pls: 'please', plz: 'please', tmrw: 'tomorrow', tmr: 'tomorrow', tmrrw: 'tomorrow', thx: 'thanks', ty: 'thanks', fx: 'fix', msg: 'message', pic: 'picture', pics: 'pictures', rn: 'right now', asap: 'as soon as possible', w: 'with', bc: 'because', abt: 'about', smth: 'something', sth: 'something' }

/** Words the rules read: a token one edit away from one of these is taken as it. */
const LEXICON = ('fix debug refactor implement optimize migrate deploy review update rename remove delete create build write draft rewrite proofread polish ' +
  'summarize summarise analyze analyse research investigate compare schedule meeting meetings calendar reminder remind email emails inbox message messages ' +
  'spreadsheet spreadsheets presentation document documents report invoice budget dashboard chart workout workouts laptop laptops programming program ' +
  'service server function component button react python javascript typescript database query endpoint script install download upload ' +
  'difference between explain irrational integral probability equation derivative theorem prove proof calculate ' +
  'safari chrome browser screen screenshot website open click login portal cart checkout ' +
  'tomorrow today yesterday please thanks thank asking because something message channel folder folders desktop downloads photos pictures ' +
  'sources citations studies article essay letter cover paragraph story poem speech tagline wedding ' +
  'organize cleanup archive unsubscribe forward reply appointment assignment transcript application').split(' ')
const LEXSET = new Set(LEXICON)
/** Real words a near-miss must not be "corrected" from. */
const REAL = new Set(['form', 'from', 'pen', 'rite', 'ripe', 'reply', 'apply', 'build', 'guild', 'cart', 'card', 'care', 'chart', 'charm', 'scrip', 'proof', 'prof', 'dash', 'meting', 'model', 'models', 'modal', 'there', 'their', 'where', 'were', 'whole', 'while', 'cover', 'clover', 'react', 'enact', 'debut', 'today', 'toady', 'emails', 'emails', 'scream', 'stream', 'serve', 'served', 'later', 'latter', 'letter', 'better', 'bitter', 'write', 'white', 'wrote', 'quite', 'quiet', 'proper', 'prover', 'person', 'prison', 'theory', 'report', 'resort', 'repost', 'deploy', 'employ', 'review', 'preview', 'remove', 'remote', 'update', 'upgrade', 'create', 'crate', 'curate', 'chrome', 'chrono', 'opens', 'often', 'oven', 'open', 'opine', 'clock', 'click', 'flick', 'block', 'black', 'blank'])

/**
 * One typo apart: a swapped pair, a dropped or an extra letter, or (words of 6+ letters) one wrong letter.
 * Never at the first letter (people rarely mistype it, and real words differ there: lease / please) and never
 * a plural (letters / letter), so real words stay as they are.
 */
function editOne(w: string, lex: string): boolean {
  if (w === lex || w[0] !== lex[0]) return false
  if (w === `${lex}s` || lex === `${w}s`) return false
  const la = w.length, lb = lex.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    const d: number[] = []
    for (let i = 0; i < la; i++) if (w[i] !== lex[i]) d.push(i)
    if (d.length === 1) return la >= 6
    return d.length === 2 && d[1] === d[0] + 1 && w[d[0]] === lex[d[1]] && w[d[1]] === lex[d[0]]
  }
  const [s, l] = la < lb ? [w, lex] : [lex, w]
  let i = 0, j = 0, skipped = false
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue }
    if (skipped) return false
    skipped = true; j++
  }
  return true
}

function fixToken(w: string): string {
  if (SHORTHAND[w]) return SHORTHAND[w]
  if (w.length < 3 || LEXSET.has(w) || REAL.has(w) || /\d/.test(w)) return w
  // Short tokens: only a dropped letter ("opn", "wrte"); longer ones: one edit or a swap.
  for (const lex of LEXICON) {
    if (w.length <= 4 ? lex.length === w.length + 1 && editOne(w, lex) : lex.length >= 5 && editOne(w, lex)) return lex
  }
  // A doubled last letter ("reactt").
  if (/(.)\1$/.test(w) && LEXSET.has(w.slice(0, -1))) return w.slice(0, -1)
  return w
}

/** Other languages' keywords, glossed into English for the same rules. */
const GLOSS: Array<[RegExp, string]> = [
  // Spanish / Portuguese
  [/\b(escribe|escribir|redacta|escreva)\b/i, 'write'], [/\bcorreo\b/i, 'email'], [/\b(corrige|arregla|repara|corrija)\b/i, 'fix'], [/\bc[oó]digo\b/i, 'code'],
  [/\b(crea|crear|haz|hazme|hacer|h[aá]game)\b/i, 'create'], [/\b(fais-moi|mach mir)\b/i, 'make'], [/\b(hoja de c[aá]lculo|planilha)\b/i, 'spreadsheet'], [/\bgastos\b/i, 'expenses'], [/\b(investiga|investigar|pesquise)\b/i, 'research'],
  [/\bfuentes\b/i, 'sources'], [/\bcalendario\b/i, 'calendar'], [/\breuni[oó]n\b/i, 'meeting'], [/\b(recu[eé]rdame|lembre-me)\b/i, 'remind me'], [/\bpresentaci[oó]n\b/i, 'presentation'],
  // French
  [/(?:^|\s)([ée]cri(s|re|vez))\b/i, 'write'], [/\bpo[èe]me\b/i, 'poem'], [/\bcourriel\b/i, 'email'], [/\br[ée]union\b/i, 'meeting'], [/\bcalendrier\b/i, 'calendar'],
  [/\borganiser\b/i, 'schedule'], [/\bprouve[rz]?\b/i, 'prove'], [/\bcorrige[rz]\b/i, 'fix'], [/\bcr[ée]e[rz]?\b/i, 'create'], [/\btableur\b/i, 'spreadsheet'], [/\brappelle-moi\b/i, 'remind me'],
  // German
  [/\bschreib(e|en)?\b/i, 'write'], [/\berstelle[n]?\b/i, 'create'], [/\bpr[äa]sentation\b/i, 'presentation'], [/\bfolien\b/i, 'slides'], [/\b(korrigiere|behebe)\b/i, 'fix'],
  [/\btabelle\b/i, 'spreadsheet'], [/\btermin\b/i, 'meeting'], [/\berinnere mich\b/i, 'remind me'], [/\brecherchiere\b/i, 'research'], [/\bbeweise\b/i, 'prove'], [/\bwie sp[äa]t\b/i, 'what time'],
  // Chinese
  [/修复|修改|改正/, 'fix'], [/错误|报错/, 'error'], [/代码|程序/, 'code'], [/写/, 'write'], [/诗/, 'poem'], [/电子表格|表格/, 'spreadsheet'], [/邮件/, 'email'], [/日历/, 'calendar'], [/会议/, 'meeting'],
  [/提醒我/, 'remind me'], [/研究|调研/, 'research'], [/证明/, 'prove'], [/幻灯片|演示文稿/, 'slides'],
  // Japanese
  [/書き直/, 'rewrite'], [/書いて|書く/, 'write'], [/メール/, 'email'], [/修正|直して/, 'fix'], [/コード/, 'code'], [/詩/, 'poem'], [/スプレッドシート|表計算/, 'spreadsheet'], [/リマインド/, 'remind me'], [/調べて|調査/, 'research'],
  // Hindi (romanized)
  [/\benv(oie|oyer|oyez|[ií]a|iar|[ií]ale)\b/i, 'send'], [/\b(un message|un mensaje|uma mensagem) (à|a)(?=\s)/i, 'a message to'],
  [/\byaad dila(na|o|dena)?\b/i, 'remind me'], [/\blikho\b/i, 'write'], [/\bbhejo\b/i, 'send'], [/\b(thik|theek) karo\b/i, 'fix'],
  // Greetings
  [/^(bonjour|hola|ol[aá]|hallo|ciao|namaste|salut|guten (tag|morgen)|こんにちは|你好|您好)\b/i, 'hello']
]

/** The request in lower case with typos fixed and other languages' keywords glossed into English. */
export function normalizeRequest(text: string): string {
  const lower = (text ?? '').toLowerCase()
  const fixed = lower.replace(/[a-z]+/g, (w) => fixToken(w))
  const gloss = GLOSS.filter(([re]) => re.test(text)).map(([, g]) => g)
  return gloss.length ? `${fixed} ${gloss.join(' ')}` : fixed
}

// ---------------------------------------------------------------------------------------------------
// Lexicons. They read the normalized text (lower case).
// ---------------------------------------------------------------------------------------------------

const GREETING = /^(hi|hey|hello|yo|sup|hiya|howdy|thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|awesome|perfect|lol|lmao|haha|good (morning|afternoon|evening|night)|gm|gn|bye|see you|how are you|how'?s it going|what'?s up|got it|sounds good|no worries|np|hello again|tudo bem)\b/
/** A thank-you or a pleasantry on its own ("thanks so much, that was really helpful!"): nothing else asked. */
const THANKS_ONLY = /^((ok(ay)?|great|perfect|awesome|cool|nice)[,!. ]+)*(thanks|thank you|thx|ty|cheers|much appreciated)( (so|very) much| a (lot|ton|bunch)| again)?([,.!]*\s*(that|this|it|you)('s| was| were| is| are)? ((really|super|very|so|incredibly) )?(helpful|great|perfect|useful|awesome|amazing|clear|kind|the best|a big help|exactly what i needed))?[\s!.:)]*$/
const FOLLOW_UP = /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|go for it|continue|keep going|carry on|proceed|try again|again|retry|redo|next|more|one more|fix (it|that|this)|that'?s (wrong|not (it|right))|not quite|no[,.]? |make it \w+|make (them|this) \w+|now (make|turn|do|put|convert|send|add|write|email)|also\b|and (also|then)|send it|ship it|explain (it|that) again|same (thing|again)|shorter|longer|simpler|perfect,|great,|thanks,|looks good|lgtm|(do|same) (the same|it|that|this) (for|with|again)|the same for|same for\b)/
const QUESTION = /^(¿|what|which|why|how|when|who|whom|where|is|are|was|were|does|do|did|should|would|will|can i|could i|whats|what's|hows|how's|who's|tell me (about|what|why|how)|explain|describe|define|quick q)/
const POLITE_DO = /\b(for me|can you|could you|would you|please|i need you to|i want you to|help me (to )?(make|build|create|write|set|fix|organi[sz]e|clean))\b/
/** "Don't do it, just tell me." */
const EXPLAIN_ONLY = /\b(don'?t (write|run|change|do)|no specific code|in general|just (explain|tell me)|not the (language|code))\b/

// Code
const CODE_STRONG = /```|\b(stack ?trace|traceback|segfault|null pointer|compiler?|compiles?|regex|sql|graphql|apis?|endpoints?|repo(sitory)?|codebase|git|github|gitlab|pull request|\bpr #?\d+|typescript|javascript|python|rust|golang|go code|swift|kotlin|java|c\+\+|c#|ruby|php|react|next\.?js|vue|angular|svelte|node(\.?js)?|express|flask|django|rails|npm|pnpm|yarn|pip|docker(file)?|docker-compose|kubernetes|k8s|unit tests?|test suite|jest|pytest|webpack|vite|lint(er)?|refactor(ing)?|dockerfile|github actions|ci\b|oauth|websockets?|handler|robotcontainer|wpilib|memory leak|crash log|monorepo|turborepo|closures?|hashmap|treemap|quicksort|time complexity|dependency injection|http status|status code|async\/await|functions?|the variable|subsystem|off-by-one|race condition|pagination|null check|infinite loop|rate limit(ing|er)?|input validation|vercel|netlify|heroku|chrome extension|browser extension|cli\b|command[- ]line|frontend|backend|staging|schema|rest api|sdk|json|yaml|css|html|bash|shell script|one-liner|palindrome|deployed to production|the build|build is failing|structs?|enums?|class components?|a class|processe?s? and (a )?threads?|threads?|mutex|deadlock|garbage collect\w*|pointers?|recursion|big[- ]o|hash ?tables?|linked lists?|binary trees?|cap theorem|tcp|udp|dns|postgres(ql)?|mysql|mongodb|redis|sqlite|dynamodb|elasticsearch|hello world|cannot read propert\w*|undefined is not|is not a function|null reference|profile it|hash ?maps?|xcode|signing failed|cron( jobs?)?|after the last deploy|(ios|android) build|build (green|passing|red|broken)|webhooks?)\b|\b[a-z]+(error|exception)\b|\b[\w/-]+\.(ts|tsx|js|jsx|py|rs|go|swift|java|kt|cpp|c|h|rb|php|sql|sh|css|html|vue)\b/
const CODE_WEAK = /\b(code|coding|bugs?|tests?|script|component|module|controller|server|query|migration|deploy|branch|commit|app|button|header|page|forms?|dashboard|feature|ui|login|pagination|site|crash(es)?)\b/
const CODE_ACT = /\b(sort (it|this) out|profile|get it|reduce|improve|support|connect|hook up|expose|cache|validate|handle|fix|debug|implement|refactor|build|write|add|create|make|change|update|rename|migrate|port|optimi[sz]e|speed up|clean up|review|test|ship|deploy|set up|wire|integrate|scaffold|bump|tune|patch|investigate|find (the|out)|run|convert|design|upgrade|remove|help)\b/
const SNIPPET = /\b(write|give me|show me)\b.{0,25}\b(a |an )?(quick |small |short )?(python |js |javascript |sql |bash )?(function|one-liner|regex|snippet|query|lambda|example|hello world|(data )?class|struct|interface|enum|types?) ?(for|that|to|from|with)?\b/
/** Code words that are not about code ("Python the snake"). */
const NOT_CODE = /\b(the snake|not the (programming )?language|not (about )?(code|programming))\b/
/** Making a site, an app or a game is coding. */
const BUILD_APP = /\b(build|make|create|code|develop)\b( me)? (a|an|the|my) ([\w-]+ ){0,2}(landing page|website|web ?site|web app|web page|ios app|android app|mobile app|app|game|bot|plugin)\b/
const INCIDENT = /\b(site is down|is down|outage|production is|in production|customers are complaining|500 errors?)\b/

// Screen and browser
const SITES = '(amazon|ebay|etsy|walmart|target|best buy|opentable|resy|airbnb|expedia|booking\\.com|kayak|uber|lyft|doordash|instacart|linkedin|twitter|facebook|instagram|youtube|reddit|netflix|canvas|blackboard|the dmv|my bank)'
const APPS = '(safari|chrome|firefox|finder|system settings|settings app|preferences|spotify|apple music|numbers|keynote|pages app|figma|slack app|messages app|notes app|xcode|vs ?code|terminal|mail app|photos app|preview)'
const COMPUTER = new RegExp(`\\b(click|double[- ]click|tap (on|the)|scroll( through)?|drag|type (it )?(in|into)|on (my|the) screen|my (mac|desktop) screen|open ${APPS}|in ${APPS}\\b|log ?in ?to\\b|log ?into\\b|sign ?in ?to\\b|sign ?into\\b|log ?in (at|on) |fill (out|in) (the|this|a|my) (\\w+ )?(form|application|fields?)|navigate to|go to (the )?(\\w+ )?(website|site|page|portal)|go to [\\w-]+\\.(com|org|net|io|gov|edu)|on (the|this|their|your|its|my) ([\\w-]+ )?(website|site|page|portal)|(through|via|using) (the )?([\\w-]+ ){0,2}(website|site|portal)|open (the )?[\\w-]+ app\\b|paste .{1,40} into|open (notes|reminders|calendar|messages|mail|photos|music|maps|calculator|textedit|word|excel|powerpoint) (and|to)\b|careers page|use (my|the) (browser|computer|mac)|take a screenshot|add (it|this|them|the \\w+( \\w+)?) to (my|the) cart|to my cart|check ?out (the|my)|check me in|play (my|the|some)|submit .{1,40} (to|on) |apply for .{1,60} (on|at|through) |(go to|open|on|in) (my )?${SITES}\\b.{0,40}\\b(orders?|account|profile|cart|settings|feed|return|cancel|book|reserve|post|unfollow|follow|like|comment|change)|(book|reserve) .{1,40}\\b(on|at|through) ${SITES})\\b`)
const URL_OPEN = /\b(open|visit|go to|browse to)\b\s+(https?:\/\/|www\.)/
const SHOP = /\b(buy|purchase)\b|\border (a|an|me|some|two|three|the|\d+)\b|\bship (it|them) to\b/

// CAD and mechanical design
const CAD_STRONG = /\b(snap[- ]fit|constrain (it|them) to|mirror the \w+ (part|body|feature)|base plate|onshape|freecad|fusion ?360|solidworks|inventor|cad|stl|step file|\.step|3d[- ]?print(able|ed|ing|er)?|3d model|extrude|fillets?|chamfers?|revolve|loft|part studio|interferences?|parametric|assembly with mates|mates)\b/
const CAD_WEAK = /\b(bracket|enclosure|housing|gearbox|press[- ]fit|tolerances?|bearings?|wall thickness|intake|sketch|mount(ing)?|\d+ ?mm|m3|m4|nema ?\d+|pla|petg|abs|tpu|asa|nylon|resin|shell|thicker|thinner|holes?|walls?|infill|layer height|nozzle|print|phone mount|knob|lid)\b/

// Math
const MATH = /\b(what (is|are) the (chance|probability|odds)|chances? (that|of)|odds (that|of)|share a birthday|calculate|compute|monthly payment|amorti[sz]\w*|compound interest|prove|proof|derive|derivation|theorem|lemma|integral|derivative|differential equations?|equations?|probability|combinatorics?|eigen(values?|vectors?)?|diagonali[sz]able|matri(x|ces)|calculus|algebra|number theory|olympiad|aime|imo|logic puzzle|riddle|solve for|solve|real solutions|monty hall|variance|binomial|irrational|prime numbers?|primes\b|is \d+ (a )?prime|divisible|show the math|how many ways|expected value|show that|converges?|(monotone|bounded|arithmetic|geometric|fibonacci|convergent|cauchy) sequences?|(infinite|geometric|arithmetic|taylor|power|fourier) series|permutations?|combinations|arrangements?|ratio|proportion|percent(age)?|average speed)\b|\bhow much (flour|water|sugar|time|money|paint)\b|\b(for|needs|makes) \d+ .{0,30}\bhow (much|many)\b|\d+\s*[-+*/^]\s*\d+|x\^\d|\b\d+(\.\d+)?%\s+of\b|\bhow much will i have\b|\bmph\b/
const MATH_HARD = /\b(prove|proof|show that|derive|derivation|theorem|lemma|olympiad|aime|imo|logic puzzle)\b/

// Mail, calendar, files and connectors
const SELF = /^(call|phone|facetime|ring) [a-z]+( [a-z]+)?$|\b(remind me|set (a|an|my) (reminder|alarm|timer)|schedule (a|an|my)|(text|message|e-?mail) (?!to\b)[a-z]+ (that|saying|about)|send (an |a )?(e-?mail|text|message|invite|dm) to|every (day|morning|evening|night|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|month|hour)|each (day|week|morning)|daily (briefing|digest|summary)|send me a (summary|digest))\b/
const RELAY = /\b((ask|tell|message) the \w+ bot|hand (it|this) to|let me show you|i'?ll show you|watch me (do|while)|teach you)\b/
const MINE_MAIL = /\b(my|our) (\w+ )?(calendar|inbox|e-?mails?|mail|gmail|outlook|messages?|texts?|notes|reminders?|contacts|slack|events?|meetings?|appointments?|schedule|shopping list|to-?do list)\b|\bwhat did \w+ say\b|\b(her|his|their|the) last (e-?mail|message)\b|\blatest e-?mail\b|\b(emailed|texted|messaged|called|dm'?d) me\b|\bany (new )?(messages|e-?mails|mail|texts|replies)\b|\bmy \d{1,2}(:\d\d)? ?(am|pm)?\b.*\b(to|until|with)\b|\b(move|reschedule|push|cancel) my \w+ (with|to|meeting|call)\b/
const FILE_ACT = /\b(organi[sz]e|move|rename|clean ?up|tidy|back ?up|sort|archive|delete|find|copy|zip|list)\b/
const MINE_FILES = /\b(my|our|the) (\w+ )?(files|folders?|downloads|documents|desktop|photos|pictures|workspace)\b|~\/|\/users\/|(^|\s)\/[\w.-]+\/[\w.-]+/
const TOOLS_OBJ = /\b(e-?mails?|inbox|gmail|outlook|calendar|meetings?|invites?|appointments?|reminders?|slack|notion|linear|jira|asana|trello|hubspot|salesforce|crm|tickets?|dropbox|onedrive|google drive|newsletters?|unread|mentions|channel|deal|#[a-z][\w-]+|slot)\b/
const TOOLS_ACT = /\b(snooze|mark (them |it )?(as )?read|star|flag|mute|message|notify|ping|dm|send|check|find|move|reply|forward|schedule|book|add|create|remind|organi[sz]e|clean ?up|tidy|archive|label|delete|accept|decline|cancel|unsubscribe|rename|back ?up|post|update|log|assign|summari[sz]e|go through|look up|text|tell)\b/
const CONNECTED = /\b(in|on|from) (pagerduty|jira|linear|github|sentry|datadog|stripe|shopify|notion|asana|hubspot|salesforce)\b/

// Documents and data
const OFFICE_OBJ = /\b(handouts?|leaflets?|brochures?|one-pagers?|brief|write-?up|google docs?|spreadsheets?|excel|xlsx|csv|google sheets?|sheets?|pivot( table)?|v?lookup|charts?|graphs?|dashboards?|slides?|slide deck|deck|powerpoint|pptx|presentations?|word (doc(ument)?|file)|docx|pdfs?|report|memo|invoices?|resume|cv|financial model|dcf|3-statement|gantt( chart)?|business plan|(launch|project|marketing|go-to-market|content|training|lesson) plan|one-pager|pitch deck|budget|tracker|totals?|columns?|data ?set|in word)\b/
/** A document named by its file name (summary.md, notes.txt). */
const FILE_NAME = /\b[\w-]+\.(md|txt|pdf|docx?|xlsx?|csv|pptx?|rtf|key|numbers|pages)\b/
const OFFICE_MAKE = /\b(make|create|build|put together|turn|convert|draft|write|prepare|generate|design|analy[sz]e|summari[sz]e|clean up|add|fill|update|recalculate|format|export|tailor|extract|save)\b/

// Research
const RESEARCH = /\b(meta-?analys[ie]s|systematic reviews?|clinical trials?|side effect profiles?|fda labels?|size the market|market size|alternatives to|what people (recommend|say|think)|everything (you can find|there is to know)|all you can find|consensus|links to (studies|sources)|leading (suppliers|companies|players|vendors|makers|brands)|how do they compare|market leaders|dig (into|up)|find (\w+ ){0,2}(papers|studies|articles)|gather (everything|all)|everything (public|online|known)|dig up|compile (a list|everything)|research|deep dive|literature review|investigate|look into|find (out|sources|studies|papers)|studies|evidence|with (sources|citations)|use sources|sources|cite|citations?|market (scan|analysis|research|size)|competitive (analysis|landscape)|competitors?|competitor|state of the art|latest (developments|on|news|research)|what('?s| is| are) the (latest|current)|news (on|about)|briefing|top \d+|compare the top|ranked list|search for the best|(analysis|comparison) (of|comparing)|comparing (our|the|two|three|\d+))\b/
/** Research that is the hardest tier: a big synthesis, many options, a written deliverable. */
const RESEARCH_HARD = /\b(meta-?analys[ie]s|systematic reviews?|pmids?|clinical trials?|guidelines?|side effect profiles?|fda labels?|size the market|market size|consensus|competitors?|find (\w+ ){0,2}(papers|studies)|key findings|thorough|deep dive|literature review|investigate|market (analysis|research)|competitive (analysis|landscape)|briefing|citations|top \d+|compare the top|ranked list|find studies|evidence|comprehensive|in-depth|report|then)\b/
const RESEARCH_DEEP = /\b(meta-?analys[ie]s|systematic reviews?|pmids?|clinical trials?|side effect profiles?|fda labels?|size the market|consensus|links to|how do they compare|leading \w+|dig into|find (\w+ ){0,2}(papers|studies|articles)|gather|everything|research|find out|deep dive|literature review|investigate|look into|market (analysis|research)|competitive (analysis|landscape)|briefing|citations|top \d+|compare the top|ranked list|with sources|use sources|find studies|search for the best|comprehensive|in-depth|report|then)\b/

// Writing
const WRITING = /\b(write|rewrite|re-write|draft|edit|proofread|polish|reword|rephrase|tighten|copy ?edit|essay|blog( post)?|article|story|poem|haiku|cover letter|bio|newsletter|speech|caption|taglines?|headline|press release|letter|(e-?mail) (to|for)|linkedin post|tweet|toast|eulogy|wedding|personal statement|statement of purpose|copy for|hero section|sound (less|more) \w+|cut it to|less formal|more formal|novel|lyrics|write about|(reply|respond) to this|help me (reply|respond|word|phrase))\b/
const WRITING_SHORT = /\b(haiku|poem|taglines?|tweet|rewrite this|edit this|make this|cut it to|reword|rephrase|less formal|more formal|sound (less|more))\b/

// Difficulty and effort signals
const HARD = /\b(architecture|design (a|the) system|from scratch|end[- ]to[- ]end|entire|whole (app|codebase|project|thing|system)|complex|complicated|in[- ]depth|thorough(ly)?|comprehensive|exhaustive|detailed (analysis|report|plan)|production[- ](ready|quality|grade)|production|perfect(ly)?|carefully|best possible|multi-?step|literature review|deep dive|competitive analysis|market analysis|financial model|forecast|dcf|3-statement|pitch deck|business plan|launch plan|go-to-market|memory leak|every (form|page|file|module|endpoint|screen|place)|all the (forms|pages|modules|endpoints)|security|vulnerab\w*|full assembly|interferences?|for investors|whatever breaks|find out why|figure out (what|why)|feedforward)\b/
const BIG_CODE = /\b(stripe|payments?|subscriptions|billing|webhooks|refactor|migrat\w*|profile it|unbeatable|game|port|bump|upgrade|optimi[sz]e|oauth|sso|design the|scaffold|extension|investigate|tune)\b/
/** A request to make or edit a picture. */
export const IMAGE_RE = /\b(draw|paint|sketch|illustrate|generate|create|make|design|render|edit|turn)\b[^.?!\n]{0,60}\b(images?|pictures?|pics?|photos?|drawings?|illustrations?|logos?|icons?|posters?|art(work)?|wallpapers?|stickers?|avatars?|banners?|thumbnails?|portraits?|cartoons?|memes?)\b|\b(an? |the )?(image|picture|drawing|illustration) of\b|\b(draw|paint|sketch|illustrate) (me |us )?(an?|the|my|some)\b/i

/** School work: words that mean it on their own. */
const STUDY = /\b(home ?work|hw|worksheets?|quiz(zes)?|exams?|midterms?|finals week|study(ing)? (guide|for)|studying|flash ?cards?|practice (problems?|questions?|test)|textbooks?|teacher|in class|for (my )?class\b(?! names?| selector| component)|my class(es)? at school|schoolwork|school (project|assignment|essay|paper|work)|for school|at school|semester|gpa|syllabus|lab report|ap (bio|chem|physics|calc|csp?|lang|lit|euro|world|us history|gov|psych|stats)|apush|chemistry|chem (class|test|quiz|homework|hw|lab|exam)|chemical (equations?|reactions?|formulas?)|balance (this|the|these) (chemical )?equations?|biology|bio (class|test|quiz|homework|hw|lab|exam)|physics (class|test|quiz|homework|hw|problems?|exam)|algebra|geometry|pre-?calc(ulus)?|calculus|trig(onometry)?|stoichiometry|molar mass|moles? (of|ratio|to|per)\b|mole ratio|\d+(\.\d+)? ?mol\b|periodic table|isotopes?|hydrate lab|ionic (bonds?|compounds?)|covalent|photosynthesis|mitosis|meiosis|cell biology|newton's laws|vocab(ulary)? (list|words|quiz)|book report|reading log|essay for|duolingo)\b/
/** A bot whose role is school: vague requests there are school work too. */
const STUDY_ROLE = /\b(school|study|studying|student|homework|tutor|class(es)?|teacher)\b/

const STAKES = /\b(legal|lawsuit|sue|lease|contract|landlord|security deposit|court|custody|immigration|visa|medical|diagnos\w*|symptoms?|side effects?|dosage|medication|worried|mole|rash|lump|tax(es)?|deduct\w*|w-2|1099|isos?|rsus?|investments?|invest|retirement|mortgage|emergency fund|t-bills|savings|production|customers|outage|security|bank|med school|investors|go(ing)?-concern|risks?)\b/

/**
 * A clinical question (doses, interactions, lab values, warning signs, a named drug): high stakes, so the
 * strongest model and the medical sources. Definitions ("what is PSA density") stay light.
 */
const DRUG_NAME = /\b[a-z]{3,}(osin|olol|pril|sartan|statin|afil|mab|nib|cillin|mycin|floxacin|azole|prazole|gliflozin|gliptin|glutide|dronate|terol|lukast|oxetine|triptan|azepam|semide|thiazide|parin|xaban|gatran|profen|coxib|lutamide|steride|relix|relin|platin|taxel)\b|\b(ibuprofen|acetaminophen|tylenol|aspirin|metformin|insulin|warfarin|prednisone|oxybutynin|mirabegron|vibegron|botox|testosterone|estrogen|antibiotics?)\b/
const CLINICAL_STRONG = /\b(creatinine|egfr|psa|a1c|hba1c|potassium|troponin|hemoglobin|platelets?|white (blood )?count|wbc|sepsis|septic|overdose|warning signs?|red flags?|came back (at|high|low|positive|negative))\b/
const CLINICAL_WEAK = /\b(dos(e|es|ing|age)|starting dose|max(imum)? dose|interact\w*|together|take .{0,40}\b(with|and)\b|mix|contraindicat\w*|side effects?|safe (to|with|for)|allerg\w*|pregnan\w*|treat(ment)? for|first[- ]line)\b/
const DEFINITION = /^((can you )?explain |tell me )?(what('?s| is| are| does)?|define|meaning of)\b(?!.{0,60}\b(my|i|dose|dosing|signs?|safe|take|interact\w*|together|treat\w*|normal|high|low)\b)/
/** Medical literature: guidelines, trials, meta-analyses, PMIDs, FDA labels (the research tool's sources). */
const MED_LIT = /\b(meta-?analys[ie]s|systematic reviews?|pmids?|pubmed|clinical trials?|rcts?|randomi[sz]ed trials?|guidelines?( recommendations)?|fda labels?|side effect profiles?|trials)\b/
/** Coding agents SahilBot can drive: Cursor (cloud and local agents), Codex, Claude Code. */
const CODING_AGENT = /\b(cursor('s)? (cloud |local |background )?agents?|codex|claude code|coding agents?|copilot (coding )?agent)\b|\bto cursor\b|\bcursor\b.{0,60}\b(pr|pull request|repo|diff|bug|branch|merge)\b|\b(pr|pull request|diff)\b.{0,60}\bcursor\b/
/** Getting around: directions, distances, places nearby (the maps tool). */
const TRAVEL = /\b(directions|driving|drive (from|to)|the drive|walk(ing)? (directions|from|to)|transit|how far|distance|travel times?|near(by| me)?|closest|nearest|open (now|tonight|today)|routes?|itinerary|things to do|weekend (in|near|trip))\b/
/** Several places compared or routed between: research with the maps tool. */
const TRAVEL_COMPARE = /\b(which of (these|the)|each of these|between (each|all) of|these \d+ \w+|compare (the )?(drive|travel|distance|commute))\b/
const BOOKING = /\b(book|reserve) (a |me a |us a )?(table|room|flight|hotel|appointment|tickets?|reservation)\b|\bmake a reservation\b/
/** An engineering calculation (structures, mechanisms) worked out, not a CAD model. */
const ENG_CALC = /\b(calculate|compute|estimate|what('?s| is) the (max(imum)?|required)|how much)\b.{0,80}\b(deflection|stress|strain|torque|moment|bending|load|buckling|safety factor|shear|beam|cantilever|gear ratio)\b/
const DECISION = /\b(is it legal|am i allowed|is it (safe|ok) to|can i be (sued|fired)|should i|should we|is it worth|walk me through|which is better|or stay|can my)\b/
const LONG_OUTPUT = /\b(\d{1,2},?\d{3}[- ]words?|\d+k[- ]words?|novel|book|whole manual|comprehensive|full report|literature review|10\+? slides|\d{2} slides)\b/
const MULTI = /\b(and then|after that|then|once (that'?s|it'?s) done|finally)\b|,\s*(and )?(then )?(make|email|send|build|write|add|open|create|draft|save|post|remind|report|compare) (it|them|this|that|the|a|an|me|my|to|everything)\b/
const LIVE = /\b(latest|current(ly)?|today|tonight|tomorrow|yesterday|last night|this (week|month|year)|right now|news|price|prices|stock|weather|score|release date|recent(ly)?|202\d|up[- ]to[- ]date)\b|https?:\/\//
const ADVICE = /\b(itinerary|plan a|routine|recommend(ation)?s?|how should|what'?s a good|pros and cons|tips|advice|overwhelmed|stressed|anxious|depressed|lonely|vent|sad|grief|pain|injury|diet|ira|401k|roth|mortgage|tax(es)?|invest(ing|ment)?|budgeting)\b/
const QUICK = /\b(quick|quickly|just|simple|simply|briefly|one-liner|small|tiny|short answer)\b/
const EXPLICIT_MAX = /\b(think as hard as (you )?(can|possibly can)|as hard as you possibly can|max(imum)? effort|ultrathink|think harder than ever)\b/
const EXPLICIT_HIGH = /\b(think (really |very )?(hard|carefully|deeply)|take your time|be careful|double[- ]check)\b/

/** Orders to operate something (the fallback for agent work nothing else claimed). */
const OPERATE = /^(please |can you |could you |pls )?(open|close|move|copy|paste|delete|remove|install|uninstall|set up|connect|sync|upload|download|export|import|print|scan|send|post|order|cancel|return|schedule|add|update|change|rename|organi[sz]e|clean|archive|save|back up|run|start|stop|restart|turn (on|off)|enable|disable|track|record|ship|get (the|my|it|this)|block|share|invite|mute|pin|sort|merge|split|attach|forward|reply|check)\b/
/** Telling someone something on a chat app ("tell Jordan on Teams that …"). */
const MESSAGE_ON = /\b(tell|message|text|ping|dm|notify) [\w ]{1,25}\b(on|via|in|over) (slack|teams|whatsapp|imessage|discord|signal|telegram|messenger)\b/
const LEVEL_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const has = (re: RegExp, t: string): boolean => re.test(t)
const countWords = (t: string): number => t.split(/\s+/).filter(Boolean).length

/** How much a request asks for, read from its shape instead of its topic words. */
export interface RequestShape { words: number; asks: number; constraints: number; specifics: number; codeLines: number; tier: Tier; acts: boolean }
const SEQUENCE = /\b(and then|then|after that|afterwards|also|plus|as well as|next|finally|once done|once that'?s done)\b|;/gi
// A list of three or more things in one sentence ("web use, computer use and the UI").
const ENUMERATION = /\b[\w'-]+(?: [\w'-]+){0,3}, [\w'-]+(?: [\w'-]+){0,3},? (?:and|or) [\w'-]+/gi
const CONSTRAINT = /\b(must|without|only|at least|at most|no more than|exactly|make sure|ensure|never|always|don'?t|do not|has to|have to|so that|while keeping|within|under \$?\d[\d,k]*|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|\d))\b/gi
const SPECIFIC = /(https?:\/\/\S+|[~.]?\/[\w.-]+\/[\w./-]+|\b\w+\.(ts|tsx|js|py|md|pdf|docx|xlsx|csv|json|swift|java)\b|\b[a-z]+[A-Z]\w+\b|\b\w+_\w+\b|\$?\b\d[\d,.]*k?\b)/g
// A later step done outside the reply ("…, then email it to my dad", "… and book the hotels"): agent work.
const OUTWARD_STEP = /(?:,|;|\band\b|\bthen\b|^)\s*(?:then\s+|also\s+)?(e-?mail|send|text|message|post|book|reserve|order|buy|save|upload|schedule|open|install|run|make|create|put|turn|export|share|add)\s+(it|them|this|that|those|these|the|a|an|me|my|to|us|everything)\b/
export function requestShape(raw: string): RequestShape {
  const code = (raw.match(/```[\s\S]*?```/g) ?? []).join('\n')
  const unfenced = raw.replace(/```[\s\S]*?```/g, '\n')
  // "Edit this …:" then pasted text: the pasted part is material to work on, not more asks.
  const lead = unfenced.match(/^([\s\S]{12,400}?):\s*\n/)
  const text = lead && countWords(lead[1]) >= 3 ? lead[1] : unfenced
  const words = countWords(text)
  const lines = text.split('\n')
  const listItems = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length
  const sentences = text.split(/(?<=[.?!])\s+|\n+/).filter((x) => countWords(x) >= 3).length
  const asks = Math.max(1, sentences, listItems) + Math.min(3, (text.match(SEQUENCE) ?? []).length) + Math.min(2, (text.match(ENUMERATION) ?? []).length)
  const constraints = (text.match(CONSTRAINT) ?? []).length
  const specifics = (text.match(SPECIFIC) ?? []).length
  const codeLines = code ? code.split('\n').length : 0
  const pts = (asks >= 5 ? 3 : asks >= 3 ? 2 : asks >= 2 ? 1 : 0) + (constraints >= 4 ? 2 : constraints >= 2 ? 1 : 0) + (words >= 120 ? 2 : words >= 40 ? 1 : 0) + (specifics >= 6 ? 1 : 0) + (codeLines >= 30 ? 2 : codeLines >= 6 ? 1 : 0)
  const steps = normalizeRequest(text).split(/(?<=[.?!])\s+|\n+/).slice(0, 12)
  // An outward step that isn't the request's own opening (that one the category rules already read).
  const acts = steps.some((x, i) => { const m = x.match(OUTWARD_STEP); return !!m && (i > 0 || (m.index ?? 0) > 0) })
  return { words, asks, constraints, specifics, codeLines, tier: (pts >= 4 ? 3 : pts >= 2 ? 2 : 1) as Tier, acts }
}

// ---------------------------------------------------------------------------------------------------
// Obviously quick asks. Strict, anchored shapes only: the whole message is the ask (nothing before or after it),
// and the material is short and literal. Anything that names a document, a file, code or more than a sentence or
// two is left to the other rules (and Auto's brain). tests/unit/auto-latency.test.ts checks that no labelled
// request of difficulty 2+ (tests/fixtures/routing-eval.json) reads as quick.
// ---------------------------------------------------------------------------------------------------

export type QuickAsk = 'sum' | 'conversion' | 'translation' | 'typo-fix'

const LANGS = '(?:english|spanish|french|german|italian|portuguese|dutch|swedish|norwegian|danish|finnish|polish|czech|russian|ukrainian|greek|turkish|arabic|hebrew|hindi|urdu|bengali|punjabi|tamil|telugu|gujarati|marathi|chinese|mandarin|cantonese|japanese|korean|vietnamese|thai|indonesian|malay|filipino|tagalog|swahili|latin|persian|farsi|romanian|hungarian|irish|welsh|catalan|croatian|serbian|bulgarian|slovak|slovenian|lithuanian|latvian|estonian|icelandic)'
const UNIT = '(?:mm|cm|km|m|meters?|metres?|kilometers?|kilometres?|centimeters?|centimetres?|millimeters?|millimetres?|inch(?:es)?|ft|feet|foot|yards?|yd|miles?|mi|mg|g|grams?|kg|kilograms?|kilos?|lbs?|pounds?|oz|ounces?|stones?|tons?|tonnes?|ml|milliliters?|millilitres?|l|liters?|litres?|cups?|tablespoons?|tbsp|teaspoons?|tsp|quarts?|qt|pints?|pt|gallons?|gal|fl oz|fluid ounces?|°\s?[cf]|degrees? (?:c|f|celsius|fahrenheit)|[cf]|celsius|fahrenheit|kelvin|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|kb|mb|gb|tb|kilobytes?|megabytes?|gigabytes?|terabytes?|mph|km/h|kph|m/s|knots?|acres?|hectares?|sq ?ft|square (?:feet|foot|meters?|metres?|miles?|kilometers?|kilometres?)|calories|kcal|kj|joules?|kw|kwh|psi|radians?)'
const NUM = '-?\\d[\\d,]*(?:\\.\\d+)?'
const CONVERT = [
  new RegExp(`^(?:(?:please |quick:? )?(?:convert|what(?:'s| is)|how much is|how many \\S+ (?:is|are))\\s+)?${NUM}\\s*${UNIT}\\s+(?:to|in|into|in terms of)\\s+${UNIT}\\s*\\??$`),
  new RegExp(`^how many ${UNIT} (?:are )?(?:in|per) (?:a |an |one |${NUM} )?${UNIT}\\s*\\??$`)
]
const ARITH = /^(?:(?:what(?:'s| is)|calculate|compute|how much is|quick:?)\s+)?\(?\s*-?\d[\d,]*(?:\.\d+)?(?:\s*(?:[-+*/×÷^]|\bx\b|\btimes\b|\bplus\b|\bminus\b|\bdivided by\b)\s*\(?\s*-?\d[\d,]*(?:\.\d+)?\s*\)?)+\s*(?:=\s*)?\??$/
const PERCENT = /^(?:(?:what(?:'s| is)|calculate|compute|how much is)\s+)?\d[\d,]*(?:\.\d+)?\s*(?:%|percent) of \$?\d[\d,]*(?:\.\d+)?\s*\??$/
const TRANSLATE = [
  new RegExp(`^(?:please |can you |could you )?translate\\s+(.+?)\\s+(?:in)?to\\s+${LANGS}\\s*[.!?]?$`),
  new RegExp(`^(?:please |can you |could you )?translate (?:in)?to ${LANGS}\\s*[:\\-–]\\s*(.+)$`),
  new RegExp(`^how (?:do|would|can) (?:you|i|we) say\\s+(.+?)\\s+in\\s+${LANGS}\\s*\\??$`)
]
const TYPO = /^(?:please |can you |could you )?(?:fix|correct|check)\s+(?:the |any |my )?(?:typos?|spelling|grammar|punctuation)(?:\s+(?:and|&)\s+(?:typos?|spelling|grammar|punctuation))?(?:\s+(?:mistakes?|errors?))?(?:\s+(?:in|of|on))?(?:\s+(?:this|the|my))?(?:\s+(?:sentence|text|line|phrase|message|caption|title|tweet|reply|note))?\s*[:\-–]\s*(.+)$/s
/** Material that is more than a short literal piece: a document, a file, code, a page. */
const NOT_LITERAL = /\b(document|doc|docx|file|files|pdf|page|pages|website|site|app|apps|code|function|script|class|article|book|chapter|manual|essay|report|paragraphs|slides?|deck|spreadsheet|readme|docs|ui|strings|repo|email thread|attachment|folder)\b/
const BARE_REF = /^(this|that|it|these|those|them|everything|all of (it|this)|the (text|above|following|rest)|my (text|message|notes))$/
const CODEY = /```|`|[{};<>]|=>|\b[\w/-]+\.(ts|tsx|js|jsx|py|rs|go|swift|java|kt|cpp|rb|php|sql|sh|css|html|json|md)\b/

const sentences = (s: string): number => s.split(/(?<=[.!?。！？])\s+(?=\S)/).filter((x) => x.trim()).length
const unquote = (s: string): { text: string; quoted: boolean } => {
  const m = s.trim().match(/^["“'‘«](.+)["”'’»]$/s)
  return m ? { text: m[1], quoted: true } : { text: s.trim(), quoted: false }
}

/**
 * The ask, when the whole message is one obviously quick thing: a sum or a percentage, a unit conversion, a
 * translation of a short sentence (up to 25 words, one sentence), or a typo fix of a short text (up to 60 words,
 * two sentences, one paragraph). Undefined for anything else, including anything that names a document, a file,
 * code, or carries more than that.
 */
export function quickAsk(text: string): QuickAsk | undefined {
  const raw = (text ?? '').trim()
  if (!raw || raw.length > 600) return undefined
  const t = raw.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ')
  if (raw.length <= 120 && (ARITH.test(t) || PERCENT.test(t))) return 'sum'
  if (raw.length <= 120 && CONVERT.some((re) => re.test(t))) return 'conversion'
  if (!/\n/.test(raw.trim())) {
    for (const re of TRANSLATE) {
      const m = t.match(re)
      if (!m) continue
      const p = unquote(m[1])
      if (!p.text || countWords(p.text) > 25 || sentences(p.text) > 1 || CODEY.test(p.text) || BARE_REF.test(p.text)) return undefined
      if (!p.quoted && NOT_LITERAL.test(p.text)) return undefined
      return 'translation'
    }
  }
  const typo = t.match(TYPO)
  if (typo) {
    const p = unquote(typo[1])
    if (!p.text || /\n\s*\n/.test(raw) || countWords(p.text) > 60 || sentences(p.text) > 2 || CODEY.test(p.text) || BARE_REF.test(p.text)) return undefined
    return 'typo-fix'
  }
  return undefined
}

/** Role prior: what the bot's instructions say it does (a vague request inherits it). */
function roleCategory(role?: string): TaskCategory | undefined {
  if (!role) return undefined
  const r = normalizeRequest(role)
  if (has(CAD_STRONG, r)) return 'cad'
  if (has(/\b(code|coding|repo|programm\w*|developer|engineer(ing)? (bot|assistant)|software|robot code)\b/, r)) return 'coding'
  if (has(/\b(spreadsheet|bookkeep\w*|expenses|accounting|finances spreadsheet|slides|deck)\b/, r)) return 'office'
  if (has(/\b(news|research|sources|analyst|tracks)\b/, r)) return 'research'
  if (has(/\b(blog|editor|writer|writing|copy)\b/, r)) return 'writing'
  if (has(/\b(email|inbox|calendar|assistant for my (mail|calendar))\b/, r)) return 'agent-tools'
  if (has(/\b(math|calculus|algebra)\b/, r)) return 'math'
  return undefined
}

// ---------------------------------------------------------------------------------------------------
// Calibration: how often each decision path is right on the eval set (smoothed precision), so `confidence`
// means what it says. Recomputed by tests/unit/routing-eval.test.ts (it fails when a path drifts by > 0.2).
// ---------------------------------------------------------------------------------------------------

export const RULE_CONFIDENCE: Record<string, number> = {
  // Specific paths: right on every dev item and every blind holdout item they fired on (small n each): ~0.9.
  voice: 0.95, 'long-context': 0.95, 'follow-up': 0.9, 'follow-up:new': 0.8, 'deep-research': 0.95, 'small-talk': 0.95, empty: 0.85,
  incident: 0.85, 'computer-use': 0.9, 'computer-use:url': 0.9, shopping: 0.85, cad: 0.9,
  coding: 0.92, 'coding:project': 0.88, 'code-quick': 0.85, 'code-quick:snippet': 0.85,
  'agent-tools:self': 0.9, 'agent-tools:relay': 0.9, 'agent-tools:mine': 0.9, 'agent-tools:files': 0.85, 'agent-tools:folder': 0.7, 'agent-tools:video': 0.85,
  math: 0.9, research: 0.85, office: 0.9, 'office:file': 0.9, vision: 0.9, 'role-prior': 0.75, 'research:role': 0.7, 'writing:role': 0.7,
  // Blind holdout 2 (written after tuning, measured before any fix): connector 2/4, writing 3/5.
  'agent-tools:connector': 0.75, writing: 0.8, 'office:weak': 0.6, 'agent-tools:weak': 0.6,
  // The fallbacks, where the rules run out (blind: chat 5/12, chat:question 5/9): below CONFIDENT.
  imperative: 0.5, chat: 0.55, 'chat:question': 0.65,
  // Added with holdout 4 (medical, travel, business, engineering, coding agents).
  booking: 0.85, 'math:engineering': 0.85, 'coding:agent': 0.85, 'research:travel': 0.75
}

interface Picked { category: TaskCategory; rule: string; why: string }

/**
 * The request, decided: category, difficulty, chat or agent, effort and a calibrated confidence. `text` is the
 * user's message; `ctx` is what the app knows. The most specific need wins (voice, a huge input, a follow-up,
 * the screen, CAD, code, …); every rule is in docs/model-routing.md ("Rubrics" and "The classifier").
 */
export function classifyTask(text: string, ctx: TaskContext = {}): TaskClass {
  const raw = (text ?? '').trim()
  const t = normalizeRequest(raw)
  const words = countWords(raw)
  const atts = ctx.attachments ?? []
  const images = (ctx.images ?? 0) + atts.filter((a) => a.kind === 'image').length
  const folders = Math.max(ctx.folders ?? 0, atts.filter((a) => a.kind === 'folder').length)
  const fileAtts = atts.filter((a) => a.kind !== 'folder' && a.kind !== 'image')
  const files = Math.max(ctx.files ?? 0, fileAtts.length)
  const fileNames = fileAtts.map((a) => (a.name || a.path || '').toLowerCase()).join(' ')
  const inputTokens = Math.max(0, Math.round(ctx.inputTokens ?? 0))
  const contextTokens = Math.max(inputTokens, Math.round(ctx.contextTokens ?? 0))
  // "Can you do X for me" is a request; "What can you do for me?" is still a question.
  const question = has(QUESTION, t) && !(has(POLITE_DO, t) && !/^(what|which|why|how|who|when|where)\b/.test(t))
  const prevCat = ctx.previousCategory && ctx.previousCategory !== 'voice' ? ctx.previousCategory : undefined
  const followUp = !!prevCat && words <= 14 && has(FOLLOW_UP, t)
  const planFollow = !!ctx.openPlan && words <= 20 && !!prevCat
  const roleCat = roleCategory(ctx.role)
  // The CAD module's own reading (cad/cad-intent.ts): a build or change in CAD is always agent work.
  const cad = cadSignals(raw)
  const codeish = !has(NOT_CODE, t) && (has(CODE_STRONG, t) || has(BUILD_APP, t) || ((ctx.codeProject || roleCat === 'coding') && has(CODE_WEAK, t)))
  const officeDeliverable = (has(OFFICE_OBJ, t) || has(FILE_NAME, t)) && has(OFFICE_MAKE, t)
  // A document named up front ("Create a resume in Word from …") beats code words further on (skills, data).
  const head = t.split(/\s+/).slice(0, 10).join(' ')
  const officeFirst = !ctx.codeProject && officeDeliverable && has(OFFICE_OBJ, head) && has(OFFICE_MAKE, head) && !has(CODE_STRONG, head) && !has(BUILD_APP, head)
  const docFile = /\.(pdf|docx?|xlsx?|csv|pptx?|key|numbers|pages|txt|md|rtf|json)\b/.test(fileNames)

  // ---- category
  const pick = ((): Picked => {
    if (ctx.voice) return { category: 'voice', rule: 'voice', why: 'a voice conversation' }
    if (inputTokens >= LONG_CONTEXT_TOKENS) return { category: 'long-context', rule: 'long-context', why: `about ${Math.round(inputTokens / 1000)}K tokens to read` }
    // "yes, do it" / "continue" / "make it shorter": the same work as before, unless it names a new deliverable.
    if (followUp || planFollow) {
      if (/\b(slides?|deck|presentation|spreadsheet|sheet|pdf|word doc|document|chart|dashboard)\b/.test(t) && prevCat !== 'office') return { category: 'office', rule: 'follow-up:new', why: 'turns it into a document' }
      if (/^(send|email|post|forward) (it|this|that)\b/.test(t) && prevCat !== 'agent-tools') return { category: 'agent-tools', rule: 'follow-up:new', why: 'sends it' }
      return { category: prevCat!, rule: 'follow-up', why: 'follow-up to the last request' }
    }
    if (ctx.deepResearch) return { category: 'research', rule: 'deep-research', why: 'Deep Research' }
    if (!raw || /^[^\p{L}\p{N}]*$/u.test(raw) || (words === 1 && raw.length <= 2)) return { category: images ? 'vision' : 'chat', rule: images ? 'vision' : 'empty', why: images ? 'looks at an image' : 'nothing to do yet' }
    if ((has(GREETING, t) && words <= 4) || (words <= 12 && has(THANKS_ONLY, t)) || /^(please )?just say (hi|hello)\b/.test(t) || /^tell me a joke\b/.test(t)) return { category: 'chat', rule: 'small-talk', why: 'small talk' }
    if (has(INCIDENT, t) && has(/\b(deploy\w*|site|server|app|api|production)\b/, t)) return { category: 'coding', rule: 'incident', why: 'a production incident' }
    if (!question && has(URL_OPEN, t)) return { category: 'computer-use', rule: 'computer-use:url', why: 'opens a page' }
    if (!question && has(COMPUTER, t) && !(has(CODE_STRONG, t) && !/\b(safari|chrome|browser|screen|click)\b/.test(t))) return { category: 'computer-use', rule: 'computer-use', why: 'uses the screen' }
    if (!question && has(SHOP, t) && !has(/\b(should i|which|what|best)\b/, t)) return { category: 'computer-use', rule: 'shopping', why: 'shopping' }
    if (!question && has(BOOKING, t)) return { category: 'computer-use', rule: 'booking', why: 'books it' }
    // A worked engineering calculation is math, even with materials and shapes in it (a CAD model is built below).
    if (has(ENG_CALC, t) && !has(/\b(onshape|freecad|fusion|solidworks|cad|stl|step file|3d print|model it)\b/, t)) return { category: 'math', rule: 'math:engineering', why: 'an engineering calculation' }
    if (cad.build) return { category: 'cad', rule: 'cad', why: cad.assembly ? 'builds a CAD assembly' : 'builds in CAD' }
    if (has(CAD_STRONG, t) || ((t.match(new RegExp(CAD_WEAK.source, 'g')) ?? []).length >= 2 && (question || has(/\b(design|model|make|add|print|export|thick\w*|mount)\b/, t))) || (has(CAD_WEAK, t) && (/\b(\d+ ?mm|nema|bracket|enclosure|housing|gearbox|tolerance|press[- ]fit|infill|layer height|nozzle|(a|the|my|waterproof|pla|petg|resin) print)\b/.test(t)) && (has(/\b(design|model|make|add|print|export|fillet|extrude|thick|wall|holes?)\b/, t) || question))) return { category: 'cad', rule: 'cad', why: 'CAD work' }
    if (/\.(step|stp|stl|sldprt|f3d|fcstd|iges?)\b/.test(fileNames)) return { category: 'cad', rule: 'cad', why: 'a CAD file' }
    // A video made with the user's HeyGen app (tools/video.ts): credits and a file, so agent work.
    if (!question && has(VIDEO_RE, t)) return { category: 'agent-tools', rule: 'agent-tools:video', why: 'makes a video with HeyGen' }
    if (has(MESSAGE_ON, t)) return { category: 'agent-tools', rule: 'agent-tools:self', why: 'a message on a chat app' }
    // Driving a coding agent (Cursor, Codex, Claude Code): coding work, unless it's only a question about them.
    if (has(CODING_AGENT, t) && !/\b(write|draft) (a |the |me a )?(task )?(brief|prompt|spec)\b/.test(t) && !(question && !has(CODE_ACT, t) && !/\b(check|review|status|merge|safe to)\b/.test(t))) return { category: 'coding', rule: 'coding:agent', why: 'drives a coding agent' }
    // Distances or routes between several places: research with the maps tool.
    if (has(TRAVEL, t) && has(TRAVEL_COMPARE, t)) return { category: 'research', rule: 'research:travel', why: 'compares places on the map' }
    if (!officeFirst && (codeish || (ctx.codeProject && has(CODE_ACT, t) && !officeDeliverable && !has(WRITING, t)))) {
      const explainOnly = has(EXPLAIN_ONLY, t)
      const snippet = has(SNIPPET, t) && words <= 22 && !ctx.codeProject
      const acting = !explainOnly && (/```|traceback|\b[a-z]+error\b/.test(t) || (has(CODE_ACT, t) && !question))
      if (snippet && !/```/.test(t)) return { category: 'code-quick', rule: 'code-quick:snippet', why: 'a short snippet' }
      if (!acting && !ctx.codeProject && !ctx.heavy && !ctx.team) return { category: 'code-quick', rule: 'code-quick', why: 'a question about code' }
      if (!acting && question) return { category: 'code-quick', rule: 'code-quick', why: 'a question about code' }
      return { category: 'coding', rule: has(CODE_STRONG, t) || has(BUILD_APP, t) ? 'coding' : 'coding:project', why: 'changes code' }
    }
    // Electrical engineering (circuits, power, components): a math-like category with its own EEBench row (domain).
    if (has(ELECTRICAL, t) && !officeDeliverable && !(files && docFile)) return { category: 'math', rule: 'electrical', why: 'electrical engineering' }
    if (has(MATH, t) && !officeDeliverable && !(files && docFile)) return { category: 'math', rule: 'math', why: 'math' }
    if (has(SELF, t) || has(/\b(remind me|set a timer|daily briefing)\b/, t)) return { category: 'agent-tools', rule: 'agent-tools:self', why: 'a reminder, routine or message' }
    if (has(RELAY, t)) return { category: 'agent-tools', rule: 'agent-tools:relay', why: 'another bot or a recording' }
    if (!officeDeliverable && has(MINE_MAIL, t) && !question || (has(MINE_MAIL, t) && /\b(what|which|when|who|any)\b/.test(t) && !has(WRITING, t))) return { category: 'agent-tools', rule: 'agent-tools:mine', why: 'mail, calendar or notes' }
    if (has(MINE_FILES, t) && has(FILE_ACT, t) && !officeDeliverable) return { category: 'agent-tools', rule: 'agent-tools:files', why: 'works on files' }
    if (has(/(^|\s)(read|cat|open) (~|\/)[\w./-]+/, t)) return { category: 'agent-tools', rule: 'agent-tools:files', why: 'reads a file' }
    if (!officeFirst && has(RESEARCH, t) && (words > 6 || has(RESEARCH_DEEP, t)) && !(files && docFile && !has(RESEARCH_DEEP, t))) return { category: 'research', rule: 'research', why: 'research' }
    if (has(TOOLS_OBJ, t) && has(TOOLS_ACT, t) && !officeDeliverable && !(has(WRITING, t) && !/\b(send|post|forward|schedule|invite|archive|unsubscribe)\b/.test(t))) return { category: 'agent-tools', rule: 'agent-tools:connector', why: 'a connected app' }
    if (has(/\b(task|project|creative|design) brief\b/, t) && !has(/\b(doc|document|pdf|word|file|google docs?)\b/, t)) return { category: 'writing', rule: 'writing', why: 'a brief in the reply' }
    if (officeDeliverable && !(question && !files)) return { category: 'office', rule: 'office', why: 'a document or data' }
    if (files && docFile && has(/\b(cover letter|essay|story|poem|speech|bio|personal statement|letter|blog post|article)\b/, t) && !has(/\b(spreadsheet|sheet|deck|slides|chart|table|pdf)\b/, t)) return { category: 'writing', rule: 'writing', why: 'edits an attached piece of writing' }
    if (files && (docFile || !images)) return { category: 'office', rule: 'office:file', why: 'reads attached files' }
    if (images) return { category: 'vision', rule: 'vision', why: 'looks at an image' }
    if (has(WRITING, t) && !(question && !/\bwrite\b/.test(t))) return { category: 'writing', rule: 'writing', why: 'writing' }
    if (folders) return { category: 'agent-tools', rule: 'agent-tools:folder', why: 'works with a folder' }
    if (roleCat && !question) return { category: roleCat, rule: 'role-prior', why: `the bot's role (${CATEGORY_LABEL[roleCat]})` }
    if (roleCat === 'research' || roleCat === 'writing') return { category: roleCat, rule: `${roleCat}:role`, why: `the bot's role (${CATEGORY_LABEL[roleCat]})` }
    if (has(OFFICE_OBJ, t) && !question && has(/\b(make|create|build|need|want)\b/, t)) return { category: 'office', rule: 'office:weak', why: 'a document or data' }
    if (has(TOOLS_OBJ, t) && !question && has(TOOLS_ACT, t)) return { category: 'agent-tools', rule: 'agent-tools:weak', why: 'a connected app' }
    // An operational order nothing above claimed ("get the build green", "sync my stuff"): agent work,
    // with a low confidence (the tie-breaker's case). Conversational imperatives (tell, explain, give me) stay chat.
    if (!question && has(OPERATE, t) && words >= 3) return { category: 'agent-tools', rule: 'imperative', why: 'an operational request' }
    return { category: 'chat', rule: question ? 'chat:question' : 'chat', why: question ? 'a question' : 'conversation' }
  })()
  // The request's shape (requestShape): read from how much is asked, not from topic words.
  const shape = requestShape(raw)
  const shaped = !ctx.voice && !['small-talk', 'empty', 'follow-up', 'follow-up:new'].includes(pick.rule)
  // A conversation that also asks for something done (a table emailed, a hotel booked) is agent work with tools.
  if (shaped && shape.acts && pick.category === 'chat' && !question) Object.assign(pick, { category: 'agent-tools', rule: 'shape:steps', why: 'several steps, one done with tools' })
  const { category } = pick

  // ---- difficulty (the difficulty rubric)
  const schoolSubject = category !== 'coding' && category !== 'code-quick' && category !== 'computer-use' && category !== 'cad' && category !== 'long-context'
  const study = schoolSubject && (has(STUDY, t) || (pick.rule === 'follow-up' && !!ctx.previousStudy) || (!!ctx.role && has(STUDY_ROLE, ctx.role.toLowerCase()) && (question || words <= 12)))
  // In school work a "mole" is chemistry, not a medical worry.
  const stakes = has(STAKES, study ? t.replace(/\bmoles?\b/g, ' ') : t) && (category !== 'coding' || has(/\b(production|customers|outage|security)\b/, t))
  const longOutput = has(LONG_OUTPUT, t)
  const multi = has(MULTI, t) && words > 6
  const hard = has(HARD, t)
  const quick = has(QUICK, t)
  const difficulty0 = ((): Tier => {
    if (pick.rule === 'follow-up') return (ctx.previousTier ?? 2) as Tier
    if (pick.rule === 'small-talk' || pick.rule === 'empty') return 0
    switch (category) {
      case 'voice':
        if (has(GREETING, t) && words <= 4) return 0
        if (hard || has(STAKES, t)) return 3
        return has(SELF, t) || has(MINE_MAIL, t) || has(LIVE, t) || /\b(timer|alarm|remind)\b/.test(t) ? 2 : 1
      case 'long-context': return 3
      case 'coding':
        if (pick.rule === 'coding:agent' && /\b(parallel|several|multiple|three|four|five|\d+ (agents|issues|tasks)|across (my|the|our) (repo|codebase|app))\b/.test(t)) return 3
        if (pick.rule === 'incident' || hard || multi || words > 60 || /\b(in|across|under) (src|lib|app|packages)\/[\w/-]+(?=\s|$)|\b(all|every) (the )?\w+s\b/.test(t) || (has(BIG_CODE, t) && !quick) || /\b(and update|and store|and add|and fix)\b/.test(t)) return 3
        return 2
      case 'code-quick': return /\b(examples|theorem|in depth|in-depth|pros and cons|best way|trade-?offs|architecture|structure|vs\.?|versus|compare)\b/.test(t) ? 2 : 1
      case 'computer-use': return /\b(book|reserve|apply for|submit|check ?out|buy|purchase|order|ship (it|them) to|pay|return|refund|cancel)\b/.test(t) || multi && words > 14 ? 3 : 2
      case 'cad':
        if (question && !has(/\b(design|model|make)\b/, t)) return 1
        if (/\b(interferences?|assembly|full|stiffer|stronger|lighter|without adding weight|optimi[sz]e)\b/.test(t) || (/\bdesign\b/.test(t) && (words > 10 || /\b(for|that|with)\b/.test(t)))) return 3
        if (/^export\b/.test(t) || (/\bexport\b/.test(t) && words <= 8)) return 1
        return 2
      case 'math':
        if (has(MATH_HARD, t) && !/\bexplain the\b/.test(t)) return 3
        if (words <= 14 && !/\b(show|explain|step|why|derivative|integral|limit|eigen\w*|probability|expected|solutions?|solve|x)\b|[a-z]\^/.test(t) && /(%|percent|\d+\s*[-+*/]\s*\d+|how (much|many) .{0,20}\bfor\b)/.test(t)) return 1
        return 2
      case 'research':
        if (pick.rule === 'research:travel') return 2
        return (has(RESEARCH_HARD, t) && !(question && words <= 12)) || hard || multi || (has(MED_LIT, t) && words > 8) ? 3 : 2
      case 'writing':
        if (longOutput || /\b(perfect|personal statement|novel)\b/.test(t)) return 3
        if (question) return 1
        if (has(WRITING_SHORT, t) && !files && !/\bfor my (wife|husband|mom|mum|dad|brother|sister|partner|boss|grand\w+|best friend)\b/.test(t)) return 1
        return 2
      case 'office':
        // A patient-facing or cited document is high stakes (a wrong fact reaches someone who relies on it).
        if (hard || longOutput || multi || (stakes && files > 0) || /\b(patients?|clinical|citations?|cited)\b/.test(t)) return 3
        if (/^convert\b/.test(t) && words <= 12) return 1
        return 2
      case 'agent-tools':
        if (folders || multi || /\b(go through|everything|each one)\b/.test(t)) return 3
        return 2
      case 'vision':
        if (has(/\b(mole|rash|lump|get (it |this )?checked|infected|swollen)\b/, t)) return 3
        return /\b(why|where should|how (should|can|do) i|should i|suggest|improve|what'?s wrong|explain|is (it|this) safe|safe for|identify|what plant|wiring|chart|graph|error|diagnos\w*)\b/.test(t) ? 2 : 1
      case 'chat': {
        // A clinical question (a dose, an interaction, a lab value, warning signs) is high stakes; a definition isn't.
        if (!has(DEFINITION, t) && (has(CLINICAL_STRONG, t) || (has(CLINICAL_WEAK, t) && (has(DRUG_NAME, t) || has(STAKES, t))))) return 3
        // A trip planned with travel times or map links is several deliverables.
        if (has(/\b(itinerary|trip|plan)\b/, t) && has(/\b(travel times?|google maps|day[- ]by[- ]day|map links?)\b/, t)) return 3
        if (has(DECISION, t) && (stakes || words > 25)) return 3
        if ((stakes || /\b(legal|illegal|allowed|deduct\w*)\b/.test(t)) && /\b(should|worried|can my|can i|do i have to|am i|implications|is it worth|is it legal|allowed|diagnosed)\b/.test(t)) return 3
        if (has(LIVE, t) || has(CONNECTED, t) || has(ADVICE, t) || stakes || has(TRAVEL, t) || /\b(pmid|doi|retract\w*)\b/.test(t) || /\b(rank|score|prioriti[sz]e) (them|these|the list)\b/.test(t)) return 2
        if (ctx.group || roleCat) return 1
        return words > 60 ? 2 : 1
      }
    }
    return 2
  })()
  let difficulty = difficulty0
  let why = pick.why
  // The mode sets a floor: Heavy and Council are for the hardest work; a team, a plan or Deep Research is real work.
  if ((ctx.heavy || ctx.council) && difficulty < 3) { difficulty = 3; why = ctx.heavy ? 'Heavy mode' : 'Council' }
  else if ((ctx.team || ctx.deepResearch || ctx.planFirst) && difficulty < 2) { difficulty = 2; why = ctx.deepResearch ? 'Deep Research' : ctx.team ? 'a team task' : 'plan first' }
  if (folders && difficulty < 3 && category !== 'vision') difficulty = 3
  // Agentic coding and computer use are never light work for the model, even when the words are few.
  if ((category === 'coding' || category === 'computer-use' || category === 'long-context') && difficulty < 2) difficulty = 2
  // The request's shape: several asks, constraints, specifics or a lot to read make it harder than its words suggest.
  if (shaped && shape.tier > difficulty) { difficulty = Math.min(3, difficulty + (shape.tier - difficulty >= 2 ? 2 : 1)) as Tier; why = `${why} · ${shape.asks > 1 ? `${shape.asks} asks` : 'a lot asked'}` }
  // An obviously quick ask (quickAsk: a sum, a conversion, a translation of a sentence, a typo fix): light work
  // whatever the words in its material say ("I'll be late tomorrow" is not live news). Only in a fresh chat or
  // math request with nothing attached, no level asked for in words, never voice, a follow-up or a mode.
  const quickKind = !ctx.voice && !files && !folders && !images && !ctx.heavy && !ctx.team && !ctx.deepResearch && !ctx.planFirst && !ctx.council &&
    (category === 'chat' || category === 'math' || category === 'writing') && !['follow-up', 'follow-up:new'].includes(pick.rule) && !has(EXPLICIT_MAX, t) && !has(EXPLICIT_HIGH, t)
    ? quickAsk(raw) : undefined
  if (quickKind && difficulty > 1) difficulty = 1
  if (quickKind) why = `${why} · a quick ${quickKind.replace('-', ' ')}`

  // ---- chat or agent (the kind rubric)
  const kind = ((): { kind: TaskKind; why: string } => {
    if (ctx.helper || ctx.unattended || ctx.group) return { kind: 'agent', why: ctx.helper ? 'helper agent' : ctx.unattended ? 'runs unattended' : 'group chat' }
    if (ctx.planFirst || ctx.team || ctx.deepResearch || ctx.heavy || ctx.council) return { kind: 'agent', why: ctx.planFirst ? 'Plan first is on' : ctx.team ? 'Team of Experts is on' : ctx.deepResearch ? 'Deep Research is on' : ctx.heavy ? 'Heavy is on' : 'Council is on' }
    if (folders) return { kind: 'agent', why: 'works with an attached folder' }
    if (has(IMAGE_RE, t) && !question) return { kind: 'agent', why: 'makes a picture' }
    if (files) return { kind: 'agent', why: 'reads attached files' }
    if (ctx.openPlan && words <= 20) return { kind: 'agent', why: 'a task is in progress' }
    if (pick.rule === 'follow-up') return { kind: ctx.previousKind ?? (AGENT_WORK.has(category) ? 'agent' : 'chat'), why: 'follow-up' }
    if (pick.rule === 'follow-up:new') return { kind: 'agent', why: 'follow-up that makes or sends something' }
    // Several asks, one of them done outside the reply (a file, an email, a booking): the agent does it.
    if (shaped && shape.acts && !question && category !== 'code-quick') return { kind: 'agent', why: 'several steps, one makes or sends something' }
    switch (category) {
      case 'coding': case 'computer-use': case 'long-context': case 'agent-tools': case 'office':
        return { kind: 'agent', why: KIND_WHY[category] ?? 'agent work' }
      case 'cad': return !cad.build && question && !has(/\b(design|model|make)\b/, t) ? { kind: 'chat', why: 'a question about a design' } : { kind: 'agent', why: KIND_WHY.cad ?? 'agent work' }
      case 'research': return has(RESEARCH_DEEP, t) || difficulty >= 3 || pick.rule === 'research:travel' ? { kind: 'agent', why: 'researches several sources' } : { kind: 'chat', why: 'a question with a quick lookup' }
      case 'voice': return has(SELF, t) || has(MINE_MAIL, t) || /\b(timer|alarm|remind|play|call|text|message|navigate|directions|read me|my (latest|last) e-?mail)\b/.test(t) ? { kind: 'agent', why: 'uses apps by voice' } : { kind: 'chat', why: 'a voice conversation' }
      case 'writing': return /\b(save (it|this|them)|as a (file|document|doc|pdf)|send (it|this)|post (it|this) (to|on)|(in|to|into) (my|the) (workspace|files|documents|desktop|folder|notes))\b/.test(t) ? { kind: 'agent', why: 'saves or sends it' } : { kind: 'chat', why: 'writing in the reply' }
      default: return { kind: 'chat', why: question ? 'a question' : category === 'chat' ? 'conversation' : 'answers in the reply' }
    }
  })()

  // ---- effort (the effort rubric: auto-effort.ts)
  const explicit: Effort | undefined = has(EXPLICIT_MAX, t) ? 'max' : has(EXPLICIT_HIGH, t) ? 'high' : undefined
  const deliverable = kind.kind === 'agent' && (category === 'coding' || category === 'office' || category === 'cad' || officeDeliverable)
  const toolDepth = kind.kind === 'chat' ? (has(LIVE, t) || category === 'research' ? 1 : 0) : multi || folders || difficulty >= 3 ? 3 : 2
  const signals: TaskSignals = { stakes, deliverable, longOutput, toolDepth, ...(explicit ? { explicit } : {}), followUp: pick.rule === 'follow-up', ...(study ? { study } : {}), ...(quickKind ? { quick: quickKind } : {}) }
  let effort = pick.rule === 'follow-up' && ctx.previousEffort && !ctx.voice
    ? ctx.previousEffort
    : autoEffort({ category, difficulty, voice: !!ctx.voice, heavy: !!ctx.heavy, council: !!ctx.council, task: kind.kind === 'agent' && difficulty >= 2, stakes: stakes && category !== 'chat' ? true : stakes && difficulty >= 3, deliverable, longOutput, toolDepth: category === 'chat' ? 0 : toolDepth, explicit })
  if (ctx.heavy && !ctx.voice) effort = 'max'
  // A CAD build thinks at High, a whole assembly at Extra (cad/cad-intent.ts), never lower.
  if (category === 'cad' && cad.effort && !ctx.voice && LEVEL_ORDER.indexOf(effort) < LEVEL_ORDER.indexOf(cad.effort)) effort = cad.effort

  const confidence = RULE_CONFIDENCE[pick.rule] ?? 0.6
  return {
    category,
    difficulty,
    confident: confidence >= CONFIDENT,
    confidence,
    why: `${CATEGORY_LABEL[category]} · ${why}`,
    kind: kind.kind,
    kindWhy: kind.why,
    effort,
    signals,
    needsVision: images > 0,
    contextTokens,
    lowLatency: !!ctx.voice,
    rule: pick.rule,
    ...(category === 'writing' ? { voice: writingVoice(t) } : {}),
    ...(pick.rule === 'electrical' ? { domain: 'electrical' as const } : {})
  }
}

/** Categories that are agent work by their nature (a follow-up with no known kind runs as the agent). */
const AGENT_WORK: ReadonlySet<TaskCategory> = new Set<TaskCategory>(['coding', 'computer-use', 'long-context', 'agent-tools', 'office', 'cad'])
const KIND_WHY: Partial<Record<TaskCategory, string>> = {
  coding: 'works on code', 'computer-use': 'acts in a browser, an app or on the screen', 'long-context': 'reads a long document',
  'agent-tools': "uses the user's own files, mail, calendar or apps", office: 'makes or changes a document', cad: 'works on a CAD model'
}

/**
 * The decision's invariants (tested on the whole eval set): agent categories never run as a chat, and a
 * chat-only category (chat, a code question) runs as the agent only when something forces it (a mode, files,
 * a plan in progress, a helper / routine / group, a follow-up of agent work).
 */
export function consistent(c: Pick<TaskClass, 'category' | 'kind' | 'kindWhy'>): boolean {
  if ((c.category === 'coding' || c.category === 'computer-use' || c.category === 'long-context' || c.category === 'agent-tools' || c.category === 'office') && c.kind !== 'agent') return false
  if ((c.category === 'chat' || c.category === 'code-quick') && c.kind === 'agent') return /is on|attached|in progress|helper|unattended|group|follow-up|files/.test(c.kindWhy)
  return true
}

/** Simple chat or a quick question: the light path (no plan, no heavy tools) is enough. */
export const isChatTask = (c: Pick<TaskClass, 'category' | 'difficulty'>): boolean => c.category === 'chat' && c.difficulty <= 1

/**
 * Rough prompt tokens for attached files, from their sizes on disk (no reading): plain text ≈ 4 bytes a
 * token; PDFs and Office files carry much more than their text (fonts, images, zip), so they count less.
 */
export function estimateFileTokens(files: Array<{ path: string; size?: number }>): number {
  let n = 0
  for (const f of files) {
    const size = f.size ?? 0
    if (!size) continue
    const ext = f.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    if (/^(png|jpe?g|gif|webp|heic|bmp|tiff?|mp4|mov|mp3|wav|m4a|zip|dmg)$/.test(ext)) continue
    const per = ext === 'pdf' ? 12 : /^(docx|xlsx|pptx|key|pages|numbers)$/.test(ext) ? 6 : 4
    n += size / per
  }
  return Math.round(n)
}

/**
 * Token estimates for routing, from what's at hand (file sizes via stat, never reading them): `inputTokens` for
 * the message and its files, `contextTokens` adding the history that will be sent with it.
 */
export function requestTokens(o: { text: string; files?: Array<{ path: string; kind?: string }>; history?: Array<{ content?: string | null }> }): { inputTokens: number; contextTokens: number } {
  const sized = (o.files ?? []).filter((f) => f.kind !== 'folder' && f.kind !== 'image').map((f) => {
    try { return { path: f.path, size: statSync(f.path).size } } catch { return { path: f.path, size: 0 } }
  })
  const inputTokens = Math.round((o.text?.length ?? 0) / 4) + estimateFileTokens(sized)
  const history = Math.round((o.history ?? []).reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4)
  return { inputTokens, contextTokens: inputTokens + history }
}
