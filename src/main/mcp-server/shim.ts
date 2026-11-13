import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The stdio bridge for apps that only launch commands (Claude Desktop): `sahilbot-mcp` reads JSON-RPC
// lines on stdin, posts each to the local server with the app's token (SAHILBOT_MCP_TOKEN), and writes
// the replies to stdout. It has no dependencies and runs on SahilBot's own binary as Node
// (ELECTRON_RUN_AS_NODE), so nothing else needs to be installed. Rewritten each time the server starts.

export const SHIM_NAME = 'sahilbot-mcp'
export const SHIM_SCRIPT = 'sahilbot-mcp.cjs'

export const SHIM_SOURCE = `'use strict'
// SahilBot MCP bridge: stdio <-> SahilBot's local MCP server. Written by SahilBot; edits are overwritten.
// Needs SAHILBOT_MCP_TOKEN (SahilBot -> Settings -> Privacy & Permissions -> Connected apps).
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const token = (process.env.SAHILBOT_MCP_TOKEN || '').trim()
const MAX_BUFFER = 4 * 1024 * 1024
const HOW = 'SahilBot -> Settings -> Privacy & Permissions -> Connected apps'

function port() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(__dirname, 'server.json'), 'utf8')).port) || 0 } catch (e) { return 0 }
}
function out(msg) { process.stdout.write(JSON.stringify(msg) + '\\n') }
function emit(j) { if (Array.isArray(j)) j.forEach(out); else if (j) out(j) }
function fail(id, message) { if (id !== undefined && id !== null) out({ jsonrpc: '2.0', id: id, error: { code: -32000, message: message } }) }

let inflight = 0
let ended = false
function done() { inflight--; if (ended && inflight === 0) process.exit(0) }

function forward(msg) {
  const id = Array.isArray(msg) ? undefined : msg && msg.id
  if (!token) return fail(id, 'SAHILBOT_MCP_TOKEN is not set. Connect this app in ' + HOW + '.')
  const p = port()
  if (!p) return fail(id, 'SahilBot\\'s MCP server is off. Turn it on in ' + HOW + '.')
  const body = Buffer.from(JSON.stringify(msg))
  inflight++
  const req = http.request({
    host: '127.0.0.1', port: p, path: '/mcp', method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token, 'content-length': body.length }
  }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        if (res.statusCode === 202 || !text.trim()) { /* a notification: nothing comes back */ }
        else if (/text\\/event-stream/.test(String(res.headers['content-type'] || ''))) {
          for (const block of text.split(/\\r?\\n\\r?\\n/)) {
            const data = block.split(/\\r?\\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\\n')
            if (data) emit(JSON.parse(data))
          }
        } else {
          const j = JSON.parse(text)
          if (res.statusCode >= 400 && j && j.error && (j.id === null || j.id === undefined)) fail(id, j.error.message || ('HTTP ' + res.statusCode))
          else emit(j)
        }
      } catch (e) { fail(id, 'Unexpected answer from SahilBot (HTTP ' + res.statusCode + ').') }
      done()
    })
  })
  req.on('error', () => { fail(id, 'SahilBot is not running, or its MCP server is off (' + HOW + ').'); done() })
  req.end(body)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  if (buf.length > MAX_BUFFER) { buf = ''; out({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } }); return }
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch (e) { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue }
    forward(msg)
  }
})
process.stdin.on('end', () => { ended = true; if (inflight === 0) process.exit(0) })
`

/** Single-quotes a path for /bin/sh. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The launcher: runs the bridge on SahilBot's own binary as Node. */
export function launcherSource(execPath: string, script: string): string {
  return `#!/bin/sh
# SahilBot MCP bridge for apps that launch a command (e.g. Claude Desktop). Written by SahilBot.
# Set SAHILBOT_MCP_TOKEN in the app's config (SahilBot -> Settings -> Privacy & Permissions -> Connected apps).
ELECTRON_RUN_AS_NODE=1 exec ${shQuote(execPath)} ${shQuote(script)} "$@"
`
}

/** Writes the bridge into `dir` and returns the command to point apps at. */
export function writeShim(dir: string, execPath: string): string {
  mkdirSync(dir, { recursive: true })
  const script = join(dir, SHIM_SCRIPT)
  const launcher = join(dir, SHIM_NAME)
  writeFileSync(script, SHIM_SOURCE)
  chmodSync(script, 0o644)
  writeFileSync(launcher, launcherSource(execPath, script))
  chmodSync(launcher, 0o755)
  return launcher
}
