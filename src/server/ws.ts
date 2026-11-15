// A small WebSocket server (RFC 6455) on node:http: the handshake, framing, fragmentation, ping/pong and
// the closing handshake. Text and binary messages, no extensions (no permessage-deflate is offered, so
// clients never compress). No dependencies.

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const acceptKey = (key: string): string => createHash('sha1').update(key + GUID).digest('base64')

export interface WsOptions {
  /** Largest message accepted (after reassembly). */
  maxPayload?: number
  /** A client this far behind on reading gets disconnected instead of growing the server's memory. */
  maxBuffered?: number
}

const enum Op { Cont = 0x0, Text = 0x1, Binary = 0x2, Close = 0x8, Ping = 0x9, Pong = 0xa }

export class WsConnection extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0)
  private parts: Buffer[] = []
  private partsLen = 0
  private partsOp: Op | null = null
  private closing = false
  private closed = false
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  readonly maxPayload: number
  readonly maxBuffered: number
  /** Last time anything arrived (for heartbeats). */
  lastSeen = Date.now()

  constructor(readonly socket: Duplex, o: WsOptions = {}) {
    super()
    this.maxPayload = o.maxPayload ?? 16 * 1024 * 1024
    this.maxBuffered = o.maxBuffered ?? 32 * 1024 * 1024
    socket.on('data', (d: Buffer) => this.onData(d))
    socket.on('close', () => this.finish(1006, ''))
    socket.on('error', () => this.finish(1006, ''))
    socket.on('end', () => this.finish(1006, ''))
  }

  get isOpen(): boolean { return !this.closing && !this.closed }

  private onData(d: Buffer): void {
    this.lastSeen = Date.now()
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    try {
      while (this.parseFrame()) { /* keep going */ }
    } catch (e) {
      const code = (e as { wsCode?: number }).wsCode ?? 1002
      this.close(code, (e as Error).message.slice(0, 100))
    }
  }

  private fail(code: number, message: string): never {
    throw Object.assign(new Error(message), { wsCode: code })
  }

  /** Parses one frame from the buffer; false when more bytes are needed. */
  private parseFrame(): boolean {
    const b = this.buf
    if (b.length < 2) return false
    const fin = (b[0] & 0x80) !== 0
    if (b[0] & 0x70) this.fail(1002, 'reserved bits set')
    const op = (b[0] & 0x0f) as Op
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < 4) return false
      len = b.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (b.length < 10) return false
      const big = b.readBigUInt64BE(2)
      if (big > BigInt(this.maxPayload)) this.fail(1009, 'message too big')
      len = Number(big)
      off = 10
    }
    if (!masked) this.fail(1002, 'client frames must be masked')
    if (len > this.maxPayload) this.fail(1009, 'message too big')
    if (b.length < off + 4 + len) return false
    const mask = b.subarray(off, off + 4)
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len))
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    this.buf = b.subarray(off + 4 + len)
    this.onFrame(fin, op, payload)
    return this.buf.length > 0 && !this.closed
  }

  private onFrame(fin: boolean, op: Op, payload: Buffer): void {
    if (op >= 0x8) {
      if (!fin || payload.length > 125) this.fail(1002, 'bad control frame')
      if (op === Op.Ping) this.frame(Op.Pong, payload)
      else if (op === Op.Pong) this.emit('pong')
      else if (op === Op.Close) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        if (!this.closing) { this.closing = true; this.frame(Op.Close, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0)) }
        this.socket.end()
        this.finish(code, reason)
      } else this.fail(1002, 'unknown opcode')
      return
    }
    if (op === Op.Cont) {
      if (this.partsOp === null) this.fail(1002, 'continuation without a start')
    } else if (op === Op.Text || op === Op.Binary) {
      if (this.partsOp !== null) this.fail(1002, 'new message inside a fragmented one')
      this.partsOp = op
    } else this.fail(1002, 'unknown opcode')
    this.parts.push(payload)
    this.partsLen += payload.length
    if (this.partsLen > this.maxPayload) this.fail(1009, 'message too big')
    if (!fin) return
    const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts)
    const kind = this.partsOp
    this.parts = []
    this.partsLen = 0
    this.partsOp = null
    if (kind === Op.Text) {
      let text: string
      try { text = this.decoder.decode(whole) } catch { this.fail(1007, 'invalid UTF-8') }
      this.emit('message', text, false)
    } else this.emit('message', whole, true)
  }

  private frame(op: Op, payload: Buffer): void {
    if (this.closed) return
    const len = payload.length
    const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    head[0] = 0x80 | op
    if (len < 126) head[1] = len
    else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2) }
    else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2) }
    this.socket.write(Buffer.concat([head, payload]))
    const pending = (this.socket as unknown as { writableLength?: number }).writableLength ?? 0
    if (pending > this.maxBuffered) { this.socket.destroy(); this.finish(1008, 'client too slow') }
  }

  send(data: string | Buffer): void {
    if (!this.isOpen) return
    if (typeof data === 'string') this.frame(Op.Text, Buffer.from(data, 'utf8'))
    else this.frame(Op.Binary, data)
  }

  ping(): void { if (this.isOpen) this.frame(Op.Ping, Buffer.alloc(0)) }

  close(code = 1000, reason = ''): void {
    if (this.closing || this.closed) return
    this.closing = true
    const r = Buffer.from(reason, 'utf8').subarray(0, 120)
    const p = Buffer.alloc(2 + r.length)
    p.writeUInt16BE(code, 0)
    r.copy(p, 2)
    this.frame(Op.Close, p)
    // The peer answers with its own close; if it doesn't, the socket goes anyway.
    setTimeout(() => this.socket.destroy(), 2000).unref?.()
    this.socket.end()
  }

  /** Drops the connection without a closing handshake. */
  terminate(): void { this.socket.destroy(); this.finish(1006, '') }

  private finish(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closing = true
    this.emit('close', code, reason)
  }
}

/** Whether a request asks to become a WebSocket. */
export function isUpgrade(req: IncomingMessage): boolean {
  return String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
}

/**
 * Completes the opening handshake on an upgrade request (after the caller has authenticated it).
 * Returns null (and answers 400) when the request isn't a valid WebSocket handshake.
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, o: WsOptions = {}): WsConnection | null {
  const key = String(req.headers['sec-websocket-key'] ?? '')
  const conn = String(req.headers.connection ?? '').toLowerCase()
  const okKey = /^[A-Za-z0-9+/]{22}==$/.test(key)
  if (req.method !== 'GET' || !isUpgrade(req) || !conn.split(/\s*,\s*/).includes('upgrade') || req.headers['sec-websocket-version'] !== '13' || !okKey) {
    rejectUpgrade(socket, 400, 'Bad WebSocket handshake')
    return null
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', ''
  ].join('\r\n'))
  ;(socket as unknown as { setNoDelay?: (b: boolean) => void }).setNoDelay?.(true)
  const ws = new WsConnection(socket, o)
  if (head?.length) socket.unshift(head)
  return ws
}

/** Answers an upgrade request with an HTTP error and closes it. */
export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
  } finally { socket.destroy() }
}
