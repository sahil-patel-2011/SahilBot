// The WebSocket wire format, shared by the server and the browser bridge. JSON, plus tagged values for
// what Electron's structured clone carried and JSON can't: bytes (Buffer / Uint8Array), Float32Array and Date.
//
//   client → server   { t: 'call', id, ch, args }  { t: 'send', ch, args }  { t: 'focus', focused, visible }
//   server → client   { t: 'ret', id, ok, v | e }  { t: 'ev', ch, args }  { t: 'hello', ... }  { t: 'bye', reason }

export type ClientMsg =
  | { t: 'call'; id: number; ch: string; args: unknown[] }
  | { t: 'send'; ch: string; args: unknown[] }
  | { t: 'focus'; focused: boolean; visible: boolean }
  | { t: 'ping' }

export type ServerMsg =
  | { t: 'ret'; id: number; ok: true; v: unknown }
  | { t: 'ret'; id: number; ok: false; e: string }
  | { t: 'ev'; ch: string; args: unknown[] }
  | { t: 'hello'; runtime: 'server'; version: string; device: { id: string; name: string }; platform: string }
  | { t: 'bye'; reason: string }
  | { t: 'pong' }

const TAG = '$sb'

const toB64 = (u: Uint8Array): string => {
  const B = (globalThis as { Buffer?: { from(u: Uint8Array): { toString(enc: string): string } } }).Buffer
  if (B) return B.from(u).toString('base64')
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => {
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer
  if (B) return B.from(s, 'base64')
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

function pack(v: unknown, depth = 0): unknown {
  if (depth > 64) return null
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? Number(v) : v
  if (v instanceof Float32Array) return { [TAG]: 'f32', d: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }
  if (v instanceof Uint8Array) return { [TAG]: 'u8', d: toB64(v) }
  if (v instanceof ArrayBuffer) return { [TAG]: 'u8', d: toB64(new Uint8Array(v)) }
  if (v instanceof Date) return { [TAG]: 'date', d: v.toISOString() }
  if (v instanceof Error) return { message: v.message, name: v.name }
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), pack(x, depth + 1)]))
  if (v instanceof Set) return [...v].map((x) => pack(x, depth + 1))
  if (Array.isArray(v)) return v.map((x) => pack(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined && typeof x !== 'function') out[k] = pack(x, depth + 1)
  return out
}

function unpack(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(unpack)
  const o = v as Record<string, unknown>
  if (typeof o[TAG] === 'string' && typeof o.d === 'string' && Object.keys(o).length === 2) {
    if (o[TAG] === 'u8') return fromB64(o.d)
    if (o[TAG] === 'f32') { const u = fromB64(o.d); return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)) }
    if (o[TAG] === 'date') return new Date(o.d)
  }
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    out[k] = unpack(x)
  }
  return out
}

export const encode = (msg: ClientMsg | ServerMsg): string => JSON.stringify(pack(msg))
export const decode = <T = unknown>(text: string): T => unpack(JSON.parse(text)) as T
