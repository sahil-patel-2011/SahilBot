import { describe, expect, test } from 'vitest'
import { DigestRunner, buildDigest, digestDue, type DigestData, type DigestDeps } from '../../src/main/goals/digest'
import { Db } from '../../src/main/db'
import type { Goal, NeedsYouItem } from '../../src/shared/types'

const at = (s: string): number => Date.parse(s)

const goal = (p: Partial<Goal> = {}): Goal => ({
  id: 'g1', botId: 'b', threadId: null, title: 'Scouting database ready', doneWhen: 'all teams in', status: 'active', statusReason: null,
  milestones: [{ id: 'm1', title: 'Import', status: 'done' }, { id: 'm2', title: 'Clean', status: 'pending' }], journal: [], nextWakeAt: at('2026-11-16T09:00:00'),
  endAt: null, maxUsd: 2, maxRunsPerDay: 6, spentUsd: 0.4, wakes: 1, lastWakeAt: null, stall: 0, asks: [], createdAt: at('2026-11-10T09:00:00'), updatedAt: at('2026-11-15T12:00:00'), ...p
}) as Goal

const question: NeedsYouItem = { id: 'q1', source: 'queue', botId: 'b', botName: 'Scout', threadId: 't', kind: 'question', questions: [{ question: 'Which format for the report?', options: ['PDF', 'Word'] }], status: 'open', deadline: at('2026-11-15T20:00:00'), createdAt: at('2026-11-15T16:00:00') }
const approval: NeedsYouItem = { id: 'q2', source: 'queue', botId: 'b', botName: 'Scout', threadId: 't', kind: 'approval', approval: { tool: 'gmail__send_email', label: 'Gmail', summary: 'Send email to the team' }, hardStop: 'Sends to many people at once', status: 'open', deadline: null, createdAt: at('2026-11-15T16:00:00') }
const review: NeedsYouItem = { id: 'q3', source: 'queue', botId: 'b', botName: 'Scout', threadId: 't', kind: 'question', questions: [{ question: 'Weekly or monthly?' }], answers: ['Weekly'], answeredBy: 'default', review: true, status: 'defaulted', createdAt: at('2026-11-15T08:00:00'), answeredAt: at('2026-11-15T12:00:00') }

const data = (p: Partial<DigestData> = {}): DigestData => ({
  botName: 'Scout', since: at('2026-11-14T18:00:00'), now: at('2026-11-15T18:00:00'),
  did: [{ at: at('2026-11-15T10:00:00'), text: 'Imported **42** teams into the scouting sheet.' }],
  routines: [{ title: '⏰ Morning check', status: 'succeeded', at: at('2026-11-15T08:00:00') }, { title: 'Price watch', status: 'failed', at: at('2026-11-15T09:00:00'), reason: 'site was down' }],
  goals: [goal()], pending: [question, approval], review: [review],
  next: [{ title: 'Routine: Morning check', at: at('2026-11-16T08:00:00') }],
  spend: { botUsd: 0.31, monthUsd: 12.5, capUsd: 200, over: false }, ...p
})

