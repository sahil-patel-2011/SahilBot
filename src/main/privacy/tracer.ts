import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import type { PrivacyInstallEvent, PrivacyLabel, PrivacySpan } from '@shared/privacy'

// PII-Tracer (perplexity-ai/PII-Tracer, MIT): a 0.6B bidirectional Qwen3 encoder that tags personal data
// in text, run fully on this Mac. Its GGUF backbone runs in llama.cpp's llama-server (one private
// process on 127.0.0.1, per-token hidden states from /embeddings with pooling off); SahilBot applies the
// two small heads and the constrained BIOES Viterbi decoder from Perplexity's reference client
// (example_client.py in perplexity-ai/PII-Tracer-GGUF) here in TypeScript.
//
// Trust: every file is pinned (llama.cpp release tag, Hugging Face commit) and must match its SHA-256
// before it's used. Nothing leaves the Mac when detecting.

/** llama.cpp's build for Apple Silicon, pinned with the SHA-256 GitHub publishes for it. */
export const LLAMA = {
  tag: 'b12596',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12596/llama-b12596-bin-macos-arm64.tar.gz',
  sha256: 'fb051ccc7fac9c0b2c2b1006848eaebc60aeed94cdc097ec8ff99cf35af6b066',
  size: 16_573_931
}
/** perplexity-ai/PII-Tracer-GGUF at a fixed commit; sizes and SHA-256 from the Hub's LFS metadata. */
const HF = 'https://huggingface.co/perplexity-ai/PII-Tracer-GGUF/resolve/79277a185c6d0a93ab29448e6981ebc722839c2c/'
export const MODEL_FILES = [
  { name: 'pplx-pii-masking-backbone-f16.gguf', size: 1_198_177_888, sha256: '343e6e67f1933b1fe55c9cc9c834224bb5ea573acd57b2042c741eab181fedbd' },
  { name: 'heads.safetensors', size: 156_136, sha256: '1b52889ee5ba59aac21958cf2e2b5dc7a87603063141f0f02e461bc9fab50f94' }
]
export const DOWNLOAD_BYTES = LLAMA.size + MODEL_FILES.reduce((n, f) => n + f.size, 0)

/** pii_head_config.json: the 37 BIOES labels over 9 types, in head order (Viterbi biases are 0). */
export const PII_TYPES: PrivacyLabel[] = ['private_person', 'private_email', 'private_phone', 'private_address', 'private_url', 'private_date', 'account_number', 'secret', 'other_pii']
export const LABELS: string[] = ['O', ...PII_TYPES.flatMap((t) => ['B', 'I', 'E', 'S'].map((p) => `${p}-${t}`))]
const MAX_TOKENS = 4096
/** Leave room for special tokens the server may add. */
const CHUNK_TOKENS = 4000

// ---------------------------------------------------------------- pure parts (unit-tested)

export interface Tensor { shape: number[]; data: Float32Array }

/** Reads a safetensors file's F32 / BF16 / F16 tensors. */
export function parseSafetensors(buf: Buffer): Record<string, Tensor> {
  const n = Number(buf.readBigUInt64LE(0))
  const header = JSON.parse(buf.subarray(8, 8 + n).toString('utf8')) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>
  const out: Record<string, Tensor> = {}
  const base = 8 + n
  for (const [name, t] of Object.entries(header)) {
    if (name === '__metadata__') continue
    const raw = buf.subarray(base + t.data_offsets[0], base + t.data_offsets[1])
    const count = t.shape.reduce((a, b) => a * b, 1)
    const data = new Float32Array(count)
    if (t.dtype === 'F32') for (let i = 0; i < count; i++) data[i] = raw.readFloatLE(i * 4)
    else if (t.dtype === 'BF16') { const v = new DataView(new ArrayBuffer(4)); for (let i = 0; i < count; i++) { v.setUint32(0, raw.readUInt16LE(i * 2) << 16); data[i] = v.getFloat32(0) } }
    else if (t.dtype === 'F16') for (let i = 0; i < count; i++) data[i] = f16(raw.readUInt16LE(i * 2))
    else throw new Error(`Unsupported tensor type ${t.dtype} in ${name}.`)
    out[name] = { shape: t.shape, data }
  }
  return out
}

function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

