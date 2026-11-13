import Ajv, { type ValidateFunction } from 'ajv'
import type { ToolDef } from './types'

// coerceTypes 'array': "42" -> 42, "true" -> true, scalar -> [scalar] (adapted from Hermes Agent arg_coercion, MIT).
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: 'array', useDefaults: true })

/** Strings that hold JSON where the schema wants an object or array get parsed first. */
function coerceJsonStrings(args: Record<string, unknown>, schema: Record<string, unknown>): void {
  const props = (schema.properties ?? {}) as Record<string, { type?: string | string[] }>
  for (const [k, def] of Object.entries(props)) {
    const want = Array.isArray(def.type) ? def.type : [def.type]
    const v = args[k]
    if (typeof v === 'string' && (want.includes('object') || want.includes('array')) && /^\s*[[{]/.test(v)) {
      try { args[k] = JSON.parse(v) } catch { /* leave it for the validator to report */ }
    }
  }
}
const cache = new WeakMap<object, ValidateFunction>()

export type Checked =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Small models sometimes wrap JSON in fences, leave trailing commas, use single quotes or bare keys,
 * or drop the last closing brace. Strict JSON first, then light fixes, then a tolerant repair.
 */
export function parseArgs(raw: string): unknown {
  let s = raw.trim()
  if (!s) return {}
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(s)
  } catch (first) {
    try {
      // Trailing commas, and raw newlines/tabs inside strings (adapted from OpenHands sanitize_json_control_chars, MIT).
      return JSON.parse(escapeControlInStrings(s.replace(/,\s*([}\]])/g, '$1')))
    } catch {
      const fixed = repairJson(raw)
      if (fixed === null) throw first
      try { return JSON.parse(fixed) } catch { throw first }
    }
  }
}

const WORD = /[A-Za-z_$][\w$-]*/y
const KEYWORDS: Record<string, string> = { true: 'true', True: 'true', TRUE: 'true', false: 'false', False: 'false', FALSE: 'false', null: 'null', None: 'null', undefined: 'null', NaN: 'null', nil: 'null' }

/**
 * Rewrites near-JSON into JSON: text or fences around the object, // and /* *\/ comments, single-quoted
 * strings, unquoted keys, Python literals (True/None), bare-word values, invalid escapes ("C:\dir",
 * "\d+"), raw control characters, trailing commas and missing closing brackets. A string that never
 * ends, or text cut mid-word, is a cut-off reply: that returns null rather than a guess.
 */
export function repairJson(input: string): string | null {
  const text = input.trim()
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const src = text.slice(start)
  let out = ''
  const stack: string[] = []
  // What the last token was, to decide whether a truncated reply can be closed safely.
  let last: 'open' | 'value' | 'word' | 'punct' = 'open'
  let i = 0
  let ended = false
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      let str = ''
      let closed = false
      while (j < src.length) {
        const d = src[j]
        if (d === '\\') {
          const n = src[j + 1]
          if (n === undefined) { j++; break }
          if (n === "'") str += "'"
          else if ('"\\/bfnrt'.includes(n)) str += '\\' + n
          else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) str += '\\u'
          else str += '\\\\' + n
          j += 2
          continue
        }
        if (d === c) { closed = true; j++; break }
        if (d === '"') str += '\\"'
        else if (d === '\n') str += '\\n'
        else if (d === '\r') str += '\\r'
        else if (d === '\t') str += '\\t'
        else str += d
        j++
      }
      if (!closed) return null
      out += `"${str}"`
      last = 'value'
      i = j
      continue
    }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue }
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); out += c; last = 'open'; i++; continue }
    if (c === '}' || c === ']') {
      out = out.replace(/,\s*$/, '')
      const want = stack.pop()
      if (!want) { ended = true; break }
      out += want
      last = 'value'
      i++
      if (!stack.length) { ended = true; break }
      continue
    }
    WORD.lastIndex = i
    const word = WORD.exec(src)
    if (word) {
      const w = word[0]
      i += w.length
      let k = i
      while (k < src.length && /\s/.test(src[k])) k++
      if (src[k] === ':') { out += JSON.stringify(w); last = 'value' }
      else if (Object.hasOwn(KEYWORDS, w)) { out += KEYWORDS[w]; last = 'value' }
      else { out += JSON.stringify(w); last = 'word' }
      continue
    }
    if (c === '`') { i++; continue }
    out += c
    if (c === ',' || c === ':') last = 'punct'
    else if (/[\d.eE+-]/.test(c)) last = 'value'
    i++
  }
  if (!ended) {
    if (!stack.length) return null
    // Cut off before the closing brackets: close them only at a clean value boundary.
    out = out.replace(/,\s*$/, '')
    if (last === 'word' || /:\s*$/.test(out)) return null
    while (stack.length) out += stack.pop()
  }
  return out
}

function escapeControlInStrings(s: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' && s[i - 1] !== '\\') inStr = !inStr
    if (inStr && c === '\n') out += '\\n'
    else if (inStr && c === '\t') out += '\\t'
    else if (inStr && c === '\r') out += '\\r'
    else out += c
  }
  return out
}

export function check(tool: ToolDef, raw: string): Checked {
  const trimmed = raw.trim()
  // A call cut off mid-arguments (output limit hit) must not be "repaired" into something else: only a
  // missing final brace after a complete value is closed; a string or word cut in half is refused.
  const cut = !!trimmed && !/[}\]]\s*(```)?\s*$/.test(trimmed)
  let args: unknown
  try {
    args = parseArgs(raw)
  } catch (e) {
    if (cut) return { ok: false, error: 'The arguments were cut off before the end (output limit). Send a shorter call, for example split long content into several file_write calls with mode "append".' }
    return { ok: false, error: `Arguments are not valid JSON (${(e as Error).message}). Send a single JSON object.` }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'Arguments must be a JSON object.' }
  coerceJsonStrings(args as Record<string, unknown>, tool.parameters)
  let v = cache.get(tool.parameters)
  if (!v) {
    v = ajv.compile(tool.parameters)
    cache.set(tool.parameters, v)
  }
  if (v(args)) return { ok: true, args: args as Record<string, unknown> }
  const errs = (v.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params && 'allowedValues' in e.params ? ` (${(e.params.allowedValues as string[]).join(', ')})` : ''}`)
  return { ok: false, error: errs.join('; ') }
}

/** The message sent back to the model on a schema failure. */
export function repairPrompt(tool: ToolDef, error: string, retryAllowed: boolean): string {
  return retryAllowed
    ? `Invalid arguments for ${tool.name}: ${error}\nExpected JSON schema:\n${JSON.stringify(tool.parameters)}\nCall ${tool.name} again with corrected arguments.`
    : `Invalid arguments for ${tool.name} again: ${error}\nThe call was not run. Do not retry it; continue without this tool or explain the problem to the user.`
}
