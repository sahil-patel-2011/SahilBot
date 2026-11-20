#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const ready = existsSync(join(process.env.GROK_HOME, 'signed-in'))
let authenticated = false
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const { id, method, params, jsonrpc } = JSON.parse(line)
  appendFileSync(join(process.env.GROK_HOME, 'requests.ndjson'), JSON.stringify({ method, sessionId: params?.sessionId, prompt: params?.prompt?.[0]?.text }) + '\n')
  const error = (message) => send({ id, error: { code: -32000, message } })
  const result = (value) => send({ id, result: value })
  if (jsonrpc !== '2.0' || process.env.XAI_API_KEY || process.env.GROK_DEPLOYMENT_KEY || !process.argv.includes('strict') || !process.argv.includes('--disable-web-search')) {
    error('Unsafe test environment')
  } else if (method === 'initialize') {
    result({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: ready ? [{ id: 'cached_token' }] : [{ id: 'grok.com' }] })
  } else if (method === 'authenticate' && ready && params.methodId === 'cached_token') {
    authenticated = true
    result({})
  } else if (method === 'session/new') {
    // Each new session gets its own ID, as the real CLI's do; the IDs issued so far persist across processes.
    const issued = join(process.env.GROK_HOME, 'sessions.json')
    const ids = existsSync(issued) ? JSON.parse(readFileSync(issued, 'utf8')) : []
    const sessionId = ids.length ? `isolated-${ids.length + 1}` : 'isolated'
    writeFileSync(issued, JSON.stringify([...ids, sessionId]))
    if (authenticated && !params.mcpServers.length) result({ sessionId })
    else error('Authentication required')
  } else if (method === 'session/load' && authenticated && existsSync(join(process.env.GROK_HOME, 'sessions.json')) && JSON.parse(readFileSync(join(process.env.GROK_HOME, 'sessions.json'), 'utf8')).includes(params.sessionId)) {
    send({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call' } } })
    result({})
  } else if (method === 'session/prompt') {
    const prompt = params.prompt[0].text
    if (prompt.includes('QUOTA_FIXTURE')) { error('Subscription usage limit'); continue }
    if (prompt.includes('NATIVE_TOOL_FIXTURE')) {
      send({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call' } } })
      continue
    }
    const text = prompt.includes('SAVE_FIXTURE') && !prompt.includes('"role":"tool"')
      ? JSON.stringify({ sahilbot_action: 'tools', calls: [{ name: 'file_write', arguments: { path: 'fixture.txt', content: 'Subscription fixture' } }] })
      : 'Ready.'
    send({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
    result({ stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } })
  } else error('Unsupported test method')
}