/** h @ W.T + b for each token: W is [out, hidden]. */
export function linear(h: ArrayLike<number>[], w: Tensor, b: Tensor): Float32Array[] {
  const [outDim, hidden] = w.shape
  return h.map((x) => {
    const y = new Float32Array(outDim)
    for (let o = 0; o < outDim; o++) {
      let acc = b.data[o]
      const row = o * hidden
      for (let i = 0; i < hidden; i++) acc += x[i] * w.data[row + i]
      y[o] = acc
    }
    return y
  })
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

/** The constrained BIOES transition matrix (allowed: 0 + biases, forbidden: -Infinity). */
export function transitions(labels: string[], bBias = 0, eBias = 0): Float64Array[] {
  const n = labels.length
  const id = new Map(labels.map((l, i) => [l, i]))
  const types = labels.filter((l) => l.startsWith('S-')).map((l) => l.slice(2))
  const allowed = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const ends = new Set([id.get('O')!]), begins = new Set([id.get('O')!])
  for (const t of types) {
    const b = id.get(`B-${t}`)!, i = id.get(`I-${t}`)!, e = id.get(`E-${t}`)!, s = id.get(`S-${t}`)!
    ends.add(e); ends.add(s); begins.add(b); begins.add(s)
    allowed[b][i] = allowed[b][e] = allowed[i][i] = allowed[i][e] = true
  }
  for (const f of ends) for (const t of begins) allowed[f][t] = true
  const out = allowed.map((row) => Float64Array.from(row, (a) => (a ? 0 : -Infinity)))
  for (const t of types) {
    const b = id.get(`B-${t}`)!, e = id.get(`E-${t}`)!
    for (let f = 0; f < n; f++) if (out[f][b] > -Infinity) out[f][b] += bBias
    for (let to = 0; to < n; to++) if (out[e][to] > -Infinity) out[e][to] += eBias
  }
  return out
}

/** Best label path under the BIOES constraints (example_client.py ViterbiDecoder.decode). */
export function viterbi(logits: ArrayLike<number>[], labels: string[], trans = transitions(labels)): number[] {
  const T = logits.length, C = labels.length
  if (!T) return []
  const startOk = labels.map((l) => l === 'O' || l.startsWith('B-') || l.startsWith('S-'))
  const endOk = labels.map((l) => l === 'O' || l.startsWith('E-') || l.startsWith('S-'))
  let prev = Float64Array.from({ length: C }, (_, c) => logits[0][c] + (startOk[c] ? 0 : -Infinity))
  const back: Int32Array[] = [new Int32Array(C)]
  for (let t = 1; t < T; t++) {
    const cur = new Float64Array(C), bp = new Int32Array(C)
    for (let c = 0; c < C; c++) {
      let best = -Infinity, arg = 0
      for (let p = 0; p < C; p++) { const v = prev[p] + trans[p][c]; if (v > best) { best = v; arg = p } }
      cur[c] = logits[t][c] + best
      bp[c] = arg
    }
    back.push(bp)
    prev = cur
  }
  let last = 0, best = -Infinity
  for (let c = 0; c < C; c++) { const v = prev[c] + (endOk[c] ? 0 : -Infinity); if (v > best) { best = v; last = c } }
  const path = [last]
  for (let t = T - 1; t > 0; t--) path.push(back[t][path[path.length - 1]])
  return path.reverse()
}

/** Label path → character spans, whitespace trimmed (example_client.py _path_to_spans + strip_span_whitespace). */
export function pathToSpans(path: number[], logits: ArrayLike<number>[], offsets: Array<[number, number]>, labels: string[], text: string): PrivacySpan[] {
  const spans: PrivacySpan[] = []
  let t = 0
  while (t < path.length) {
    const label = labels[path[t]]
    const [cs, ce] = offsets[t]
    if (label.startsWith('S-')) {
      if (cs < ce) spans.push({ start: cs, end: ce, label: label.slice(2) as PrivacyLabel, score: sigmoid(logits[t][path[t]]) })
      t++
    } else if (label.startsWith('B-')) {
      const type = label.slice(2)
      let end = ce
      const scores = [logits[t][path[t]]]
      t++
      while (t < path.length) {
        const inner = labels[path[t]]
        if (inner === `I-${type}` || inner === `E-${type}`) { end = offsets[t][1]; scores.push(logits[t][path[t]]); t++; if (inner.startsWith('E-')) break } else break
      }
      if (cs < end) spans.push({ start: cs, end, label: type as PrivacyLabel, score: sigmoid(scores.reduce((a, b) => a + b, 0) / scores.length) })
    } else t++
  }
  return spans.flatMap((s) => {
    let a = s.start, b = s.end
    while (a < b && /[ \t\n]/.test(text[a])) a++
    while (b > a && /[ \t\n]/.test(text[b - 1])) b--
    // A byte-level token can join a space and the next symbol (" 📞"): a trailing or leading piece past
    // whitespace with no letter or digit in it isn't part of the value.
    const tail = /\s+[^\p{L}\p{N}\s]+$/u.exec(text.slice(a, b))
    if (tail) b -= tail[0].length
    const head = /^[^\p{L}\p{N}\s]+\s+/u.exec(text.slice(a, b))
    if (head) a += head[0].length
    return a < b ? [{ ...s, start: a, end: b, text: text.slice(a, b) }] : []
  })
}

/** llama-server /tokenize pieces (text, or bytes for a partial UTF-8 character) → character offsets in `text`. */
export function pieceOffsets(text: string, pieces: Array<string | number[]>): Array<[number, number]> {
  // UTF-8 byte position → UTF-16 index (a character's later bytes map to its end).
  const bytes = Buffer.from(text, 'utf8')
  const at = new Int32Array(bytes.length + 1)
  let b = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!
    const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    for (let k = 0; k < len; k++) at[b + k] = i
    b += len
    if (cp >= 0x10000) i++
  }
  at[bytes.length] = text.length
  const charAt = (byte: number): number => (byte >= bytes.length ? text.length : at[byte])
  const out: Array<[number, number]> = []
  let pos = 0
  for (const p of pieces) {
    const len = typeof p === 'string' ? Buffer.byteLength(p, 'utf8') : p.length
    const start = charAt(pos)
    pos = Math.min(bytes.length, pos + len)
    // A token ending mid-character covers that whole character.
    let end = charAt(pos)
    if (pos < bytes.length && (bytes[pos] & 0xc0) === 0x80) end = Math.min(text.length, end + 1)
    out.push([start, Math.max(start, end)])
  }
  return out
}

