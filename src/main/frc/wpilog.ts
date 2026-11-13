// WPILib DataLog (.wpilog) reader and a small writer (used by tests and fixtures).
// Implemented from the format spec (version 1.0):
// https://github.com/wpilibsuite/allwpilib/blob/main/datalog/doc/datalog.adoc
//
// Layout: "WPILOG" + uint16 version (0x0100) + uint32 extra-header length + UTF-8 extra header, then
// records. Each record: a 1-byte bitfield (bits 0-1 entry-id bytes - 1, bits 2-3 payload-size bytes - 1,
// bits 4-6 timestamp bytes - 1), then the entry id, payload size and timestamp (all little endian,
// variable width), then the payload. Entry id 0 is a control record: Start (0), Finish (1) or
// Set metadata (2). Timestamps are integer microseconds (robot program time on a roboRIO).

export interface WpilogEntry {
  id: number
  name: string
  type: string
  metadata: string
  /** Timestamp of the Start record, microseconds. */
  startUs: number
}

export interface WpilogHeader {
  version: number
  extraHeader: string
  /** Byte offset of the first record. */
  offset: number
}

export type ScalarValue = number | boolean | string
export type WpilogValue = ScalarValue | number[] | boolean[] | string[] | Uint8Array | Record<string, ScalarValue> | Array<Record<string, ScalarValue>> | null

const MAGIC = 'WPILOG'
const utf8 = new TextDecoder('utf-8')

export function isWpilog(buf: Uint8Array): boolean {
  return buf.length >= 12 && String.fromCharCode(...buf.subarray(0, 6)) === MAGIC
}

export function readHeader(buf: Uint8Array): WpilogHeader {
  if (!isWpilog(buf)) throw new Error('Not a WPILib data log (.wpilog): the file does not start with "WPILOG".')
  const dv = view(buf)
  const version = dv.getUint16(6, true)
  if (version >> 8 !== 1) throw new Error(`Unsupported .wpilog version ${(version >> 8)}.${version & 0xff} (this reader supports 1.x).`)
  const len = dv.getUint32(8, true)
  if (12 + len > buf.length) throw new Error('Truncated .wpilog header.')
  return { version, extraHeader: utf8.decode(buf.subarray(12, 12 + len)), offset: 12 + len }
}

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength)

function readUint(buf: Uint8Array, at: number, n: number): number {
  // Up to 8 bytes; values above 2^53 lose precision, which never matters for robot timestamps.
  let v = 0
  for (let i = n - 1; i >= 0; i--) v = v * 256 + buf[at + i]
  return v
}

export interface ScanHandlers {
  start?(e: WpilogEntry): void
  finish?(e: WpilogEntry, us: number): void
  metadata?(e: WpilogEntry): void
  /** A data record. `payload` is a view into the file buffer: copy it if you keep it. */
  data?(e: WpilogEntry, us: number, payload: Uint8Array): void
}

export interface ScanResult {
  header: WpilogHeader
  entries: WpilogEntry[]
  records: number
  /** Set when the file ends in the middle of a record (a log cut off by a power loss). */
  truncated: boolean
  /** Records that referenced an entry id with no Start record. */
  orphans: number
}

/** Walks every record once. Fast enough for logs of a few hundred MB. */
export function scanWpilog(buf: Uint8Array, h: ScanHandlers = {}): ScanResult {
  const header = readHeader(buf)
  const live = new Map<number, WpilogEntry>()
  const all: WpilogEntry[] = []
  let at = header.offset
  let records = 0
  let truncated = false
  let orphans = 0
  const dv = view(buf)
  while (at < buf.length) {
    const bits = buf[at]
    const idLen = (bits & 0x3) + 1
    const sizeLen = ((bits >> 2) & 0x3) + 1
    const tsLen = ((bits >> 4) & 0x7) + 1
    const headLen = 1 + idLen + sizeLen + tsLen
    if (at + headLen > buf.length) { truncated = true; break }
    const id = readUint(buf, at + 1, idLen)
    const size = readUint(buf, at + 1 + idLen, sizeLen)
    const us = readUint(buf, at + 1 + idLen + sizeLen, tsLen)
    const p0 = at + headLen
    if (p0 + size > buf.length) { truncated = true; break }
    const payload = buf.subarray(p0, p0 + size)
    at = p0 + size
    records++
    if (id === 0) {
      if (size < 5) continue
      const kind = payload[0]
      const target = dv.getUint32(p0 + 1, true)
      if (kind === 0) {
        let o = 5
        const str = (): string => {
          if (o + 4 > size) throw new Error('bad start record')
          const n = dv.getUint32(p0 + o, true)
          const s = utf8.decode(payload.subarray(o + 4, o + 4 + n))
          o += 4 + n
          return s
        }
        try {
          const e: WpilogEntry = { id: target, name: str(), type: str(), metadata: str(), startUs: us }
          live.set(target, e)
          all.push(e)
          h.start?.(e)
        } catch { /* malformed control record: skip it */ }
      } else if (kind === 1) {
        const e = live.get(target)
        if (e) { live.delete(target); h.finish?.(e, us) }
      } else if (kind === 2 && size >= 9) {
        const e = live.get(target)
        const n = dv.getUint32(p0 + 5, true)
        if (e) { e.metadata = utf8.decode(payload.subarray(9, 9 + n)); h.metadata?.(e) }
      }
      continue
    }
    const e = live.get(id)
    if (!e) { orphans++; continue }
    h.data?.(e, us, payload)
  }
  return { header, entries: all, records, truncated, orphans }
}

