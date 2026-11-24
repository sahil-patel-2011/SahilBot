import { afterEach, expect, test } from 'vitest'
import { idleGuarded, idleLimits } from '../../src/main/llm/idle-guard'
import { retryInfo, retryPolicy, withRetries } from '../../src/main/llm/retry'
import { failureKind } from '../../src/main/llm/model-health'
import { jxaForTest, jxaLimits } from '../../src/main/agent/tools/apps'
import type { ChatRequest, StreamPart } from '../../src/main/llm/client'

// A provider that accepts the request and then goes silent (report EHA-01: a stuck Grok sat ~20 minutes before
// another model answered): the idle guard ends the attempt, it is retried once, then the loop moves to another model.
const saved = { ...idleLimits }
const savedRetry = { ...retryPolicy }
afterEach(() => { Object.assign(idleLimits, saved); Object.assign(retryPolicy, savedRetry) })

const req = (signal?: AbortSignal): ChatRequest => ({ baseUrl: 'https://api.x.ai/v1', model: 'grok-x', messages: [], signal } as unknown as ChatRequest)

/** A stream that sends `first` parts, then nothing until its signal stops it. */
function silent(first: StreamPart[], opens: { n: number }) {
  return async function* (r: ChatRequest): AsyncGenerator<StreamPart> {
    opens.n++
    for (const p of first) yield p
    await new Promise<void>((_, reject) => r.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }))
  }
}

test('nothing at all: the attempt ends as a retryable network failure', async () => {
  idleLimits.cloudFirstMs = 120
  const opens = { n: 0 }
  const t0 = Date.now()
  const e = await (async () => { try { for await (const _ of idleGuarded(req(), silent([], opens), { local: false })) { /* none */ } } catch (err) { return err as Error } })()
  expect(Date.now() - t0).toBeLessThan(2000)
  expect(e?.message).toMatch(/grok-x stopped responding/)
  expect(retryInfo(e).retry).toBe(true)
  expect(failureKind(e)).toBe('network')
})

test('a gap mid-reply ends it too, and an idle stop is retried only once', async () => {
  idleLimits.cloudFirstMs = 1000
  idleLimits.cloudGapMs = 100
  retryPolicy.baseMs = 1
  const opens = { n: 0 }
  const parts: StreamPart[] = []
  const e = await (async () => {
    try { for await (const p of withRetries(() => idleGuarded(req(), silent([{ type: 'content', text: 'Hel' }], opens), { local: false }))) parts.push(p) } catch (err) { return err as Error }
  })()
  expect(e?.message).toMatch(/stopped responding/)
  expect(opens.n).toBe(2)
  expect(parts.filter((p) => p.type === 'reset')).toHaveLength(1)
})

test('the user\'s Stop is a stop, not an idle failure', async () => {
  idleLimits.cloudFirstMs = 5000
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 50)
  const e = await (async () => { try { for await (const _ of idleGuarded(req(ctrl.signal), silent([], { n: 0 }), { local: false })) { /* none */ } } catch (err) { return err as Error } })()
  expect(e?.name).toBe('AbortError')
})

test('a stream that keeps talking is left alone', async () => {
  idleLimits.cloudGapMs = 200
  async function* chatty(): AsyncGenerator<StreamPart> {
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 60)); yield { type: 'content', text: `${i}` } }
    yield { type: 'finish', reason: 'stop' }
  }
  const out: string[] = []
  for await (const p of idleGuarded(req(), chatty, { local: false })) if (p.type === 'content') out.push(p.text)
  expect(out.join('')).toBe('01234')
})

test('Apple Reminders behind macOS\'s permission dialog: the working line says so, and a timeout says what to click', async () => {
  jxaLimits.hintMs = 30
  jxaLimits.timeoutMs = 300
  const notes: string[] = []
  const exec = (_c: string, _a: string[], o: { timeout: number }): Promise<string> => new Promise((_, reject) => setTimeout(() => reject(new Error('Command failed: osascript -l JavaScript -e function run(argv) {...}')), o.timeout))
  const e = await jxaForTest(`(i) => { const R = Application('Reminders'); return 1 }`, {}, { progress: (t) => notes.push(t), exec }).catch((err: Error) => err)
  expect(notes[0]).toBe('macOS may be asking to let SahilBot use Reminders. Look for its dialog and click OK')
  expect((e as Error).message).toMatch(/^macOS is waiting for the user to allow SahilBot to control Reminders/)
  expect((e as Error).message).not.toMatch(/osascript/)
})