/** Splits token offsets into chunks of at most `max` tokens, preferring to cut after whitespace. Returns [charStart, charEnd) pairs. */
export function chunkBounds(offsets: Array<[number, number]>, text: string, max = CHUNK_TOKENS): Array<[number, number]> {
  if (offsets.length <= max) return [[0, text.length]]
  const out: Array<[number, number]> = []
  let first = 0
  while (first < offsets.length) {
    let last = Math.min(offsets.length, first + max)
    if (last < offsets.length) {
      // Cut at the last token that ends a line or sentence within the final quarter, if any.
      for (let t = last - 1; t > first + max * 0.75; t--) if (/[\n.!?]\s*$/.test(text.slice(offsets[t][0], offsets[t][1]))) { last = t + 1; break }
    }
    out.push([offsets[first][0], last < offsets.length ? offsets[last][0] : text.length])
    first = last
  }
  return out
}

// ---------------------------------------------------------------- runtime

const sha256File = (path: string): Promise<string> => new Promise((ok, fail) => {
  const h = createHash('sha256')
  createReadStream(path).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', fail)
})

async function download(url: string, to: string, sha: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const part = `${to}.part`
  const res = await fetch(url, { redirect: 'follow', signal, headers: { 'User-Agent': 'SahilBot' } })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`)
  const out = createWriteStream(part)
  const hash = createHash('sha256')
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      onBytes(chunk.length)
    }
  } finally { await new Promise((r) => out.end(r)) }
  if (hash.digest('hex') !== sha) { rmSync(part, { force: true }); throw new Error('The download didn\'t match its expected checksum, so it wasn\'t used.') }
  renameSync(part, to)
}

const freePort = (): Promise<number> => new Promise((ok, fail) => {
  const s = createServer()
  s.once('error', fail)
  s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => ok(typeof a === 'object' && a ? a.port : 0)) })
})

function findFile(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isFile() && e.name === name) return p
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit }
  }
  return undefined
}

export interface Detection { spans: PrivacySpan[]; sensitivity: number }

/** PII-Tracer on this Mac: install, a private llama-server, and detect(). */
export class PiiTracer {
  private proc?: ChildProcess
  private port = 0
  private starting?: Promise<void>
  private heads?: { cls: Tensor; clsB: Tensor; sen: Tensor; senB: Tensor }
  private idle?: ReturnType<typeof setTimeout>
  private installing?: Promise<void>
  private trans = transitions(LABELS)
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private dir: string, private o: { idleMs?: number; serverBin?: string } = {}) {}

  private modelPath(name: string): string { return join(this.dir, 'model', name) }
  private serverBin(): string | undefined { return this.o.serverBin ?? findFile(join(this.dir, 'llama'), 'llama-server') }

  installed(): boolean {
    return !!this.serverBin() && MODEL_FILES.every((f) => { try { return statSync(this.modelPath(f.name)).size === f.size } catch { return false } })
  }

  installingNow(): boolean { return !!this.installing }

  /** Starts the server in the background (the first check then doesn't wait for the model to load). */
  warm(): void { this.halted = false; if (this.installed() && !this.installing) void this.ensure().catch(() => undefined) }

  /** Downloads llama-server and the model (about 1.2 GB), each checked against its pinned SHA-256. */
  install(emit: (e: PrivacyInstallEvent) => void, signal?: AbortSignal): Promise<void> {
    if (this.installing) return this.installing
    this.installing = (async () => {
      let done = 0
      let lastPct = -1
      const progress = (n: number): void => {
        done += n
        const pct = Math.floor((done / DOWNLOAD_BYTES) * 100)
        if (pct !== lastPct) { lastPct = pct; emit({ phase: 'download', pct }) }
      }
      try {
        mkdirSync(join(this.dir, 'model'), { recursive: true })
        if (!this.serverBin()) {
          const tar = join(this.dir, 'llama.tar.gz')
          await download(LLAMA.url, tar, LLAMA.sha256, progress, signal)
          const into = join(this.dir, 'llama')
          rmSync(into, { recursive: true, force: true })
          mkdirSync(into, { recursive: true })
          await new Promise<void>((ok, fail) => execFile('/usr/bin/tar', ['-xzf', tar, '-C', into], (e) => (e ? fail(e) : ok())))
          rmSync(tar, { force: true })
          if (!this.serverBin()) throw new Error('llama-server wasn\'t in the llama.cpp download.')
        } else progress(LLAMA.size)
        for (const f of MODEL_FILES) {
          const path = this.modelPath(f.name)
          if (existsSync(path) && statSync(path).size === f.size) { progress(f.size); continue }
          await download(HF + f.name, path, f.sha256, progress, signal)
        }
        emit({ phase: 'verify' })
        for (const f of MODEL_FILES) if (await sha256File(this.modelPath(f.name)) !== f.sha256) throw new Error(`${f.name} didn't match its checksum.`)
        emit({ phase: 'start' })
        await this.ensure()
        emit({ phase: 'done' })
      } catch (e) {
        emit({ phase: 'error', error: (e as Error).message })
        throw e
      } finally { this.installing = undefined }
    })()
    return this.installing
  }

  /** Deletes the download (and stops the server). */
  remove(): void {
    this.stop()
    rmSync(this.dir, { recursive: true, force: true })
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle)
    this.proc?.kill()
    this.proc = undefined
    this.starting = undefined
  }

  /** Switched off (or removed): stop, and don't come back by a retry until warmed again. */
  private halted = false
  halt(): void { this.halted = true; this.stop() }

  private loadHeads(): NonNullable<PiiTracer['heads']> {
    if (this.heads) return this.heads
    const t = parseSafetensors(readFileSync(this.modelPath('heads.safetensors')))
    const need = (k: string): Tensor => { if (!t[k]) throw new Error(`heads.safetensors has no ${k}.`); return t[k] }
    this.heads = { cls: need('token_cls_head.weight'), clsB: need('token_cls_head.bias'), sen: need('sensitivity_head.weight'), senB: need('sensitivity_head.bias') }
    if (this.heads.cls.shape[0] !== LABELS.length) throw new Error('PII-Tracer\'s head doesn\'t match the expected labels.')
    return this.heads
  }

  private ensure(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop(), this.o.idleMs ?? 30 * 60_000)
    this.idle.unref?.()
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return this.starting ?? Promise.resolve()
    const bin = this.serverBin()
    if (!bin || !this.installed()) return Promise.reject(new Error('PII-Tracer isn\'t downloaded yet.'))
    this.starting = (async () => {
      this.port = await freePort()
      const proc = spawn(bin, ['-m', this.modelPath(MODEL_FILES[0].name), '--host', '127.0.0.1', '--port', String(this.port),
        '--embeddings', '--pooling', 'none', '-c', String(MAX_TOKENS), '-b', String(MAX_TOKENS), '-ub', String(MAX_TOKENS), '--parallel', '1', '--no-webui', '--log-disable'],
      { cwd: join(bin, '..'), stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp' } })
      this.proc = proc
      proc.once('exit', () => { if (this.proc === proc) { this.proc = undefined; this.starting = undefined } })
      const until = Date.now() + 90_000
      for (;;) {
        if (proc.exitCode !== null) throw new Error('PII-Tracer\'s server stopped while starting.')
        try { if ((await fetch(`${this.url()}/health`, { signal: AbortSignal.timeout(1000) })).ok) return } catch { /* still loading */ }
        if (Date.now() > until) { proc.kill(); throw new Error('PII-Tracer didn\'t start within 90 seconds.') }
        await new Promise((r) => setTimeout(r, 300))
      }
    })()
    return this.starting
  }

  private url(): string { return `http://127.0.0.1:${this.port}` }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.url() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`PII-Tracer's server answered ${res.status}.`)
    return res.json() as Promise<T>
  }

  private async tokens(text: string, signal?: AbortSignal): Promise<Array<string | number[]>> {
    const r = await this.post<{ tokens: Array<{ piece: string | number[] } | number> }>('/tokenize', { content: text, add_special: false, with_pieces: true }, signal)
    return r.tokens.map((t) => (typeof t === 'number' ? '' : t.piece))
  }

  /** Per-token hidden states for one chunk, aligned to its own tokens (special tokens the server adds are dropped). */
  private async hidden(text: string, count: number, signal?: AbortSignal): Promise<number[][]> {
    const r = await this.post<Array<{ embedding: number[][] }> | { embedding: number[][] }>('/embeddings', { content: text }, signal)
    const rows = (Array.isArray(r) ? r[0] : r).embedding
    if (rows.length === count) return rows
    if (rows.length === count + 1) return rows.slice(1)
    if (rows.length === count + 2) return rows.slice(1, -1)
    throw new Error(`PII-Tracer's tokens didn't line up (${rows.length} vs ${count}).`)
  }

  /** Personal data in `text`: spans with their labels, and a 0–1 sensitivity for the whole text. */
  detect(text: string, signal?: AbortSignal): Promise<Detection> {
    // One request at a time: the server holds one 4096-token batch.
    const job = this.queue.then(() => this.detectNow(text, signal), () => this.detectNow(text, signal))
    this.queue = job.catch(() => undefined)
    return job
  }

  private async detectNow(text: string, signal?: AbortSignal): Promise<Detection> {
    const proc = this.proc
    try { return await this.detectOnce(text, signal) } catch (e) {
      // The server died on its own mid-check (a crash, the Mac woke from sleep): start it again and check once
      // more. Not after the gate was switched off, and not for a slow answer (the server is still running).
      const died = !!proc && (proc.exitCode !== null || proc.killed) && this.proc !== proc
      if (signal?.aborted || this.halted || !died || !/ECONNREFUSED|ECONNRESET|fetch failed|socket|stopped|terminated/i.test(String((e as Error)?.message ?? e))) throw e
      this.stop()
      return this.detectOnce(text, signal)
    }
  }

  private async detectOnce(text: string, signal?: AbortSignal): Promise<Detection> {
    if (!text.trim()) return { spans: [], sensitivity: 0 }
    await this.ensure()
    const heads = this.loadHeads()
    const all = pieceOffsets(text, await this.tokens(text, signal))
    const spans: PrivacySpan[] = []
    let sensitivity = 0
    for (const [from, to] of chunkBounds(all, text)) {
      const part = text.slice(from, to)
      const pieces = await this.tokens(part, signal)
      if (!pieces.length) continue
      const offsets = pieceOffsets(part, pieces)
      const h = await this.hidden(part, pieces.length, signal)
      const logits = linear(h, heads.cls, heads.clsB)
      const path = viterbi(logits, LABELS, this.trans)
      for (const s of pathToSpans(path, logits, offsets, LABELS, part)) spans.push({ ...s, start: s.start + from, end: s.end + from })
      const mean = new Float32Array(h[0].length)
      for (const row of h) for (let i = 0; i < mean.length; i++) mean[i] += row[i] / h.length
      sensitivity = Math.max(sensitivity, sigmoid(linear([mean], heads.sen, heads.senB)[0][0]))
    }
    return { spans, sensitivity }
  }
}
