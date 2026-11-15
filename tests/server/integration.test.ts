import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { decode, encode } from '../../src/server/codec'
import { formatCode } from '../../src/server/auth'
import type { RunningServer } from '../../src/server/boot'

// SahilBot Server in-process: the Mac app's main process under Node with the headless `electron`, a mock
// model server, and a paired "browser" on the WebSocket that sends a message, streams the reply and
// approves an action. Nothing leaves 127.0.0.1.

let llm: MockLlm
let srv: RunningServer
const data = mkdtempSync(join(tmpdir(), 'sb-server-it-'))
const workspace = mkdtempSync(join(tmpdir(), 'sb-server-ws-'))

beforeAll(async () => {
  llm = await startMockLlm()
  Object.assign(process.env, { FOREMAN_BASE_URL: llm.url, FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', FOREMAN_NO_VERIFY: '1', FOREMAN_RAM_GB: '64', SAHILBOT_KNOWLEDGE: '0', SAHILBOT_LEARNING: '0' })
  const { startServer } = await import('../../src/server/boot')
  srv = await startServer({ data, port: 0, listen: '127.0.0.1', scryptN: 2 ** 10, log: () => undefined, uiDir: join(process.cwd(), 'out', 'renderer'), bridgeFile: join(process.cwd(), 'out', 'server', 'web', 'bridge.js') })
})
afterAll(async () => { await srv?.stop(); await llm?.close() })

interface Client { ws: WebSocket; events: Array<{ ch: string; args: any[] }>; call: (ch: string, ...args: unknown[]) => Promise<any> }

let firstUsed = false
async function connect(): Promise<Client> {
  const base = srv.url
  // The code printed at first start, then fresh ones (each works once).
  const code = firstUsed ? srv.codes.create().code : srv.firstCode!
  firstUsed = true
  const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code: formatCode(code), name: 'Integration' }) })
  expect(r.status).toBe(200)
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Origin: base, Cookie: cookie } } as never)
  const events: Client['events'] = []
  const waiting = new Map<number, (m: any) => void>()
  let id = 0
  ws.onmessage = (m) => {
    const msg = decode<any>(String(m.data))
    if (msg.t === 'ev') events.push({ ch: msg.ch, args: msg.args })
    else if (msg.t === 'ret') waiting.get(msg.id)?.(msg)
  }
  await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('ws refused')) })
  const call = (ch: string, ...args: unknown[]): Promise<any> => new Promise((ok, fail) => {
    const n = ++id
    waiting.set(n, (msg) => { waiting.delete(n); if (msg.ok) ok(msg.v); else fail(new Error(msg.e)) })
    ws.send(encode({ t: 'call', id: n, ch, args }))
  })
  return { ws, events, call }
}

