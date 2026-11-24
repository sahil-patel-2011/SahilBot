/**
 * A quick side question sent while a bot works on something long ("what's 9 squared?", "how's it going?"):
 * answered right away in the chat while the long job keeps running, instead of waiting for it to finish.
 * Anything that changes the job ("make it 4 printers", "also add prices", "stop") is steering, not an aside.
 */
const CHANGES = /\b(instead|change|switch|also|add|remove|drop|include|exclude|only|make (it|them|that|this)|use|don'?t|do not|stop|cancel|wait|actually|rather|redo|again|focus|skip|replace|what about|how about|and also|save|put|send|email|name (?:it|them|this|that|the)|rename|move|export|attach|share|post|write|translate|convert it)\b/i
/** A request to the bot, even phrased as a question ("Can you save it as a PDF?", "Could you put it on my Desktop?"): steering, so the task hears it. */
const REQUEST = /^(?:(?:hey|ok|so|and|also)[, ]+)?(?:can|could|would|will) you\b(?! (?:tell me|remind me) (?:what|how|when|who))|^(?:please|pls)\b|^is it possible\b|^(?:why not|should (?:it|you|we|i))\b/i
const QUESTION = /\?\s*$|^(what|what's|whats|who|who's|when|where|why|how|how's|is|are|was|were|can|could|does|do|did|which|define|convert|calculate)\b/i
const MATH = /^[\d\s+\-*/×÷^().,%=x]+\??$/i

/** "10/12", "2026-11-24", "1-2": a date, range or pick typed as a reply, not a sum to work out. */
const BARE = /^\d+(?:[-/]\d+)+$/

export function isAside(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 220 || t.includes('\n') || BARE.test(t)) return false
  // Plain arithmetic, with or without a "?" ("18% of $1,740"): answered at once beside the job.
  if (quickMath(t) !== undefined) return true
  if (CHANGES.test(t) || REQUEST.test(t)) return false
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
  // "Quick one: 245 × 18?", "btw, what's 15 percent of 200", "how much is a 20% tip on $85?"
  const asked = text.trim().replace(/\?+$/, '').replace(LEAD_IN, '').replace(/^(what'?s|what is|whats|calculate|compute|how much is|how much's)\s+/i, '').replace(/^an?\s+(?=\d)/i, '').trim()
  if (BARE.test(text.trim())) return undefined
  let t = asked.toLowerCase().replace(/\s*\b(per ?cent|pct)\b/g, '%')
  const money = t.includes('$')
  // Thousands commas only ("1,740"); "1,5" is a decimal comma, left in so the sum is not guessed.
  t = t.replace(/\$/g, '').replace(/(?<=\d),(?=\d{3}(?!\d))/g, '').replace(/×/g, '*').replace(/x(?=\s*[\d(])/g, '*').replace(/÷/g, '/').replace(/\bsquared\b/g, '^2').replace(/\bcubed\b/g, '^3')
  const fmt = (v: number): string => (money ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : (Math.round(v * 1e6) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 }))
  // A tip, tax or discount on an amount: the part and what it comes to ("20% tip on $85 = $17.00 ($102.00 total).").
  const pct = t.match(/^(\d+(?:\.\d+)?)\s*%\s*(tip|tax|off|discount)\s*(?:on|of|from|for)?\s*(\d+(?:\.\d+)?)$/)
  if (pct) {
    const rate = Number(pct[1]) / 100, base = Number(pct[3]), part = rate * base
    const off = pct[2] === 'off' || pct[2] === 'discount'
    return `${asked.replace(/\s+/g, ' ')} = ${fmt(off ? base - part : part)} (${off ? `you save ${fmt(part)}` : `${fmt(base + part)} total`}).`
  }
  // "18% of 1740" → (18/100)*1740; a bare "18%" is 0.18.
  t = t.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/g, '($1/100)*').replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)')
  if (!/^[\d\s+\-*/^().]+$/.test(t) || !/\d/.test(t) || !/[+\-*/^]/.test(t)) return undefined
  const value = evalArith(t)
  if (value === undefined || !Number.isFinite(value)) return undefined
  const round = Math.round(value * 1e6) / 1e6
  const shown = money
    ? `$${round.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : round.toLocaleString('en-US', { maximumFractionDigits: 6 })
  // The sum and its answer ("17 × 23 = 391."), so it reads like a reply, not a bare number.
  return `${asked.replace(/\s+/g, ' ')} = ${shown}.`
}

/** Words before the sum that don't change it ("Quick one:", "hey,", "ok so", "btw"). */
const LEAD_IN = /^(?:(?:quick (?:one|question|q)|hey|hi|ok(?:ay)?|so|btw|also|and|one more)[:,!\-–]?\s+)+/i

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
