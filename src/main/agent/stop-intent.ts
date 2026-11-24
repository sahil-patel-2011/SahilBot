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

/**
 * "Stop Test 5 now", "cancel the task now", "please stop this run immediately": a stop that names what to stop, then
 * says now. Not steering about something in the world ("stop the music now", "cancel my 3pm meeting now") or about
 * how to work ("stop using commas now").
 */
const STOP_NAMED = /^(?:(?:ok(?:ay)?|no|hey|please|just)\s+)*(?:stop|cancel|abort|halt|end)\s+(?!(?:using|doing|adding|writing|making|asking|at|after|before|when|if|on|with)\b)(?!.*\b(?:meeting|server|process|timer|music|song|video|alarm|recording|subscription|event|call|order|payment|reminder|routine|download|upload|playback|port)s?\b)[\w #'-]{1,30}?\s+(?:now|right now|immediately|at once|please)(?:\s+(?:please|now|thanks|thank you))*$/

export function isStopRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/[’]/g, '\'').replace(/[.!?,…]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!(t.length > 0 && t.length <= 60)) return false
  return STOP.test(t) || (t.split(' ').length <= 6 && STOP_NAMED.test(t))
}