// ---------------------------------------------------------------- value decoding

const NUMERIC = new Set(['double', 'float', 'int64', 'boolean'])
export const isNumericType = (t: string): boolean => NUMERIC.has(t)
export const isNumericArrayType = (t: string): boolean => t === 'double[]' || t === 'float[]' || t === 'int64[]' || t === 'boolean[]'

/** Decodes a scalar numeric payload (double, float, int64, boolean as 0/1). NaN when malformed. */
export function decodeNumber(type: string, p: Uint8Array): number {
  const dv = view(p)
  switch (type) {
    case 'double': return p.length >= 8 ? dv.getFloat64(0, true) : NaN
    case 'float': return p.length >= 4 ? dv.getFloat32(0, true) : NaN
    case 'int64': return p.length >= 8 ? Number(dv.getBigInt64(0, true)) : NaN
    case 'boolean': return p.length >= 1 ? (p[0] ? 1 : 0) : NaN
    default: return NaN
  }
}

export function decodeNumberArray(type: string, p: Uint8Array): number[] {
  const dv = view(p)
  const out: number[] = []
  switch (type) {
    case 'double[]': for (let i = 0; i + 8 <= p.length; i += 8) out.push(dv.getFloat64(i, true)); break
    case 'float[]': for (let i = 0; i + 4 <= p.length; i += 4) out.push(dv.getFloat32(i, true)); break
    case 'int64[]': for (let i = 0; i + 8 <= p.length; i += 8) out.push(Number(dv.getBigInt64(i, true))); break
    case 'boolean[]': for (let i = 0; i < p.length; i++) out.push(p[i] ? 1 : 0); break
  }
  return out
}

export function decodeStringArray(p: Uint8Array): string[] {
  if (p.length < 4) return []
  const dv = view(p)
  const n = dv.getUint32(0, true)
  const out: string[] = []
  let o = 4
  for (let i = 0; i < n && o + 4 <= p.length; i++) {
    const len = dv.getUint32(o, true)
    out.push(utf8.decode(p.subarray(o + 4, o + 4 + len)))
    o += 4 + len
  }
  return out
}

/** Decodes any payload. Structs need the schemas collected from "/.schema/struct:..." entries. */
export function decodeValue(type: string, p: Uint8Array, schemas?: StructSchemas): WpilogValue {
  if (isNumericType(type)) return type === 'boolean' ? p[0] !== 0 : decodeNumber(type, p)
  if (type === 'boolean[]') return Array.from(p, (b) => b !== 0)
  if (isNumericArrayType(type)) return decodeNumberArray(type, p)
  if (type === 'string' || type === 'json' || type === 'structschema') return utf8.decode(p)
  if (type === 'string[]') return decodeStringArray(p)
  if (type.startsWith('struct:') && schemas) {
    const arr = type.endsWith('[]')
    const name = type.slice(7, arr ? -2 : undefined)
    return arr ? schemas.decodeArray(name, p) : schemas.decode(name, p)
  }
  return new Uint8Array(p)
}

// ---------------------------------------------------------------- WPILib struct schemas