const until = async <T>(f: () => T | undefined | false, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('SahilBot Server', () => {
  test('boots headless: Electron-only services off, secrets sealed, the web UI served', async () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(srv.firstCode).toMatch(/^[2-9A-Z]{10}$/)
    expect(existsSync(join(data, 'foreman.db'))).toBe(true)
    // The SQLite database runs in WAL mode (a -wal file next to it).
    expect(existsSync(join(data, 'foreman.db-wal'))).toBe(true)
    const c = await connect()
    const info = await c.call('server:info')
    expect(info).toMatchObject({ runtime: 'server', tls: false, keySource: 'keyfile' })
    expect(info.runs.limit).toBeGreaterThanOrEqual(2)
    expect(info.unavailable.join(' ')).toMatch(/computer use/)
    // Secrets go through the server's AES-GCM safeStorage: saved, never sent back, sealed in the database.
    await c.call('settings:set', { setKeys: { anthropic: 'sk-ant-test-not-real-123' }, workspaceDir: workspace })
    const s = await c.call('settings:get')
    expect(JSON.stringify(s)).not.toContain('sk-ant-test-not-real-123')
    expect(readFileSync(join(data, 'foreman.db')).toString('latin1')).not.toContain('sk-ant-test-not-real-123')
    // Mac-only channels answer without crashing (cancelled dialogs, no Touch ID).
    expect(await c.call('files:pick', 'files')).toEqual([])
    await expect(c.call('vault:reveal', 'x')).rejects.toThrow('turned off on SahilBot Server')
    const vault = await c.call('vault:status')
    expect(vault.touchIdAvailable ?? false).toBe(false)
    c.ws.close()
  })

  test('a chat over the WebSocket: send, stream the reply, approve an action', async () => {
    const c = await connect()
    const spaces = await c.call('spaces:list')
    const main = spaces.find((x: any) => x.isMain)
    const thread = await c.call('threads:create', main.id)
    await c.call('threads:update', thread.id, { permissionMode: 'ask' })

    // 1. A plain reply, streamed.
    llm.script.push({ content: 'Hello from the Pi, streaming word by word.', delay: 20 })
    await c.call('chat:send', { threadId: thread.id, text: 'Say hello' })
    await until(() => c.events.some((e) => e.ch === 'chat:event' && e.args[0].threadId === thread.id && e.args[0].type === 'delta'))
    await until(() => c.events.some((e) => e.ch === 'chat:event' && e.args[0].type === 'run' && e.args[0].status === 'finished' && e.args[0].threadId === thread.id))
    const deltas = c.events.filter((e) => e.ch === 'chat:event' && e.args[0].type === 'delta' && e.args[0].threadId === thread.id).length
    expect(deltas).toBeGreaterThan(3)
    const msgs = await c.call('threads:messages', thread.id)
    expect(msgs.some((m: any) => m.role === 'assistant' && m.content.includes('Hello from the Pi'))).toBe(true)
    // The model never saw a Mac-only tool.
    const tools = llm.requests.flatMap((r) => (r.tools ?? []).map((t: any) => t.function?.name))
    for (const t of ['computer', 'browser', 'mac_apps', 'mail', 'app']) expect(tools).not.toContain(t)

    // 2. An action that needs approval: the card arrives over the WebSocket, the answer goes back.
    const before = c.events.length
    llm.script.push(
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'from-the-pi.txt', content: 'approved over the web' }) }], delay: 0 },
      { content: 'Saved the file.', delay: 5 }
    )
    await c.call('chat:send', { threadId: thread.id, text: 'Write a file from-the-pi.txt saying approved over the web' })
    const pending = await until(() => c.events.slice(before).find((e) => e.ch === 'chat:event' && e.args[0].type === 'pending' && e.args[0].threadId === thread.id))
    const req = pending.args[0].request
    expect(req.tool).toBe('file_write')
    // The approval card also went to the paired devices as a notification (none focused).
    await until(() => c.events.slice(before).some((e) => e.ch === 'server:notify' && e.args[0].threadId === thread.id))
    expect((await c.call('chat:pending', thread.id)).map((r: any) => r.id)).toContain(req.id)
    await c.call('chat:respond', thread.id, req.id, 'allow')
    await until(() => c.events.slice(before).some((e) => e.ch === 'chat:event' && e.args[0].type === 'run' && e.args[0].status === 'finished' && e.args[0].threadId === thread.id))
    expect(readFileSync(join(workspace, 'from-the-pi.txt'), 'utf8')).toBe('approved over the web')
    expect(srv.audit.recent(50).some((e) => e.kind === 'call.approval' && e.detail?.includes('chat:respond'))).toBe(true)
    c.ws.close()
  })

  test('routines and bots exist headless; revoking a device signs it out', async () => {
    const c = await connect()
    expect(Array.isArray(await c.call('schedules:list'))).toBe(true)
    const devices = await c.call('server:devices')
    const me = devices.find((d: any) => d.current)
    const closed = new Promise<number>((r) => { c.ws.onclose = (e) => r(e.code) })
    // Removing yourself: the session closes before the reply can arrive.
    void c.call('server:revokeDevice', me.id).catch(() => undefined)
    expect(await closed).toBe(4001)
    const status = await fetch(`${srv.url}/api/status`)
    expect(status.status).toBe(401)
  })
})
