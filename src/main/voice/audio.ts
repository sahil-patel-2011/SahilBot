// Small PCM helpers shared by the voice pipeline (16 kHz mono float32 in, WAV out).

export const SAMPLE_RATE = 16000
export const FRAME = 512 // Silero VAD frame at 16 kHz (32 ms)

export function toWav(samples: Float32Array, rate = SAMPLE_RATE): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2)
  return buf
}

/** Reads a 16-bit PCM mono WAV (used by tests and file dictation). */
export function fromWav(buf: Buffer): { samples: Float32Array; rate: number } {
  let off = 12
  let rate = SAMPLE_RATE
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12)
    if (id === 'data') {
      // Streamed WAVs (OpenAI's voice) may say 0xFFFFFFFF here: read what's actually there.
      const n = Math.floor(Math.min(size, buf.length - off - 8) / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
      return { samples: out, rate }
    }
    off += 8 + size
  }
  throw new Error('No data chunk in WAV')
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/**
 * Splits streamed text into speakable sentences as soon as each one ends, so speech can
 * start on the first finished sentence. Strips Markdown that sounds bad read aloud.
 */
export class SentenceSplitter {
  private buf = ''
  private first = true

  push(text: string): string[] {
    this.buf += text
    const out: string[] = []
    for (;;) {
      // A sentence ends at . ! ? followed by whitespace (so "3.5" or a URL mid-stream doesn't split).
      let m = /[.!?…]["')\]]*\s/.exec(this.buf)
      while (m && /\b(e\.g|i\.e|Mr|Mrs|Ms|Dr|vs|etc|St|No)\.$/i.test(this.buf.slice(0, m.index + 1))) {
        const next = /[.!?…]["')\]]*\s/.exec(this.buf.slice(m.index + 1))
        m = next ? Object.assign(next, { index: next.index + m.index + 1 }) : null
      }
      // The very first chunk may break at a comma so speech starts sooner.
      if (!m && this.first) {
        const c = /[,;:]\s/.exec(this.buf)
        if (c && this.buf.slice(0, c.index).split(/\s+/).length >= 6) m = c
      }
      if (!m) break
      const end = m.index + m[0].length
      const s = clean(this.buf.slice(0, end))
      this.buf = this.buf.slice(end)
      if (s.length >= 2) { out.push(s); this.first = false }
    }
    return out
  }

  flush(): string[] {
    const s = clean(this.buf)
    this.buf = ''
    return s.length >= 1 ? [s] : []
  }
}

export function clean(s: string): string {
  return s.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, 'the link').replace(/[*_#`>|~]+/g, '').replace(/\[(\d+)\]/g, '').replace(/\s+/g, ' ').trim()
}
