/**
 * A message typed while a bot works that is only "stop" (or "cancel", "never mind", "scratch that"…) stops the
 * run, the same as the Stop button. Anything longer ("stop using commas", "cancel the 3pm meeting") is
 * steering: it changes the work, it doesn't end it.
 */
const STOP = new RegExp(
  '^(?:(?:ok(?:ay)?|no|hey|please|just)\\s+)*' +
  '(?:stop|cancel|abort|halt|quit|end it|never ?mind|nvm|forget (?:it|that|about it)|scratch that|don\'?t do (?:it|that|this)|' +
  '(?:stop|cancel|abort|halt|end)\\s+(?:it|that|this|now|working|everything|all of it|the (?:task|job|work|run|search|research))|' +
  'stop what you\'?re doing)' +
  '(?:\\s+(?:please|now|right now|thanks|thank you|for now))*$'
)

export function isStopRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/[’]/g, '\'').replace(/[.!?,…]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > 0 && t.length <= 60 && STOP.test(t)
}

const norm = (text: string): string => text.toLowerCase().replace(/[’]/g, '\'').replace(/["“”`]+/g, ' ').replace(/[.!?,…:;]+/g, ' ').replace(/\s+/g, ' ').trim()
const LEAD = '^(?:(?:ok(?:ay)?|no|hey|please|just|now)\\s+)*'
const TAIL = '(?:\\s+(?:please|now|right now|immediately|asap|thanks|thank you|for now))*$'

/** "Stop everything", "cancel all tasks", "stop all of them": every chat working right now stops (report: "Stop everything" → "Stopped"). */
const ALL = new RegExp(`${LEAD}(?:stop|cancel|abort|halt|end|kill)\\s+(?:everything|it all|all|all (?:the )?(?:tasks|jobs|bots|chats|work|runs)|all of (?:them|the tasks|the jobs)|every (?:task|job|bot|chat|run))${TAIL}`)

export function isStopAll(text: string): boolean {
  const t = norm(text)
  return t.length > 0 && t.length <= 60 && ALL.test(t)
}

const NAMED = new RegExp(`${LEAD}(?:stop|cancel|abort|halt|end)\\s+(?:working on\\s+|doing\\s+)?(.+?)${TAIL}`)
/** What follows the stop word in steering, never a stop: "stop using commas", "stop at the first result". */
const STEER_WORD = /^(?:using|at|when|until|after|before|adding|making|being|saying|writing|putting|including|asking|with|on|in|for|if|so|and|to|by|there|here|from|calling|sending|searching|trying|repeating)\b/
/** Things a person cancels that are not SahilBot's work in progress: those go to the model as a request. */
const NOT_A_RUN = /\b(?:server|port|process|meeting|appointment|subscription|order|reservation|booking|flight|alarm|timer|reminders?|routines?|events?|call|calls|membership|payment|transfer)\b/
/** A stop of the task at hand, whatever it is called: "Stop Test 5 now", "cancel the trip plan", "stop that". */
const GENERIC = /^(?:(?:test|task|job|run|step|number|no)\s*#?\s*\d+|it|that|this|that one|this one|thing|whole thing|task|job|work|run|search|research|plan|trip plan|script|invoice|report|download|build|essay|draft|renamer|photo renamer)$/

/**
 * The thing a stop names, without "the"/"my": "Stop Test 5 now" → "test 5", "cancel the trip plan" → "trip plan".
 * undefined: not a stop of a task ("stop using commas", "cancel the 3pm meeting", "stop the server on port 3000").
 */
export function stopTarget(text: string): string | undefined {
  const t = norm(text)
  if (!t || t.length > 80) return undefined
  const m = t.match(NAMED)
  if (!m) return undefined
  const obj = m[1].trim()
  if (!obj || obj.split(' ').length > 6 || STEER_WORD.test(obj) || NOT_A_RUN.test(obj)) return undefined
  return obj.replace(/^(?:the|my|that|this|your)\s+(?=\S)/, '')
}

/** A named stop that means the task at hand, whatever its title ("stop test 5", "cancel the task", "stop that"). */
export function isGenericStop(target: string): boolean {
  return GENERIC.test(target)
}

const key = (s: string): string => norm(s).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()

/** The stop names one of these (a chat's title, the task's first words): "stop the invoice" ↔ "Invoice for Acme". */
export function namesMatch(target: string, names: Array<string | undefined>): boolean {
  const o = key(target)
  if (o.length < 3) return false
  const re = new RegExp(`(?:^| )${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`)
  return names.some((n) => { const k = key(n ?? ''); return !!k && (k === o || re.test(k)) })
}

/** A typed stop of the chat's own task: a bare "stop", or a stop that names it ("Stop Test 5 now" in a chat about Test 5). */
export function isNamedStop(text: string, names: Array<string | undefined>): boolean {
  if (isStopRequest(text)) return true
  const target = stopTarget(text)
  return !!target && (isGenericStop(target) || namesMatch(target, names))
}
