/**
 * A quick side question sent while a bot works on something long ("what's 9 squared?", "how's it going?"):
 * answered right away in the chat while the long job keeps running, instead of waiting for it to finish.
 * Anything that changes the job ("make it 4 printers", "also add prices", "stop") is steering, not an aside.
 */
const CHANGES = /\b(instead|change|switch|also|add|remove|drop|include|exclude|only|make (it|them|that|this)|use|don'?t|do not|stop|cancel|wait|actually|rather|redo|again|focus|skip|replace|what about|how about|and also)\b/i
const QUESTION = /\?\s*$|^(what|what's|whats|who|who's|when|where|why|how|how's|is|are|was|were|can|could|does|do|did|which|define|convert|calculate)\b/i
const MATH = /^[\d\s+\-*/×÷^().,%=x]+\??$/i

export function isAside(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 220 || t.includes('\n') || CHANGES.test(t)) return false
  if (MATH.test(t) && /\d/.test(t) && /[+\-*/×÷^%x]/i.test(t)) return true
  return QUESTION.test(t)
}

/** The instructions for the side answer: short, honest about the job still running, no new work. */
export function asideSystem(o: { who?: string; job: string; step?: string }): string {
  return [
    'You are in the middle of a longer task for the user, and they just sent a quick side question. Answer it right away, in one or two short sentences.',
    `The task you are working on: "${o.job.replace(/\s+/g, ' ').slice(0, 400)}"${o.step ? `. Right now: ${o.step}.` : '.'}`,
    'If the question is about that task (progress, when it will be done), say it is still in progress and what you are doing now; never claim results you do not have yet. Do not start new work or promise anything beyond the task.',
    o.who ? `The user's name is ${o.who}.` : ''
  ].filter(Boolean).join('\n')
}
