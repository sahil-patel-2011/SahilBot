// Tool calls that local models write as TEXT in their own native syntax, when the server's chat
// template didn't turn them into structured tool_calls. One adapter per model family, each keyed on the
// family's own markers so ordinary prose and JSON shown to the user are never mistaken for a call:
//   Qwen / Hermes   <tool_call>{"name": …, "arguments": …}</tool_call>   (also unclosed at the end)
//   Llama 3.1/3.3   <|python_tag|>{"name": …, "parameters": …}<|eom_id|>,  <function=name>{…}</function>
//   Llama 3.2/4     [web_search(query="x"), fetch_page(url="…")]          (pythonic, whole reply)
//   Mistral         [TOOL_CALLS][{"name": …, "arguments": …}]   or   [TOOL_CALLS]name[ARGS]{…}
//   Gemma 3         ```tool_code\nweb_search(query="x")\n```
//   Gemma 4         <|tool_call>call:web_search{query:<|"|>x<|"|>}<tool_call|>
//   LFM (Liquid)    <|tool_call_start|>[web_search(query="x")]<|tool_call_end|>
//   DeepSeek        <｜tool▁call▁begin｜>function<｜tool▁sep｜>name\n```json\n{…}\n```<｜tool▁call▁end｜>
//   gpt-oss         …to=functions.name <|constrain|>json<|message|>{…}<|call|>   (leaked Harmony)
//   ReAct / misc    Action: name\nAction Input: {…},  {"tool": …, "tool_input": …},  {"action": …, "action_input": …}
// The agent's recover step (agent/recover.ts) runs these after its own Hermes/fenced-JSON patterns and
// fixes misspelled tool names.

export interface TextCall { name: string; arguments: Record<string, unknown> }
export interface Adapted { calls: TextCall[]; rest: string; family?: string }

// ------------------------------------------------------------------------------- python literals

/** A tiny parser for Python call syntax: name(key="v", n=1, ok=True, items=[1, 2], opts={"a": None}). */
class Py {
  i = 0
  constructor(private s: string) {}
  private ws(): void { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++ }
  private peek(): string { this.ws(); return this.s[this.i] ?? '' }
  private eat(c: string): boolean { if (this.peek() === c) { this.i++; return true } return false }
  private expect(c: string): void { if (!this.eat(c)) throw new Error(`expected ${c} at ${this.i}`) }
  ident(): string {
    this.ws()
    const m = /^[A-Za-z_][\w.-]*/.exec(this.s.slice(this.i))
    if (!m) throw new Error(`expected a name at ${this.i}`)
    this.i += m[0].length
    return m[0]
  }
  value(): unknown {
    const c = this.peek()
    if (c === '"' || c === "'") return this.str()
    if (c === '[' || c === '(') return this.list(c === '[' ? ']' : ')')
    if (c === '{') return this.dict()
    const m = /^(-?\d+(\.\d+)?([eE][-+]?\d+)?|True|False|None|true|false|null)\b/.exec(this.s.slice(this.i))
    if (!m) throw new Error(`unexpected value at ${this.i}`)
    this.i += m[0].length
    const w = m[0]
    return w === 'True' || w === 'true' ? true : w === 'False' || w === 'false' ? false : w === 'None' || w === 'null' ? null : Number(w)
  }
  private str(): string {
    this.ws()
    const q = this.s[this.i]
    const triple = this.s.slice(this.i, this.i + 3) === q.repeat(3)
    const end = triple ? q.repeat(3) : q
    this.i += end.length
    let out = ''
    while (this.i < this.s.length) {
      if (this.s.startsWith(end, this.i)) { this.i += end.length; return out }
      const ch = this.s[this.i++]
      if (ch === '\\') {
        const n = this.s[this.i++]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'u' ? String.fromCharCode(parseInt(this.s.slice(this.i, (this.i += 4)), 16)) : n
      } else out += ch
    }
    throw new Error('unterminated string')
  }
  private list(close: string): unknown[] {
    this.i++
    const out: unknown[] = []
    while (!this.eat(close)) {
      out.push(this.value())
      if (!this.eat(',')) { this.expect(close); break }
    }
    return out
  }
  private dict(): Record<string, unknown> {
    this.expect('{')
    const out: Record<string, unknown> = {}
    while (!this.eat('}')) {
      const c = this.peek()
      const key = c === '"' || c === "'" ? this.str() : this.ident()
      if (!this.eat(':')) this.expect('=')
      out[key] = this.value()
      if (!this.eat(',')) { this.expect('}'); break }
    }
    return out
  }
  /** name(k=v, …): keyword arguments only (positional arguments can't be mapped to a schema). */
  call(): TextCall {
    const name = this.ident()
    this.expect('(')
    const args: Record<string, unknown> = {}
    while (!this.eat(')')) {
      const key = this.ident()
      this.expect('=')
      args[key] = this.value()
      if (!this.eat(',')) { this.expect(')'); break }
    }
    return { name, arguments: args }
  }
  /** One call, or a [list, of, calls]. Must consume the whole text. */
  calls(): TextCall[] {
    const out: TextCall[] = []
    const bracket = this.eat('[')
    do { out.push(this.call()) } while (this.eat(',') || (this.peek() !== '' && this.peek() !== ']' && /[A-Za-z_]/.test(this.peek())))
    if (bracket) this.expect(']')
    this.ws()
    if (this.i < this.s.length) throw new Error('trailing text')
    return out
  }
}

