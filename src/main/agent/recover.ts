import type { ToolCall } from '@shared/types'
import { repairJson } from './validate'
import { familyToolCalls } from '../llm/tool-adapters'

// Local models on OpenAI-compatible servers sometimes write the tool call into the
// text instead of the tool_calls field (Hermes/Qwen <tool_call> tags, fenced JSON,
// or a bare JSON object), and sometimes misspell tool names. This recovers both.

// Patterns adapted in spirit from OpenClaw's tool-call-repair (MIT) and Hermes Agent (MIT).
const TAGGED = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
// Qwen3-Coder style: <function=name><parameter=key>value</parameter>…</function>
const XMLISH = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g
const FENCED = /```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/g

interface RawCall { name?: string; arguments?: unknown; parameters?: unknown; args?: unknown; function?: { name?: string; arguments?: unknown } }

function toCall(raw: RawCall, known: Set<string>, i: number, disabled?: Set<string>): ToolCall | null {
  const name = raw.name ?? raw.function?.name
  if (!name) return null
  const fixed = fixName(name, known, disabled)
  if (!fixed) return null
  const args = raw.arguments ?? raw.parameters ?? raw.args ?? raw.function?.arguments ?? {}
  return { id: `text_${i}`, name: fixed, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
}

function tryJson(s: string): RawCall | RawCall[] | null {
  try {
    return JSON.parse(s) as RawCall
  } catch {
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')) as RawCall
    } catch {
      // Single quotes, bare keys, Python literals, a missing final brace: the same repair tool arguments get.
      const fixed = repairJson(s)
      if (fixed === null) return null
      try { return JSON.parse(fixed) as RawCall } catch { return null }
    }
  }
}

/** Pulls tool calls out of text. Returns the calls and the text with them removed. `disabled`: see fixName. */
export function recoverToolCalls(content: string, known: Set<string>, disabled?: Set<string>): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = []
  // A model that stopped at "</function" or forgot the closing tag (adapted from OpenHands _fix_stopword, MIT).
  if ((content.match(/<function=/g) ?? []).length === 1 && !/<\/function>\s*$/.test(content.trim())) {
    content = content.trimEnd().replace(/<\/(function)?$/, '') + '</function>'
  }
  let rest = content
  const take = (re: RegExp): void => {
    rest = rest.replace(re, (whole, body: string) => {
      const parsed = tryJson(body)
      const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
      const found = list.map((r) => toCall(r, known, calls.length, disabled)).filter((c): c is ToolCall => !!c)
      if (!found.length) return whole
      calls.push(...found)
      return ''
    })
  }
  take(TAGGED)
  if (!calls.length) {
    rest = rest.replace(XMLISH, (whole, name: string, body: string) => {
      const fixed = fixName(name, known, disabled)
      if (!fixed) return whole
      let args: Record<string, unknown> = {}
      for (const m of body.matchAll(/<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) {
        const v = m[2]
        try { args[m[1]] = JSON.parse(v) } catch { args[m[1]] = v }
      }
      // Llama 3.1's variant: <function=name>{json}</function>.
      if (!Object.keys(args).length && body.trim().startsWith('{')) {
        const parsed = tryJson(body.trim())
        if (parsed && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
      }
      calls.push({ id: `text_${calls.length}`, name: fixed, arguments: JSON.stringify(args) })
      return ''
    })
  }
  // Model families' own call syntaxes (Llama, Mistral, Gemma, LFM, DeepSeek, gpt-oss, ReAct…): see llm/tool-adapters.ts.
  if (!calls.length) {
    const fam = familyToolCalls(content, known)
    const found = fam.calls.map((c) => toCall(c, known, calls.length, disabled)).filter((c): c is ToolCall => !!c)
    if (found.length) { calls.push(...found.map((c, i) => ({ ...c, id: `text_${i}` }))); rest = fam.rest }
  }
  // A fenced block only counts when it is (almost) the whole reply; JSON shown to the user stays text.
  if (!calls.length && content.replace(FENCED, '').trim().length < 40) take(FENCED)
  if (!calls.length) {
    const t = content.trim()
    if (t.startsWith('{') && t.endsWith('}')) {
      const parsed = tryJson(t)
      const c = parsed && !Array.isArray(parsed) ? toCall(parsed, known, 0, disabled) : null
      if (c && ('arguments' in (parsed as object) || 'parameters' in (parsed as object))) {
        calls.push(c)
        rest = ''
      }
    }
  }
  return { calls, rest: rest.trim() }
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return d[a.length][b.length]
}

/**
 * "File-Write", "filewrite", "file_wirte" → "file_write". Null if nothing is close.
 * `disabled` holds tool names the user switched off (connector tools): a call naming one of those is
 * never redirected to a look-alike that's still on (send_email off must not become send_email_2).
 * Connector tools (server__tool) are only matched up to case and punctuation, never by edit distance:
 * a call to a connector tool that isn't offered is not turned into a different one that is.
 */
export function fixName(name: string, known: Set<string>, disabled?: Set<string>): string | null {
  if (known.has(name)) return name
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const raw = name.replace(/^functions?\./, '')
  const n = norm(raw)
  if (disabled) for (const d of disabled) if (d === name || d === raw || norm(d) === n) return null
  const same = [...known].filter((k) => norm(k) === n)
  if (same.length === 1) return same[0]
  if (same.length > 1) return null
  if (raw.includes('__')) return null
  let best: string | null = null
  let bestD = 3
  for (const k of known) {
    if (k.includes('__')) continue
    const dd = lev(norm(k), n)
    if (dd < bestD) { best = k; bestD = dd }
  }
  return bestD <= 2 ? best : null
}

/** Arguments with object keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} are the same call. */
export function canonicalArgs(raw: string): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v
  try { return JSON.stringify(sort(JSON.parse(raw))) } catch { return raw }
}

/**
 * Same call, same result, again and again: the signature of a stuck local model.
 * A repeated call whose result changes (a snapshot of a new page) is progress, not a loop.
 */
export class LoopGuard {
  private last = new Map<string, { result: string; same: number }>()
  private errors = new Map<string, number>()
  private stepKey = ''
  private stepRuns = 0

  /**
   * Polling loops (adapted from Grok Build's turn loop, Apache-2.0): the same step, the same calls with the
   * same arguments (keys sorted, call order ignored), again and again, even when the results change (a
   * status that keeps saying "running"). Reads and plans get a nudge at 4 repeats and stop at 8; anything
   * else at 8 and 12. Returns the nudge to append to this step's results, or the stop text to answer with.
   */
  step(calls: ToolCall[], isRead: (name: string) => boolean): { nudge?: string; stop?: string } {
    if (!calls.length) return {}
    const key = calls.map((c) => `${c.name}:${canonicalArgs(c.arguments)}`).sort().join('|')
    this.stepRuns = key === this.stepKey ? this.stepRuns + 1 : 1
    this.stepKey = key
    const [nudgeAt, stopAt] = calls.every((c) => isRead(c.name)) ? [4, 8] : [8, 12]
    if (this.stepRuns >= stopAt) return { stop: `Stopped: this exact step (${calls.map((c) => c.name).join(', ')}) ran ${this.stepRuns} times in a row. It was not run again. Change the approach: wait once (a wait or sleep tool if you have one, or move on to other work first) and check a single time, use different arguments, or tell the user what you're waiting for.` }
    if (this.stepRuns === nudgeAt) return { nudge: `\n\n[From the app] You appear to be stuck in a polling loop: this exact step has run ${this.stepRuns} times in a row. If you're waiting on something, run a single sleep and then check once; do not poll in a tight loop. Otherwise change the approach.` }
    return {}
  }

  private key(call: ToolCall): string {
    let args = call.arguments
    try { args = JSON.stringify(JSON.parse(call.arguments)) } catch { /* raw */ }
    return `${call.name}:${args}`
  }

  /** Returns a message to send instead of running the call, or null. */
  check(call: ToolCall): string | null {
    const seen = this.last.get(this.key(call))
    if (seen && seen.same >= 2) return `You have made this exact ${call.name} call ${seen.same + 1} times and got the same result each time, so it was not run again. Try a different approach, use different arguments, or ask the user with ask_user.`
    return null
  }

  /** Records what a call returned. */
  record(call: ToolCall, result: string): void {
    const k = this.key(call)
    const seen = this.last.get(k)
    this.last.set(k, { result, same: seen && seen.result === result ? seen.same + 1 : 1 })
  }

  /** Counts repeated errors from the same tool; returns a nudge on the third. */
  error(tool: string, message: string): string | null {
    const key = `${tool}:${message.slice(0, 80)}`
    const n = (this.errors.get(key) ?? 0) + 1
    this.errors.set(key, n)
    return n >= 3 ? `\nThis is the same error ${n} times in a row. Stop retrying this; change approach or ask the user.` : null
  }
}
