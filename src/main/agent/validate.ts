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

/** Small models sometimes wrap JSON in fences or leave a trailing comma; fix only that much. */
export function parseArgs(raw: string): unknown {
  let s = raw.trim()
  if (!s) return {}
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(s)
  } catch {
    // Trailing commas, and raw newlines/tabs inside strings (adapted from OpenHands sanitize_json_control_chars, MIT).
    return JSON.parse(escapeControlInStrings(s.replace(/,\s*([}\]])/g, '$1')))
  }
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
  // A call cut off mid-arguments (output limit hit) must not be "repaired" into something else.
  if (trimmed && !/[}\]]\s*(```)?\s*$/.test(trimmed)) {
    return { ok: false, error: 'The arguments were cut off before the end (output limit). Send a shorter call, for example split long content into several file_write calls with mode "append".' }
  }
  let args: unknown
  try {
    args = parseArgs(raw)
  } catch (e) {
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
