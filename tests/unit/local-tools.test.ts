import { describe, expect, test } from 'vitest'
import { recoverToolCalls } from '../../src/main/agent/recover'
import { buildBody, ollamaBody } from '../../src/main/llm/client'
import { constrainedRequest, constrainedResult, enforceableSchema } from '../../src/main/llm/constrained'
import { TOOL_PRIMER, smallLocal, toolTurnSampling, withToolPrimer } from '../../src/main/llm/local-tools'
import { familyToolCalls, parsePythonCalls } from '../../src/main/llm/tool-adapters'

const known = new Set(['web_search', 'fetch_page', 'file_write', 'browser', 'todo'])
const args = (r: { calls: Array<{ arguments: string }> }, i = 0): unknown => JSON.parse(r.calls[i].arguments)

// Real-looking outputs from local models whose server template didn't parse the call.
describe('tool calls written as text, per model family', () => {
  test('Qwen / Hermes: closing tag missing', () => {
    const r = recoverToolCalls('Let me look that up.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "ollama 0.9 release notes"}}', known)
    expect(r.calls[0].name).toBe('web_search')
    expect(args(r)).toEqual({ query: 'ollama 0.9 release notes' })
    expect(r.rest).toBe('Let me look that up.')
  })
  test('Llama 3.1/3.3: python_tag JSON with "parameters", two calls', () => {
    const r = recoverToolCalls('<|python_tag|>{"name": "web_search", "parameters": {"query": "atlanta weather"}}; {"name": "fetch_page", "parameters": {"url": "https://weather.gov"}}<|eom_id|>', known)
    expect(r.calls.map((c) => c.name)).toEqual(['web_search', 'fetch_page'])
    expect(r.rest).toBe('')
  })
  test('Llama 3.1: <function=name>{json}</function>', () => {
    const r = recoverToolCalls('<function=web_search>{"query": "best pizza in Decatur"}</function>', known)
    expect(args(r)).toEqual({ query: 'best pizza in Decatur' })
  })
  test('Llama 3.2 / 4: pythonic list, whole reply', () => {
    const r = recoverToolCalls('[web_search(query="FRC 2026 game manual"), fetch_page(url=\'https://firstinspires.org\')]', known)
    expect(r.calls.map((c) => c.name)).toEqual(['web_search', 'fetch_page'])
    expect(args(r, 1)).toEqual({ url: 'https://firstinspires.org' })
  })
  test('pythonic text that is not a known tool stays text', () => {
    expect(recoverToolCalls('print(hello(name="x"))', known).calls).toEqual([])
    expect(recoverToolCalls('You can call max(a=1, b=2) in Python.', known).calls).toEqual([])
  })
  test('Mistral: [TOOL_CALLS] JSON list and the [ARGS] form', () => {
    const a = recoverToolCalls('[TOOL_CALLS] [{"name": "file_write", "arguments": {"path": "notes.md", "content": "hi",}}]</s>', known)
    expect(args(a)).toEqual({ path: 'notes.md', content: 'hi' })
    const b = recoverToolCalls('[TOOL_CALLS]web_search[ARGS]{"query": "mistral small 3.2"}', known)
    expect(b.calls[0]).toMatchObject({ name: 'web_search' })
    expect(args(b)).toEqual({ query: 'mistral small 3.2' })
  })
  test('Gemma 3: tool_code fence with a Python call', () => {
    const r = recoverToolCalls('I will search.\n```tool_code\nprint(web_search(query="gemma 3 tool use", ))\n```', known)
    expect(args(r)).toEqual({ query: 'gemma 3 tool use' })
    expect(r.rest).toBe('I will search.')
  })
  test('Gemma 4: <|tool_call>call:name{…}<tool_call|> with quoted-string tokens', () => {
    const r = recoverToolCalls('<|tool_call>call:browser{action:<|"|>navigate<|"|>,url:<|"|>https://example.com<|"|>}<tool_call|>', known)
    expect(r.calls[0].name).toBe('browser')
    expect(args(r)).toEqual({ action: 'navigate', url: 'https://example.com' })
  })
  test('LFM: tool_call_start with a Python list, end token missing', () => {
    const r = recoverToolCalls('<|tool_call_start|>[todo(items=["buy milk", "call mom"], done=False)]', known)
    expect(args(r)).toEqual({ items: ['buy milk', 'call mom'], done: false })
  })
  test('DeepSeek: tool call tokens with a fenced JSON body', () => {
    const r = recoverToolCalls('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>web_search\n```json\n{"query": "deepseek v3.2"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>', known)
    expect(args(r)).toEqual({ query: 'deepseek v3.2' })
  })
  test('gpt-oss: leaked Harmony call', () => {
    const r = recoverToolCalls('<|start|>assistant<|channel|>commentary to=functions.fetch_page <|constrain|>json<|message|>{"url":"https://openai.com"}<|call|>', known)
    expect(r.calls[0].name).toBe('fetch_page')
  })
  test('ReAct text and LangChain-style JSON', () => {
    const a = recoverToolCalls('Thought: I need fresh info.\nAction: web_search\nAction Input: {"query": "nvidia earnings"}', known)
    expect(args(a)).toEqual({ query: 'nvidia earnings' })
    const b = recoverToolCalls('{"action": "web_search", "action_input": {"query": "x"}}', known)
    expect(b.calls[0].name).toBe('web_search')
    expect(recoverToolCalls('Action: dance\nAction Input: {"style": "salsa"}', known).calls).toEqual([])
  })
  test('misspelled names are fixed by recover', () => {
    expect(recoverToolCalls('[TOOL_CALLS][{"name": "websearch", "arguments": {"query": "x"}}]', known).calls[0].name).toBe('web_search')
  })
  test('plain prose and shown JSON stay text', () => {
    for (const t of ['Here is an example config: {"tool": "hammer"}', 'Use [link](https://x.com) for docs.', 'The function web_search(query) finds pages.']) {
      expect(familyToolCalls(t, known).calls, t).toEqual([])
    }
  })
  test('python literal parser', () => {
    expect(parsePythonCalls('f(a="x\\ny", b=1.5, c=None, d={"k": [1, 2]}, e=\'q\')')).toEqual([{ name: 'f', arguments: { a: 'x\ny', b: 1.5, c: null, d: { k: [1, 2] }, e: 'q' } }])
    expect(parsePythonCalls('f("positional")')).toBeNull()
    expect(parsePythonCalls('f(a=1) and more text')).toBeNull()
  })
})