// Struct schemas are published as entries named "/.schema/struct:<Name>" of type "structschema" whose
// value is the declaration, e.g. "Translation2d translation;Rotation2d rotation". Fields are primitive
// types (bool, char, int8..int64, uint8..uint64, float/float32, double/float64), nested structs, or fixed
// arrays ("double q[4]"); "enum {...}" prefixes are allowed. Bit-fields are not decoded here.
// Spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/struct.adoc

interface Field { name: string; type: string; count: number | null; bits: boolean }
const PRIM: Record<string, number> = { bool: 1, char: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float: 4, float32: 4, double: 8, float64: 8 }

export class StructSchemas {
  private defs = new Map<string, Field[]>()

  add(name: string, schema: string): void {
    const fields: Field[] = []
    for (const raw of schema.split(';')) {
      const decl = raw.replace(/^\s*(?:enum)?\s*\{[^}]*\}/, '').trim()
      if (!decl) continue
      const m = decl.match(/^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)\s*(?:\[\s*(\d+)\s*\])?\s*(:\s*\d+)?$/)
      if (!m) { this.defs.set(name, []); return }
      fields.push({ type: m[1], name: m[2], count: m[3] ? Number(m[3]) : null, bits: !!m[4] })
    }
    this.defs.set(name, fields)
  }

  has(name: string): boolean { return this.defs.has(name) }

  /** Byte size, or null when unknown (missing nested schema or bit-fields). */
  size(name: string, depth = 0): number | null {
    const f = this.defs.get(name)
    if (!f || !f.length || depth > 16) return null
    let n = 0
    for (const x of f) {
      if (x.bits) return null
      const one = PRIM[x.type] ?? this.size(x.type, depth + 1)
      if (one == null) return null
      n += one * (x.count ?? 1)
    }
    return n
  }

  /** Flattened fields, e.g. { "translation.x": 1.2, "translation.y": 0.4, "rotation.value": 0.1 }. */
  decode(name: string, p: Uint8Array): Record<string, ScalarValue> | null {
    if (this.size(name) == null) return null
    const out: Record<string, ScalarValue> = {}
    this.read(name, view(p), 0, '', out, 0)
    return out
  }

  decodeArray(name: string, p: Uint8Array): Array<Record<string, ScalarValue>> | null {
    const n = this.size(name)
    if (!n) return null
    const out: Array<Record<string, ScalarValue>> = []
    for (let o = 0; o + n <= p.length; o += n) out.push(this.decode(name, p.subarray(o, o + n))!)
    return out
  }

  private read(name: string, dv: DataView, at: number, prefix: string, out: Record<string, ScalarValue>, depth: number): number {
    for (const f of this.defs.get(name) ?? []) {
      const key = prefix + f.name
      if (f.type === 'char' && f.count != null) {
        const bytes = new Uint8Array(dv.buffer, dv.byteOffset + at, Math.min(f.count, dv.byteLength - at))
        out[key] = utf8.decode(bytes).replace(/\0+$/, '')
        at += f.count
        continue
      }
      for (let i = 0; i < (f.count ?? 1); i++) {
        const k = f.count == null ? key : `${key}[${i}]`
        if (f.type in PRIM) {
          if (at + PRIM[f.type] <= dv.byteLength) out[k] = prim(dv, at, f.type)
          at += PRIM[f.type]
        } else {
          at = this.read(f.type, dv, at, `${k}.`, out, depth + 1)
        }
      }
    }
    return at
  }
}

function prim(dv: DataView, at: number, t: string): ScalarValue {
  switch (t) {
    case 'bool': return dv.getUint8(at) !== 0
    case 'char': return String.fromCharCode(dv.getUint8(at))
    case 'int8': return dv.getInt8(at)
    case 'uint8': return dv.getUint8(at)
    case 'int16': return dv.getInt16(at, true)
    case 'uint16': return dv.getUint16(at, true)
    case 'int32': return dv.getInt32(at, true)
    case 'uint32': return dv.getUint32(at, true)
    case 'int64': return Number(dv.getBigInt64(at, true))
    case 'uint64': return Number(dv.getBigUint64(at, true))
    case 'float': case 'float32': return dv.getFloat32(at, true)
    default: return dv.getFloat64(at, true)
  }
}

/** Name of the struct a "/.schema/struct:X" entry describes, or null. */
export function schemaEntryName(entryName: string): string | null {
  const m = entryName.match(/(?:^|\/)\.schema\/struct:(.+)$/)
  return m ? m[1] : null
}

