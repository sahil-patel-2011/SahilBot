// A small QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1–20, with the
// standard mask choice. Enough for the Phone access pairing link (Settings → General → Phone access), with
// no dependency. Follows the structure of Project Nayuki's reference encoder (MIT).

const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26]
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16]
export const QR_MAX_VERSION = 20
/** Level M's format bits (L=1, M=0, Q=3, H=2). */
const ECL_M = 0

export interface QrCode {
  version: number
  size: number
  mask: number
  /** modules[y][x]: true = dark. */
  modules: boolean[][]
}

/** Raw data modules (data + error correction bits) of a version. */
export function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2
    r -= (25 * n - 10) * n - 55
    if (ver >= 7) r -= 36
  }
  return r
}

/** Data codewords a version holds at level M. */
export function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver]
}

// ------------------------------------------------------------------ Reed–Solomon over GF(256), x^8+x^4+x^3+x^2+1

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

export function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0)
  r[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root)
      if (j + 1 < r.length) r[j] ^= r[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return r
}

export function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ (r.shift() as number)
    r.push(0)
    for (let i = 0; i < divisor.length; i++) r[i] ^= gfMul(divisor[i], factor)
  }
  return r
}

// ------------------------------------------------------------------ the symbol

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const n = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2
  const out = [6]
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos)
  return out
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
]

class Symbol {
  readonly size: number
  readonly m: boolean[][]
  readonly fn: boolean[][]
  readonly ver: number
  constructor(ver: number) {
    this.ver = ver
    this.size = ver * 4 + 17
    this.m = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  set(x: number, y: number, dark: boolean): void { this.m[y][x] = dark; this.fn[y][x] = true }

  functionPatterns(): void {
    const s = this.size
    for (let i = 0; i < s; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0) }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy
        if (x < 0 || x >= s || y < 0 || y >= s) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        this.set(x, y, d !== 2 && d !== 4)
      }
    }
    const pos = alignmentPositions(this.ver)
    const n = pos.length
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
    this.formatBits(0)
    if (this.ver >= 7) {
      let rem = this.ver
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
      const bits = (this.ver << 12) | rem
      for (let i = 0; i < 18; i++) {
        const a = s - 11 + (i % 3), b = Math.floor(i / 3)
        this.set(a, b, bit(bits, i))
        this.set(b, a, bit(bits, i))
      }
    }
  }

  formatBits(mask: number): void {
    const data = (ECL_M << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const s = this.size
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(bits, i))
    this.set(8, s - 8, true)
  }

  codewords(data: number[]): void {
    const s = this.size
    let i = 0
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < s; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j
        const up = ((right + 1) & 2) === 0
        const y = up ? s - 1 - vert : vert
        if (!this.fn[y][x] && i < data.length * 8) { this.m[y][x] = bit(data[i >>> 3], 7 - (i & 7)); i++ }
      }
    }
  }

  applyMask(mask: number): void {
    const f = MASKS[mask]
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fn[y][x] && f(x, y)) this.m[y][x] = !this.m[y][x]
  }

  /** The standard penalty (lower scans better). */
  penalty(): number {
    const s = this.size
    const m = this.m
    let p = 0
    const line = (get: (i: number) => boolean): void => {
      let run = 1
      for (let i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) { run++; continue }
        if (run >= 5) p += 3 + (run - 5)
        run = 1
      }
      // Finder-like 1:1:3:1:1 with four light modules on one side.
      for (let i = 0; i + 10 < s; i++) {
        const w = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => get(i + k))
        const a = [true, false, true, true, true, false, true, false, false, false, false]
        if (w.every((v, k) => v === a[k]) || w.every((v, k) => v === a[10 - k])) p += 40
      }
    }
    for (let y = 0; y < s; y++) line((i) => m[y][i])
    for (let x = 0; x < s; x++) line((i) => m[i][x])
    for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) {
      const c = m[y][x]
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3
    }
    let dark = 0
    for (const row of m) for (const v of row) if (v) dark++
    const total = s * s
    p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return p
  }
}

/** The codewords for `bytes` at a version: mode, length, data, terminator, padding, then error correction interleaved. */
export function encodeCodewords(bytes: Uint8Array, ver: number): number[] {
  const cap = dataCodewords(ver)
  const bits: number[] = []
  const put = (v: number, n: number): void => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1) }
  put(0b0100, 4)
  put(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, cap * 8 - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad)

  const blocks = BLOCKS_M[ver]
  const eccLen = ECC_PER_BLOCK_M[ver]
  const raw = Math.floor(rawDataModules(ver) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const divisor = rsDivisor(eccLen)
  const all: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < shortBlocks) dat.push(0)
    all.push(dat.concat(ecc))
  }
  const out: number[] = []
  for (let i = 0; i < all[0].length; i++) for (let j = 0; j < all.length; j++) if (i !== shortLen - eccLen || j >= shortBlocks) out.push(all[j][i])
  return out
}

/** The smallest level-M QR code for `text` (UTF-8). Throws when it doesn't fit version 20. */
export function makeQr(text: string, forceMask?: number): QrCode {
  const bytes = new TextEncoder().encode(text)
  let ver = 1
  while (ver <= QR_MAX_VERSION && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++
  if (ver > QR_MAX_VERSION) throw new Error('Too long for a QR code.')
  const words = encodeCodewords(bytes, ver)
  let best: Symbol | null = null
  let bestScore = Infinity
  let bestMask = 0
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue
    const s = new Symbol(ver)
    s.functionPatterns()
    s.codewords(words)
    s.applyMask(mask)
    s.formatBits(mask)
    const score = s.penalty()
    if (score < bestScore) { best = s; bestScore = score; bestMask = mask }
  }
  return { version: ver, size: best!.size, mask: bestMask, modules: best!.m }
}

/** An SVG path (one unit per module, a 4-module quiet zone) and its viewBox size. */
export function qrPath(q: QrCode, quiet = 4): { d: string; size: number } {
  let d = ''
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.modules[y][x]) continue
      // Runs of dark modules in a row become one rectangle.
      let w = 1
      while (x + w < q.size && q.modules[y][x + w]) w++
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`
      x += w - 1
    }
  }
  return { d, size: q.size + quiet * 2 }
}