describe('small local models: primer and cooler tool turns', () => {
  const sampling = { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0, repeat_penalty: 1 }
  const tool = { type: 'function' as const, function: { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: {} } } }
  test('who counts as small', () => {
    expect(smallLocal('qwen3.5:9b')).toBe(true)
    expect(smallLocal('gemma4:12b')).toBe(true)
    expect(smallLocal('lfm3:1.7b')).toBe(true)
    expect(smallLocal('qwen3.8:27b')).toBe(false)
    expect(smallLocal('mystery-model')).toBe(false)
  })
  test('temperature is capped on tool turns unless the user set one', () => {
    expect(toolTurnSampling('gemma4:12b', sampling, true).temperature).toBe(0.3)
    expect(toolTurnSampling('qwen3.5:9b', { ...sampling, temperature: 0.6 }, true).temperature).toBe(0.5)
    expect(toolTurnSampling('gemma4:12b', sampling, false).temperature).toBe(0.7)
    expect(toolTurnSampling('gemma4:12b', { ...sampling, temperature: 0.9 }, true).temperature).toBe(0.9)
    expect(toolTurnSampling('qwen3.8:27b', { ...sampling, temperature: 0.6 }, true).temperature).toBe(0.6)
  })
  test('the primer is added once to the system message, for small local models with tools', () => {
    const msgs = [{ role: 'system' as const, content: 'You are SahilBot.' }, { role: 'user' as const, content: 'hi' }]
    const out = withToolPrimer(msgs, 'gemma4:12b', true)
    expect(out[0].content).toBe(`You are SahilBot.${TOOL_PRIMER}`)
    expect(withToolPrimer(out, 'gemma4:12b', true)).toBe(out)
    expect(withToolPrimer(msgs, 'qwen3.8:27b', true)).toBe(msgs)
    expect(TOOL_PRIMER).toMatch(/One tool per step, then wait/)
    const body = buildBody({ baseUrl: 'http://localhost:1234/v1', model: 'gemma4:12b', messages: msgs, tools: [tool], maxTokens: 100, sampling })
    expect((body.messages as Array<{ content: string }>)[0].content).toContain('# How to call tools')
    expect(body.temperature).toBe(0.3)
    const ob = ollamaBody({ baseUrl: 'http://localhost:11434/v1', model: 'gemma4:12b', messages: msgs, tools: [tool], maxTokens: 100, sampling })
    expect((ob.options as { temperature: number }).temperature).toBe(0.3)
    // Hosted endpoints are untouched.
    const hosted = buildBody({ baseUrl: 'https://api.example.com/v1', model: 'gemma4:12b', messages: msgs, tools: [tool], maxTokens: 100, sampling })
    expect((hosted.messages as Array<{ content: string }>)[0].content).toBe('You are SahilBot.')
  })
})

describe('constrained retry for invalid arguments', () => {
  const tool = {
    name: 'browser', description: 'Control the browser.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['navigate', 'click'] }, url: { type: 'string' }, ref: { type: 'string' } }, required: ['action'], additionalProperties: false, allOf: [{ if: { properties: { action: { const: 'navigate' } } }, then: { required: ['url'] } }] }
  }
  const base = { baseUrl: 'http://localhost:11434/v1', model: 'gemma4:12b', tool, bad: '{"action":"navigat","link":"x"}', error: 'action must be one of navigate, click', request: 'open example.com' }
  test('conditional rules move into the prompt; the enforced schema has none', () => {
    const { schema, rules } = enforceableSchema(tool.parameters, tool.description)
    expect(schema.allOf).toBeUndefined()
    expect(rules).toMatch(/When action is "navigate": also give url/)
  })
  test('Ollama: format carries the schema, no streaming, temperature 0', () => {
    const r = constrainedRequest({ ...base, ollama: true, numCtx: 32768 })
    expect(r.url).toBe('http://localhost:11434/api/chat')
    expect(r.body).toMatchObject({ stream: false, think: false, options: { temperature: 0, num_ctx: 32768 } })
    expect((r.body.format as { required: string[] }).required).toEqual(['action'])
    expect(JSON.stringify(r.body.messages)).toContain('open example.com')
  })
  test('llama.cpp / LM Studio: response_format json_schema', () => {
    const r = constrainedRequest({ ...base, baseUrl: 'http://localhost:8080/v1', ollama: false })
    expect(r.url).toBe('http://localhost:8080/v1/chat/completions')
    expect(r.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'browser', strict: true } })
  })
  test('reading the result', () => {
    expect(constrainedResult({ message: { content: '{"action":"navigate","url":"https://example.com"}' } }, true)).toBe('{"action":"navigate","url":"https://example.com"}')
    expect(constrainedResult({ choices: [{ message: { content: '```json\n{"action":"click","ref":"e2"}\n```' } }] }, false)).toBe('{"action":"click","ref":"e2"}')
    expect(constrainedResult({ message: { content: 'sorry' } }, true)).toBeNull()
    expect(constrainedResult({ choices: [] }, false)).toBeNull()
  })
})