// ---------------------------------------------------------------- writer (fixtures, tests, exports)

export class WpilogWriter {
  private chunks: Buffer[] = []
  private ids = new Map<string, { id: number; type: string }>()
  private next = 1

  constructor(extraHeader = '') {
    const extra = Buffer.from(extraHeader, 'utf8')
    const head = Buffer.alloc(12)
    head.write(MAGIC, 0, 'ascii')
    head.writeUInt16LE(0x0100, 6)
    head.writeUInt32LE(extra.length, 8)
    this.chunks.push(head, extra)
  }

  /** Starts an entry (once per name) and returns its id. */
  start(name: string, type: string, us: number, metadata = ''): number {
    const have = this.ids.get(name)
    if (have) return have.id
    const id = this.next++
    this.ids.set(name, { id, type })
    const parts = [Buffer.from([0]), u32(id), lstr(name), lstr(type), lstr(metadata)]
    this.record(0, us, Buffer.concat(parts))
    return id
  }

  finish(name: string, us: number): void {
    const e = this.ids.get(name)
    if (!e) return
    this.record(0, us, Buffer.concat([Buffer.from([1]), u32(e.id)]))
    this.ids.delete(name)
  }

  setMetadata(name: string, us: number, metadata: string): void {
    const e = this.ids.get(name)
    if (e) this.record(0, us, Buffer.concat([Buffer.from([2]), u32(e.id), lstr(metadata)]))
  }

  /** Appends a value, starting the entry on first use. */
  append(name: string, type: string, us: number, value: unknown): void {
    const id = this.start(name, type, us)
    this.record(id, us, encode(type, value))
  }

  double(name: string, us: number, v: number): void { this.append(name, 'double', us, v) }
  boolean(name: string, us: number, v: boolean): void { this.append(name, 'boolean', us, v) }
  int64(name: string, us: number, v: number): void { this.append(name, 'int64', us, v) }
  string(name: string, us: number, v: string): void { this.append(name, 'string', us, v) }

  toBuffer(): Buffer { return Buffer.concat(this.chunks) }

  private record(id: number, us: number, payload: Buffer): void {
    const idLen = bytesFor(id, 4)
    const sizeLen = bytesFor(payload.length, 4)
    const tsLen = bytesFor(us, 8)
    const head = Buffer.alloc(1 + idLen + sizeLen + tsLen)
    head[0] = (idLen - 1) | ((sizeLen - 1) << 2) | ((tsLen - 1) << 4)
    writeUint(head, 1, id, idLen)
    writeUint(head, 1 + idLen, payload.length, sizeLen)
    writeUint(head, 1 + idLen + sizeLen, us, tsLen)
    this.chunks.push(head, payload)
  }
}

function bytesFor(v: number, max: number): number {
  let n = 1
  while (n < max && v >= 2 ** (8 * n)) n++
  return n
}
function writeUint(b: Buffer, at: number, v: number, n: number): void {
  let x = Math.floor(v)
  for (let i = 0; i < n; i++) { b[at + i] = x % 256; x = Math.floor(x / 256) }
}
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const lstr = (s: string): Buffer => { const d = Buffer.from(s, 'utf8'); return Buffer.concat([u32(d.length), d]) }

function encode(type: string, v: unknown): Buffer {
  switch (type) {
    case 'double': { const b = Buffer.alloc(8); b.writeDoubleLE(Number(v)); return b }
    case 'float': { const b = Buffer.alloc(4); b.writeFloatLE(Number(v)); return b }
    case 'int64': { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.trunc(Number(v)))); return b }
    case 'boolean': return Buffer.from([v ? 1 : 0])
    case 'string': case 'json': case 'structschema': return Buffer.from(String(v), 'utf8')
    case 'double[]': { const a = v as number[]; const b = Buffer.alloc(8 * a.length); a.forEach((x, i) => b.writeDoubleLE(x, 8 * i)); return b }
    case 'int64[]': { const a = v as number[]; const b = Buffer.alloc(8 * a.length); a.forEach((x, i) => b.writeBigInt64LE(BigInt(Math.trunc(x)), 8 * i)); return b }
    case 'boolean[]': return Buffer.from((v as boolean[]).map((x) => (x ? 1 : 0)))
    case 'string[]': { const a = v as string[]; return Buffer.concat([u32(a.length), ...a.map(lstr)]) }
    default: return Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array)
  }
}