describe('the daily digest', () => {
  test('says what the bot did, what is pending, what needs the user, and what it assumed', () => {
    const d = buildDigest(data())
    expect(d.empty).toBe(false)
    expect(d.title).toBe('Scout: daily digest')
    expect(d.text).toMatch(/\*\*What I did\*\*\n- Imported 42 teams into the scouting sheet\./)
    expect(d.text).toContain('Routine "⏰ Morning check" ran')
    expect(d.text).toMatch(/\*\*Problems\*\*\n- Routine "Price watch" failed: site was down/)
    expect(d.text).toMatch(/\*\*Needs you\*\* \(2\)/)
    expect(d.text).toContain('- Question: Which format for the report? (goes with the default')
    expect(d.text).toContain('- Needs your OK: Send email to the team (Sends to many people at once)')
    expect(d.text).toMatch(/\*\*For your review\*\*[^\n]*\n- "Weekly or monthly\?" → Weekly/)
    expect(d.text).toMatch(/\*\*Goals\*\*\n- Scouting database ready: 1\/2 milestones, next check-in .* · \$0\.40 of \$2\.00/)
    expect(d.text).toMatch(/\*\*Next up\*\*\n- Routine: Morning check/)
    expect(d.text).toContain('**Spending:** $0.31 by this bot since the last digest · $12.50 this month of $200.00.')
    expect(d.body).toBe('Did 2 things · 2 need you · 1 to review · 1 problem')
  })
  test('over the spending limit it says paid work is paused', () => {
    expect(buildDigest(data({ spend: { botUsd: 0, monthUsd: 200, capUsd: 200, over: true } })).text).toMatch(/monthly limit is used up .* paid work is paused/)
  })
  test('a quiet day with nothing waiting is empty (no digest goes out)', () => {
    expect(buildDigest(data({ did: [], routines: [], pending: [], review: [], goals: [goal({ updatedAt: at('2026-11-10T00:00:00') })] })).empty).toBe(true)
  })
  test('due once a day at its time; not replayed more than 12 hours late; off means off', () => {
    const cfg = { enabled: true, time: '18:00' }
    expect(digestDue(cfg, null, at('2026-11-15T17:59:00'))).toBe(false)
    expect(digestDue(cfg, null, at('2026-11-15T18:00:00'))).toBe(true)
    expect(digestDue(cfg, at('2026-11-15T18:00:30'), at('2026-11-15T19:00:00'))).toBe(false)
    expect(digestDue(cfg, at('2026-11-14T18:00:30'), at('2026-11-15T18:01:00'))).toBe(true)
    expect(digestDue(cfg, at('2026-11-14T18:00:30'), at('2026-11-16T07:00:00'))).toBe(false)
    expect(digestDue({ enabled: false, time: '18:00' }, null, at('2026-11-15T19:00:00'))).toBe(false)
  })
})

describe('the digest runner', () => {
  const setup = (now: { t: number }, busy = { on: false }) => {
    const db = new Db(':memory:')
    const bot = db.createSpace('Scout', '#123')
    const thread = db.createThread(bot.id, 'autonomous', null)
    const delivered: Array<{ bot: string; text: string; body: string }> = []
    const deps: DigestDeps = {
      db, bots: () => [db.getSpace(bot.id)!], config: () => ({ enabled: true, time: '18:00' }),
      goals: () => [], routines: () => [], runs: () => [], pending: () => [question], review: () => [],
      budget: () => ({ monthUsd: 1, capUsd: 200, over: false }), busy: () => busy.on,
      deliver: (b, d) => delivered.push({ bot: b.name, text: d.text, body: d.body }), now: () => now.t
    }
    return { db, bot, thread, delivered, runner: new DigestRunner(deps) }
  }

  test('collects the bot\'s finished replies since the last digest and delivers once a day', () => {
    const now = { t: at('2026-11-15T17:00:00') }
    const h = setup(now)
    h.db.insertMessage({ threadId: h.thread.id, role: 'assistant', content: 'Booked nothing; drafted the itinerary.\nMore detail…', kind: 'normal', status: 'done', createdAt: at('2026-11-15T11:00:00') })
    h.db.insertMessage({ threadId: h.thread.id, role: 'assistant', content: 'old news', kind: 'normal', status: 'done', createdAt: at('2026-11-13T11:00:00') })
    h.db.insertMessage({ threadId: h.thread.id, role: 'assistant', content: 'Routine notice', kind: 'notice', status: 'done', createdAt: at('2026-11-15T12:00:00') })
    expect(h.runner.tick()).toBe(0)
    now.t = at('2026-11-15T18:00:05')
    expect(h.runner.tick()).toBe(1)
    expect(h.delivered[0].text).toContain('- Booked nothing; drafted the itinerary.')
    expect(h.delivered[0].text).not.toContain('old news')
    expect(h.delivered[0].text).not.toContain('Routine notice')
    expect(h.delivered[0].body).toBe('Did 1 thing · 1 needs you')
    now.t = at('2026-11-15T21:00:00')
    expect(h.runner.tick()).toBe(0)
    now.t = at('2026-11-16T18:00:00')
    expect(h.runner.tick()).toBe(1)
    // The second digest only covers what came after the first.
    expect(h.delivered[1].text).not.toContain('drafted the itinerary')
  })

  test('a busy bot\'s digest waits for the next check (it never interrupts a run)', () => {
    const now = { t: at('2026-11-15T18:00:05') }
    const busy = { on: true }
    const h = setup(now, busy)
    expect(h.runner.tick()).toBe(0)
    busy.on = false
    now.t += 20_000
    expect(h.runner.tick()).toBe(1)
  })
})
