import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WireMessage } from './client'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Keep only the provider ID and a fingerprint of the last accepted input. SahilBot owns the transcript. */
export class SubscriptionThread {
  private path: string
  id?: string
  model?: string
  private cursor?: { length: number; body: string; system: string }

  constructor(dir: string, key: string) {
    const folder = join(dir, 'subscription-threads')
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    this.path = join(folder, digest(key) + '.json')
    try {
      const record = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof record.id === 'string') { this.id = record.id; this.cursor = record.cursor; this.model = record.model }
    } catch { /* First use, or recover from SahilBot's transcript. */ }
  }

  bind(id: string): void {
    if (id !== this.id) { this.cursor = undefined; this.model = undefined }
    this.id = id
    this.save()
  }

  private save(): void {
    const tmp = this.path + '.' + randomUUID()
    writeFileSync(tmp, JSON.stringify({ id: this.id, cursor: this.cursor, model: this.model }), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  advance(messages: WireMessage[], model?: string): void {
    this.model = model
    this.cursor = { length: messages.length, body: digest(messages.filter((m, i) => i || m.role !== 'system')), system: digest(messages[0]?.role === 'system' ? messages[0] : null) }
    this.save()
  }

  /**
   * The messages the provider thread hasn't seen yet, or undefined when SahilBot's record no longer
   * extends what the thread holds (compacted, edited or offloaded history). Callers must then start a
   * new provider thread from the full record: appending it to the old thread would hold the chat twice.
   * Messages from other models (a mid-chat model switch) are part of the delta, so every provider
   * sees the whole conversation.
   */
  delta(messages: WireMessage[]): WireMessage[] | undefined {
    const c = this.cursor
    if (!c || c.length >= messages.length || digest(messages.slice(0, c.length).filter((m, i) => i || m.role !== 'system')) !== c.body) return undefined
    const next = messages.slice(c.length)
    // The provider's own answer to the last request is already in its thread (advance() runs only after
    // it answered, so the message right after the cursor is that answer). Tool-call steps stay: their
    // call IDs are SahilBot's, and the results that follow refer to them.
    if (next[0]?.role === 'assistant' && !next[0].tool_calls?.length && next.length > 1) next.shift()
    if (messages[0]?.role === 'system' && digest(messages[0]) !== c.system) next.unshift(messages[0])
    return next
  }

  /** Whether the provider thread can be resumed with only the new messages. */
  continues(messages: WireMessage[]): boolean { return !!this.id && this.delta(messages) !== undefined }
}

export const missingSubscriptionThread = (error: unknown): boolean =>
  /(?:session|thread|rollout).*(?:not found|does not exist|unknown)|(?:unknown|no rollout found for) (?:session|thread)/i.test(String(error))
