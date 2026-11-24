import { isNamedStop, isStopAll } from '../../../main/agent/stop-intent'

/**
 * A message typed while a bot works that says to wait ("when you're done, also make a PDF", "after that, email it
 * to me"): it queues like ⌘Enter and is sent when the task finishes, instead of steering the task now.
 */
const WAIT = /^(?:(?:ok(?:ay)?|and|also|oh|hey)[, ]+)?(?:(?:when|once|after) (?:you'?re|you are|that'?s|this is|it'?s|you) (?:done|finished|finish|through)|after (?:that|this)|afterwards|then later|later on|next time)\b/i

export function queueWords(text: string): boolean {
  const t = text.trim().replace(/[’]/g, '\'')
  return t.length > 0 && t.length <= 2000 && WAIT.test(t)
}

/**
 * A typed stop of the running task ("stop", "Stop Test 5 now", "stop everything"): it stops, even under an open
 * question or plan card, instead of becoming that card's answer. Steering like "stop using commas" is not one.
 */
export function stopWords(text: string, title?: string): boolean {
  return isStopAll(text) || isNamedStop(text, [title])
}