/** Python-style calls, or null when the text isn't exactly that. */
export function parsePythonCalls(text: string): TextCall[] | null {
  try { return new Py(text.trim()).calls() } catch { return null }
}

/** A Python/JS-ish dict body ({query: "x"}, {'a': True}). */
function parseDict(text: string): Record<string, unknown> | null {
  try {
    const v = new Py(text.trim()).value()
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch { return null }
}

function json(text: string): unknown {
  const t = text.trim()
  try { return JSON.parse(t) } catch { /* fall through */ }
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')) } catch { /* fall through */ }
  return parseDict(t)
}

/** {"name", "arguments" | "parameters" | "args" | "tool_input" | "action_input"} → a call. */
function fromObject(o: unknown): TextCall | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const fn = r.function as { name?: string; arguments?: unknown } | undefined
  const name = (r.name ?? r.tool ?? r.tool_name ?? fn?.name ?? (r.action_input !== undefined ? r.action : undefined)) as string | undefined
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) return null
  let args = r.arguments ?? r.parameters ?? r.args ?? r.tool_input ?? r.action_input ?? r.input ?? fn?.arguments ?? {}
  if (typeof args === 'string') args = json(args) ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  return { name, arguments: args as Record<string, unknown> }
}

function objects(v: unknown): TextCall[] {
  const list = Array.isArray(v) ? v : [v]
  return list.map(fromObject).filter((c): c is TextCall => !!c)
}

// ------------------------------------------------------------------------------- adapters

type Adapter = { family: string; run(text: string, known: Set<string>): Adapted | null }

const isKnown = (known: Set<string>, name: string): boolean => known.has(name) || [...known].some((k) => k.toLowerCase() === name.toLowerCase())

