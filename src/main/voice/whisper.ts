import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { toWav } from './audio'

// whisper.cpp's whisper-server kept warm (Metal); transcription is one local HTTP call.

async function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => ok(p))
    })
    s.on('error', bad)
  })
}

export class WhisperServer {
  private proc: ChildProcess | null = null
  private port = 0
  private ready: Promise<void> | null = null

  constructor(private bin: string, private model: string, private threads = 6) {}

  start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      this.port = await freePort()
      this.proc = spawn(this.bin, ['-m', this.model, '--host', '127.0.0.1', '--port', String(this.port), '-t', String(this.threads), '--no-timestamps'], { stdio: 'ignore' })
      this.proc.on('exit', () => { this.proc = null; this.ready = null })
      const deadline = Date.now() + 60_000
      for (;;) {
        try {
          const r = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(500) })
          if (r.ok || r.status === 404) break
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error('whisper-server did not start')
        await new Promise((r) => setTimeout(r, 150))
      }
      // Warm the Metal kernels so the first real request is fast.
      await this.transcribe(new Float32Array(16000)).catch(() => '')
    })()
    return this.ready
  }

  async transcribe(samples: Float32Array, prompt?: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(toWav(samples))], { type: 'audio/wav' }), 'a.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    if (prompt) form.append('prompt', prompt)
    const r = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form })
    if (!r.ok) throw new Error(`whisper-server ${r.status}`)
    const j = (await r.json()) as { text?: string }
    return (j.text ?? '').replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
  }
}
