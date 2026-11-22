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
