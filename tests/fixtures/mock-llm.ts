import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// A scriptable OpenAI-compatible server for tests. Each chat request pops the
// next scripted reply; with an empty script it echoes the last user message.

export interface ScriptedReply {
  content?: string
  reasoning?: string
  toolCalls?: Array<{ name: string; arguments: string }>
  /** ms between streamed chunks */
  delay?: number
  status?: number
  /** finish_reason to report (default: tool_calls or stop), e.g. 'length' for a reply cut off by the output limit. */
  finish?: string
}

export interface MockLlm {
  url: string
  requests: Array<Record<string, any>>
  /** Replies, or functions that build a reply from the request (e.g. to read refs from the last snapshot). */
  script: Array<ScriptedReply | ((req: Record<string, any>) => ScriptedReply)>
  models: string[]
  tokenize: boolean
  close(): Promise<void>
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((ok) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => ok(s))
  })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function lastUserText(messages: any[]): string {
  const m = [...messages].reverse().find((x) => x.role === 'user')
  if (!m) return ''
  return typeof m.content === 'string' ? m.content : m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ')
}

function resolveReply(r: MockLlm['script'][number] | undefined, req: Record<string, any>): ScriptedReply | undefined {
  return typeof r === 'function' ? r(req) : r
}

/** Text of the most recent tool result in a request. */
export function lastToolOutput(req: Record<string, any>): string {
  const t = [...req.messages].reverse().find((m: any) => m.role === 'tool')
  return t ? String(t.content) : ''
}

/** Finds the ref of the first element matching `role "name"` in a browser snapshot. */
export function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(`- ${role} "${name}`) && l.includes('[ref='))
  if (!line) throw new Error(`No ${role} "${name}" in snapshot:\n${snapshot}`)
  return line.match(/\[ref=(e\d+)\]/)![1]
}

export async function startMockLlm(): Promise<MockLlm> {
  const state: Omit<MockLlm, 'url' | 'close'> = { requests: [], script: [], models: ['qwen3.8:27b', 'llama3.3:70b'], tokenize: false }
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ object: 'list', data: state.models.map((id) => ({ id, object: 'model' })) }))
    }
    if (req.method === 'GET' && url.startsWith('/search?')) {
      // SearXNG-compatible results for web_search tests.
      const q = new URL(url, 'http://x').searchParams.get('q') ?? ''
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ results: [{ title: `Result for ${q}`, url: 'https://example.com/a', content: `Snippet about ${q}` }] }))
    }
    if (req.method === 'POST' && url === '/tokenize' && state.tokenize) {
      const { content } = JSON.parse(await body(req))
      // 1 token per 4 chars, deterministic.
      return res.end(JSON.stringify({ tokens: Array.from({ length: Math.ceil(String(content).length / 4) }, (_, i) => i) }))
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      const json = JSON.parse(await body(req))
 state.requests.push(json)
      const isSummary = String(json.messages?.[0]?.content ?? '').includes('You are compressing')
      const reply: ScriptedReply = isSummary
        ? { content: '## Goal\nTest the app\n## Decisions\n- none\n## Facts\n- codeword is PELICAN\n## Open items\n- none\n## Files/URLs\n- none', delay: 0 }
        : resolveReply(state.script.shift(), json) ?? { content: `Echo: ${lastUserText(json.messages)}`, reasoning: 'Thinking about it.' }
      if (reply.status && reply.status !== 200) {
        res.statusCode = reply.status
        return res.end(JSON.stringify({ error: { message: 'scripted failure' } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      }
      let closed = false
      req.on('close', () => (closed = true))
      const delay = reply.delay ?? 15
      if (reply.reasoning) {
        send({ content: '<think>' })
        for (const w of reply.reasoning.split(/(?<= )/)) { send({ content: w }); await sleep(delay) }
        send({ content: '</think>' })
      }
      for (const w of (reply.content ?? '').split(/(?<= )/)) {
        if (closed) return
        send({ content: w })
        await sleep(delay)
      }
      reply.toolCalls?.forEach((tc, i) => {
        send({ tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: tc.name, arguments: '' } }] })
        send({ tool_calls: [{ index: i, function: { arguments: tc.arguments } }] })
      })
      send({}, reply.finish ?? (reply.toolCalls?.length ? 'tool_calls' : 'stop'))
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()) })
  })
}