const ADAPTERS: Adapter[] = [
  {
    // Hermes/Qwen with the closing tag missing (stopped at the end of the reply).
    family: 'hermes',
    run(text) {
      const m = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>)?\s*$/.exec(text)
      if (!m || /<\/tool_call>/.test(text)) return null
      const calls = objects(json(m[1]))
      return calls.length ? { calls, rest: text.slice(0, m.index) } : null
    }
  },
  {
    family: 'llama-json',
    run(text) {
      const m = /<\|python_tag\|>\s*([\s\S]*?)\s*(?:<\|eom_id\|>|<\|eot_id\|>|$)/.exec(text)
      if (!m) return null
      // Several calls may be separated by ";".
      const calls = m[1].split(/;\s*(?=\{)/).flatMap((part) => objects(json(part)))
      if (!calls.length) {
        const py = parsePythonCalls(m[1])
        if (py) return { calls: py, rest: text.slice(0, m.index) }
        return null
      }
      return { calls, rest: text.slice(0, m.index) }
    }
  },
  {
    // <function=name>{json}</function> (Llama 3.1's alternative; the <parameter=…> form is handled in recover).
    family: 'llama-function-tag',
    run(text) {
      const calls: TextCall[] = []
      const rest = text.replace(/<function=([\w.-]+)>\s*(\{[\s\S]*?\})\s*<\/function>/g, (whole, name: string, body: string) => {
        const args = json(body)
        if (!args || typeof args !== 'object' || Array.isArray(args)) return whole
        calls.push({ name, arguments: args as Record<string, unknown> })
        return ''
      })
      return calls.length ? { calls, rest } : null
    }
  },
  {
    family: 'mistral',
    run(text) {
      const i = text.indexOf('[TOOL_CALLS]')
      if (i < 0) return null
      const body = text.slice(i + '[TOOL_CALLS]'.length).trim()
      // Newer templates: [TOOL_CALLS]name[ARGS]{…}[TOOL_CALLS]name2[ARGS]{…}
      if (/^[\w.-]+\s*\[ARGS\]/.test(body)) {
        const calls: TextCall[] = []
        for (const m of `[TOOL_CALLS]${body}`.matchAll(/\[TOOL_CALLS\]\s*([\w.-]+)\s*\[ARGS\]\s*([\s\S]*?)(?=\[TOOL_CALLS\]|<\/s>|$)/g)) {
          const args = json(m[2])
          if (args && typeof args === 'object' && !Array.isArray(args)) calls.push({ name: m[1], arguments: args as Record<string, unknown> })
        }
        return calls.length ? { calls, rest: text.slice(0, i) } : null
      }
      const calls = objects(json(body.replace(/<\/s>\s*$/, '')))
      return calls.length ? { calls, rest: text.slice(0, i) } : null
    }
  },
  {
    family: 'gemma-tool-code',
    run(text) {
      const calls: TextCall[] = []
      const rest = text.replace(/```tool_(?:code|call)\s*\n?([\s\S]*?)```/g, (whole, body: string) => {
        const found = parsePythonCalls(body.replace(/^print\(([\s\S]*)\)\s*$/, '$1')) ?? objects(json(body))
        if (!found.length) return whole
        calls.push(...found)
        return ''
      })
      return calls.length ? { calls, rest } : null
    }
  },
  {
    family: 'gemma4',
    run(text) {
      const calls: TextCall[] = []
      const rest = text.replace(/<\|tool_call>\s*call:([\w.-]+)\s*(\{[\s\S]*?\})\s*<tool_call\|>/g, (whole, name: string, body: string) => {
        const args = parseDict(body.replace(/<\|"\|>/g, '"'))
        if (!args) return whole
        calls.push({ name, arguments: args })
        return ''
      })
      return calls.length ? { calls, rest } : null
    }
  },
  {
    family: 'lfm',
    run(text) {
      const calls: TextCall[] = []
      const rest = text.replace(/<\|tool_call_start\|>\s*([\s\S]*?)\s*(?:<\|tool_call_end\|>|$)/g, (whole, body: string) => {
        const found = parsePythonCalls(body) ?? objects(json(body))
        if (!found.length) return whole
        calls.push(...found)
        return ''
      })
      return calls.length ? { calls, rest } : null
    }
  },
  {
    family: 'deepseek',
    run(text) {
      const calls: TextCall[] = []
      const re = /<｜tool▁call▁begin｜>\s*(?:function)?\s*<｜tool▁sep｜>\s*([\w.-]+)\s*(?:```(?:json)?\s*)?([\s\S]*?)(?:```\s*)?<｜tool▁call▁end｜>/g
      for (const m of text.matchAll(re)) {
        const args = json(m[2])
        if (args && typeof args === 'object' && !Array.isArray(args)) calls.push({ name: m[1], arguments: args as Record<string, unknown> })
      }
      if (!calls.length) return null
      const start = text.search(/<｜tool▁calls?▁begin｜>/)
      return { calls, rest: start >= 0 ? text.slice(0, start) : '' }
    }
  },
  {
    family: 'harmony',
    run(text) {
      const calls: TextCall[] = []
      for (const m of text.matchAll(/to=functions\.([\w.-]+)[\s\S]*?<\|message\|>\s*([\s\S]*?)\s*(?:<\|call\|>|<\|end\|>|$)/g)) {
        const args = json(m[2])
        if (args && typeof args === 'object' && !Array.isArray(args)) calls.push({ name: m[1], arguments: args as Record<string, unknown> })
      }
      if (!calls.length) return null
      const start = text.search(/<\|start\|>|<\|channel\|>|to=functions\./)
      return { calls, rest: start > 0 ? text.slice(0, start) : '' }
    }
  },
  {
    // ReAct text: "Action: web_search\nAction Input: {…}" (only for a known tool).
    family: 'react',
    run(text, known) {
      const m = /^\s*Action:\s*([\w.-]+)\s*\n\s*Action Input:\s*([\s\S]+?)\s*(?:\n\s*Observation:[\s\S]*)?$/m.exec(text)
      if (!m || !isKnown(known, m[1])) return null
      const args = json(m[2])
      if (!args || typeof args !== 'object' || Array.isArray(args)) return null
      return { calls: [{ name: m[1], arguments: args as Record<string, unknown> }], rest: text.slice(0, m.index).replace(/Thought:\s*/g, '').trim() }
    }
  },
  {
    // The whole reply is a pythonic call list (Llama 3.2/4, small models): only for known tools.
    family: 'pythonic',
    run(text, known) {
      const t = text.trim()
      if (!/^\[?[A-Za-z_][\w.-]*\(/.test(t)) return null
      const calls = parsePythonCalls(t)
      return calls?.length && calls.every((c) => isKnown(known, c.name)) ? { calls, rest: '' } : null
    }
  },
  {
    // A whole-reply JSON object with tool/tool_input or action/action_input keys (LangChain-style).
    family: 'json-keys',
    run(text, known) {
      const t = text.trim()
      if (!t.startsWith('{') || !t.endsWith('}')) return null
      const o = json(t) as Record<string, unknown> | null
      if (!o || (o.tool_input === undefined && o.action_input === undefined && o.tool === undefined)) return null
      const calls = objects(o).filter((c) => isKnown(known, c.name))
      return calls.length ? { calls, rest: '' } : null
    }
  }
]

/** Control tokens some templates leave in the visible text. */
const LEFTOVER = /<\|(eom_id|eot_id|im_end|end|call|return)\|>|<\/s>|<｜tool▁calls?▁end｜>/g

/**
 * Tool calls written in a model family's native text syntax. `known`: the tool names on offer (used
 * only by the unmarked formats, so prose can't turn into a call). Returns the first family that matched.
 */
export function familyToolCalls(text: string, known: Set<string>): Adapted {
  for (const a of ADAPTERS) {
    const r = a.run(text, known)
    if (r?.calls.length) return { calls: r.calls, rest: r.rest.replace(LEFTOVER, '').trim(), family: a.family }
  }
  return { calls: [], rest: text }
}
