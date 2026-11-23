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

/**
 * Plain arithmetic in a side question, worked out right here (no model, so it's instant): "18% of $1,740",
 * "what's 1740 * 0.18?", "250 + 75 - 10", "(3+4)*2", "9 squared". undefined: not plain arithmetic.
 */
export function quickMath(text: string): string | undefined {
  let t = text.trim().toLowerCase().replace(/\?+$/, '').replace(/^(what'?s|what is|whats|calculate|compute|how much is)\s+/, '').trim()
  const money = t.includes('$')
  t = t.replace(/[$,]/g, '').replace(/×/g, '*').replace(/x(?=\s*[\d(])/g, '*').replace(/÷/g, '/').replace(/\bsquared\b/g, '^2').replace(/\bcubed\b/g, '^3')
  // "18% of 1740" → (18/100)*1740; a bare "18%" is 0.18.
  t = t.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/g, '($1/100)*').replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)')
  if (!/^[\d\s+\-*/^().]+$/.test(t) || !/\d/.test(t) || !/[+\-*/^]/.test(t)) return undefined
  const value = evalArith(t)
  if (value === undefined || !Number.isFinite(value)) return undefined
  const round = Math.round(value * 1e6) / 1e6
  const shown = money
    ? `$${round.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : round.toLocaleString('en-US', { maximumFractionDigits: 6 })
  return `${shown}.`
}

/** A tiny, safe arithmetic evaluator (+ - * / ^ and parentheses): no eval, no names. */
function evalArith(src: string): number | undefined {
  const toks = src.match(/\d+(?:\.\d+)?|[+\-*/^()]/g) ?? []
  let i = 0
  const peek = (): string | undefined => toks[i]
  const atom = (): number => {
    const tk = toks[i++]
    if (tk === '(') { const v = expr(); if (toks[i++] !== ')') throw new Error('paren'); return v }
    if (tk !== undefined && /^\d/.test(tk)) return Number(tk)
    throw new Error('token')
  }
  const unary = (): number => { if (peek() === '-') { i++; return -unary() } if (peek() === '+') { i++; return unary() } return atom() }
  const power = (): number => { const b = unary(); if (peek() === '^') { i++; return b ** power() } return b }
  const term = (): number => { let v = power(); while (peek() === '*' || peek() === '/') { const op = toks[i++]; const r = power(); v = op === '*' ? v * r : v / r } return v }
  function expr(): number { let v = term(); while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = term(); v = op === '+' ? v + r : v - r } return v }
  try { const v = expr(); return i === toks.length ? v : undefined } catch { return undefined }
}
