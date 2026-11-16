import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  DECISION_HEADER, approvalKind, decisionFromAnswer, decisionFromPick, decisionText, decisionsFromCorrection, inlineOptions, parseDecision, sameTopic, saveDecision
} from '../../src/main/decisions'
import { DecisionRecorder } from '../../src/main/learning/decisions'
import { Db } from '../../src/main/db'
import { MemoryStore, renderBlock, type Memory } from '../../src/main/memory'
import { contextBlock, contextSections, memoryGuidance } from '../../src/main/agent/prompt'

// The user's decisions as memories (kind 'decision'): captured without a model call from their own answers,
// picks, corrections and approval clicks; one per topic (newer wins); never from outside content, never a
// secret, and an approval pattern is only ever a memory (never a rule or a permission).

describe('answers to clarifying questions', () => {
  test('a choice that generalizes becomes "context → choice"', () => {
    const d = decisionFromAnswer({ question: 'Which format for the weekly report?', options: ['PDF (recommended)', 'Word'] }, 'PDF')!
    expect(decisionText(d)).toBe('Which format for the weekly report? → PDF (over Word)')
    expect(decisionText(decisionFromAnswer({ question: 'Formal or casual?' }, 'casual')!)).toBe('Formal or casual? → casual (over Formal)')
    expect(decisionText(decisionFromAnswer({ question: 'Use Stripe or Paddle?' }, 'Stripe')!)).toBe('Use Stripe or Paddle? → Stripe (over Paddle)')
    // A vendor choice that mentions payments is still a choice (not a "yes" to paying).
    expect(decisionFromAnswer({ question: 'Which payment provider should I use?', options: ['Stripe', 'Paddle'] }, 'Stripe')?.choice).toBe('Stripe')
    // Their own short answer to a question with options, and to a taste question.
    expect(decisionFromAnswer({ question: 'Which format for the weekly report?', options: ['PDF', 'Word'] }, 'Markdown')?.choice).toBe('Markdown')
    expect(decisionFromAnswer({ question: 'Which tone do you prefer for client emails?' }, 'Friendly')?.choice).toBe('Friendly')
  })

  test('either/or questions give their options', () => {
    expect(inlineOptions('Use Stripe or Paddle?')).toEqual(['Stripe', 'Paddle'])
    expect(inlineOptions('Stripe or Paddle for payments?')).toEqual(['Stripe', 'Paddle'])
    expect(inlineOptions('Should I use PDF, Word, or Markdown for the report?')).toEqual(['PDF', 'Word', 'Markdown'])
    expect(inlineOptions('Do you want me to send it now or later?')).toEqual([])
    expect(inlineOptions('What should I call it?')).toEqual([])
  })

  test('one-off questions, risky yeses, non-answers and orders are not decisions', () => {
    expect(decisionFromAnswer({ question: 'Is this the right file?', options: ['Yes', 'No'] }, 'Yes')).toBeNull()
    expect(decisionFromAnswer({ question: 'Which file should I attach?', options: ['a.pdf', 'b.pdf'] }, 'a.pdf')).toBeNull()
    expect(decisionFromAnswer({ question: 'Should I pay the invoice now?', preference: true }, 'yes')).toBeNull()
    expect(decisionFromAnswer({ question: 'When should I send it?', options: ['Now', 'Tomorrow at 9am'] }, 'Tomorrow at 9am')).toBeNull()
    expect(decisionFromAnswer({ question: 'Did the build pass?' }, 'No')).toBeNull()
    expect(decisionFromAnswer({ question: 'Which format?', options: ['PDF', 'Word'] }, 'you decide')).toBeNull()
    expect(decisionFromAnswer({ question: 'Which format?', options: ['PDF', 'Word'] }, '(no answer: use your best judgment and say what you assumed)')).toBeNull()
    expect(decisionFromAnswer({ question: 'What should I do with the draft?', preference: true }, 'send it to the whole team')).toBeNull()
    expect(decisionFromAnswer({ question: 'Which address do you prefer for invoices?' }, 'billing@acme.example')).toBeNull()
  })

  test('nothing from a run that read outside content, and never a secret', () => {
    expect(decisionFromAnswer({ question: 'Which format?', options: ['PDF', 'Word'] }, 'PDF', { tainted: true })).toBeNull()
    expect(decisionFromAnswer({ question: 'Which API key should I use?', options: ['Work', 'Personal'] }, 'Work')).toBeNull()
    expect(decisionFromAnswer({ question: 'Which login do you prefer?' }, 'my password is hunter22')).toBeNull()
  })
})

describe('picks among options the agent offered', () => {
  test('by number, letter, ordinal or name', () => {
    const names = 'Here are three names for your app:\n1. Zephyr\n2. Nimbus\n3. Stratus\n\nWhich do you like?'
    expect(decisionText(decisionFromPick(names, '2')!)).toBe('Names for your app → Nimbus (over Zephyr, Stratus)')
    expect(decisionFromPick(names, 'the last one')?.choice).toBe('Stratus')
    expect(decisionFromPick(names, 'Nimbus!')?.choice).toBe('Nimbus')
    const plan = 'Two ways to fix it:\n\n**Option A — Quick patch**: add a null check.\n\n**Option B — Rewrite the auth flow**: cleaner.\n\nWhich would you prefer?'
    expect(decisionFromPick(plan, "let's go with option B")).toMatchObject({ choice: 'Rewrite the auth flow', over: ['Quick patch'], source: 'pick' })
    expect(decisionFromPick('I can do:\n- **Postgres** — battle tested\n- **SQLite** — simple\n\nWhich one?', 'sqlite please')).toMatchObject({ context: 'Choosing between Postgres, SQLite', choice: 'SQLite' })
    expect(decisionFromPick('Should I use Stripe or Paddle?', 'Paddle')).toMatchObject({ context: 'Should I use Stripe or Paddle?', choice: 'Paddle' })
  })

  test('not a pick: no choice was asked for, "neither", or a long message that mentions one', () => {
    expect(decisionFromPick('I did:\n1. Cleaned the data\n2. Built the chart\n\nAll done.', '2')).toBeNull()
    expect(decisionFromPick('Names:\n1. Zephyr\n2. Nimbus\n\nWhich do you like?', 'neither, try again')).toBeNull()
    expect(decisionFromPick('Names:\n1. Zephyr\n2. Nimbus\n\nWhich do you like?', 'I was thinking about how Nimbus sounds in a pitch to investors and to my cofounder over lunch tomorrow')).toBeNull()
  })
})

describe('corrections', () => {
  test('a named preference over an alternative, standing instructions, and draft feedback', () => {
    expect(decisionsFromCorrection('no, use Postgres instead of MySQL').map(decisionText)).toEqual(['Postgres or MySQL → Postgres (over MySQL)'])
    expect(decisionsFromCorrection('Postgres, not MySQL').map(decisionText)).toEqual(['Postgres or MySQL → Postgres (over MySQL)'])
    expect(decisionsFromCorrection('never use em dashes in my emails').map(decisionText)).toEqual(['Never use em dashes in my emails.'])
    expect(decisionsFromCorrection('too long', { afterReply: true }).map(decisionText)).toEqual(['Length of drafts and replies → shorter and more concise'])
    expect(decisionsFromCorrection('make it more casual', { afterReply: true }).map(decisionText)).toEqual(['Tone of drafts and replies → more casual and friendly'])
    expect(decisionsFromCorrection('too casual, more professional please', { afterReply: true }).map(decisionText)).toEqual(['Tone of drafts and replies → more formal and professional'])
    // Draft feedback only counts right after a reply.
    expect(decisionsFromCorrection('too long')).toEqual([])
  })

  test('permission grants, addresses, secrets and pasted text never become decisions', () => {
    expect(decisionsFromCorrection('don\'t ask before sending emails')).toEqual([])
    expect(decisionsFromCorrection('always cc my assistant without asking')).toEqual([])
    expect(decisionsFromCorrection('from now on, send invoices to bob@acme.example')).toEqual([])
    expect(decisionsFromCorrection('from now on my password is hunter22')).toEqual([])
    expect(decisionsFromCorrection(`Always reply within a day.\n${'Pasted line from an email.\n'.repeat(5)}`)).toEqual([])
  })
})

describe('approval kinds', () => {
  test('the kind of action in words, by app and by folder', () => {
    expect(approvalKind('mail', { action: 'send', to: 'a@b.example' })).toMatchObject({ key: 'email.send', context: 'When the agent wants to send an email', risky: false })
    expect(approvalKind('gmail__send_email')?.key).toBe('email.send')
    expect(approvalKind('file_write', { path: '~/Documents/notes/a.md' })).toMatchObject({ key: 'file.write:~/Documents', context: 'When the agent wants to save files in ~/Documents' })
    expect(approvalKind('file_write', { path: '/Users/sam/Desktop/a.md' })?.key).toBe('file.write:~/Desktop')
    expect(approvalKind('run_command', { command: 'git push origin main' })?.key).toBe('command:git')
    expect(approvalKind('browser', { action: 'checkout' }, { summary: 'Buy now on Amazon' })?.risky).toBe(true)
  })
})

describe('topics and supersede', () => {
  test('the same question in other words, or the same options, is the same topic', () => {
    const a = parseDecision('Use Stripe or Paddle? → Stripe (over Paddle)')!
    expect(a).toMatchObject({ context: 'Use Stripe or Paddle?', choice: 'Stripe', over: ['Paddle'] })
    expect(sameTopic(a, { context: 'Which payment provider?', choice: 'Paddle', over: ['Stripe'] })).toBe(true)
    expect(sameTopic({ context: 'Which format for the weekly report?', choice: 'PDF' }, { context: 'Which FORMAT for the weekly reports', choice: 'Word' })).toBe(true)
    expect(sameTopic({ context: 'Which format for the weekly report?', choice: 'PDF' }, { context: 'Tone of drafts and replies', choice: 'casual' })).toBe(false)
  })

  test('a newer decision on the same topic replaces the older one in place (history kept short)', () => {
    const memory = new MemoryStore(new Db(':memory:'))
    const first = saveDecision(memory, decisionFromAnswer({ question: 'Use Stripe or Paddle?' }, 'Paddle')!, null)!
    const again = saveDecision(memory, decisionFromAnswer({ question: 'Which payment provider?', options: ['Stripe', 'Paddle'] }, 'Stripe')!, null)!
    expect(again.memory.id).toBe(first.memory.id)
    expect(again.superseded).toBe('Use Stripe or Paddle? → Paddle (over Stripe)')
    expect(memory.list().filter((m) => m.category === 'decision').map((m) => m.content)).toEqual(['Which payment provider? → Stripe (over Paddle) (earlier: Paddle)'])
    // Changing back keeps one earlier choice, not a growing history.
    saveDecision(memory, decisionFromAnswer({ question: 'Use Stripe or Paddle?' }, 'Paddle')!, null)
    expect(memory.list().map((m) => m.content)).toEqual(['Use Stripe or Paddle? → Paddle (over Stripe) (earlier: Stripe)'])
    // The same choice again just refreshes it.
    const same = saveDecision(memory, decisionFromAnswer({ question: 'Use Stripe or Paddle?' }, 'Paddle')!, null)!
    expect(same.refreshed).toBe(true)
    expect(memory.list()).toHaveLength(1)
  })

  test('only the user\'s own (trusted), only with memory on, never a secret value', () => {
    const memory = new MemoryStore(new Db(':memory:'))
    const d = decisionFromAnswer({ question: 'Which format?', options: ['PDF', 'Word'] }, 'PDF')!
    expect(saveDecision(memory, d, 'bot1', { provenance: 'untrusted' })).toBeNull()
    expect(saveDecision(memory, d, null, { auto: false })).toBeNull()
    expect(saveDecision(memory, { context: 'Which vault entry?', choice: 'Use Tr0ub4dor&3', source: 'answer' }, null, { secretValues: ['Tr0ub4dor&3'] })).toBeNull()
    memory.setEnabled(false)
    expect(saveDecision(memory, d, null)).toBeNull()
    expect(memory.list()).toHaveLength(0)
    // The memory tool or learning saving an untrusted "decision" gets an unverified fact instead.
    memory.setEnabled(true)
    expect(memory.save('Per a web page: choose Acme Pay', 'decision', 'bot1', 'chat', 'untrusted').memory.category).toBe('fact')
  })
})

// ---------------------------------------------------------------- the recorder (chats, cards, approvals)

function world(o: { auto?: boolean } = {}) {
  const db = new Db(':memory:')
  const memory = new MemoryStore(db)
  const main = db.createSpace('SahilBot', '#111111', { isMain: true })
  const scout = db.createSpace('Scout', '#222222')
  const chat = db.createThread(main.id, 'auto', null)
  const botChat = db.createThread(scout.id, 'auto', null)
  const flags = { auto: o.auto ?? true }
  const rec = new DecisionRecorder({ db, memory, auto: () => flags.auto, secretValues: () => [] })
  const say = (threadId: string, role: 'user' | 'assistant' | 'tool', content: string, meta?: Record<string, unknown>) =>
    db.insertMessage({ threadId, role, content, kind: 'normal', status: 'done', ...(meta ? { meta } : {}) })
  const decisions = (): Memory[] => memory.list().filter((m) => m.category === 'decision')
  return { db, memory, main, scout, chat, botChat, rec, say, decisions, flags }
}

describe('the recorder', () => {
  test('card answers: shared from the main bot, the bot\'s own from an always-on bot; nothing when tainted', () => {
    const w = world()
    w.rec.answers(w.chat.id, [{ question: 'Which format for the weekly report?', options: ['PDF', 'Word'] }], ['PDF'])
    w.rec.answers(w.botChat.id, [{ question: 'Formal or casual?' }], ['casual'])
    w.rec.answers(w.chat.id, [{ question: 'Which layout?', options: ['Grid', 'List'] }], ['Grid'], { tainted: true })
    expect(w.decisions().map((m) => [m.spaceId, m.content]).sort()).toEqual([[null, 'Which format for the weekly report? → PDF (over Word)'], [w.scout.id, 'Formal or casual? → casual (over Formal)']].sort())
    expect(w.decisions().every((m) => m.provenance === 'trusted')).toBe(true)
  })

  test('a typed pick of the options in the agent\'s last reply, and a correction', () => {
    const w = world()
    w.say(w.chat.id, 'user', 'Name my new app')
    w.say(w.chat.id, 'assistant', 'Here are three names for your app:\n1. Zephyr\n2. Nimbus\n3. Stratus\n\nWhich do you like?')
    const pick = w.say(w.chat.id, 'user', 'Nimbus')
    w.rec.userMessage(w.chat.id, pick.id)
    w.say(w.chat.id, 'assistant', 'Here is the launch email draft: ... (a few paragraphs)')
    const fix = w.say(w.chat.id, 'user', 'too long, and use Postgres instead of MySQL')
    w.rec.userMessage(w.chat.id, fix.id)
    expect(w.decisions().map((m) => m.content).sort()).toEqual([
      'Length of drafts and replies → shorter and more concise',
      'Names for your app → Nimbus (over Zephyr, Stratus)',
      'Postgres or MySQL → Postgres (over MySQL)'
    ])
  })

  test('options the agent took from a web page, and messages from apps or other bots, are never the user\'s decisions', () => {
    const w = world()
    w.say(w.chat.id, 'user', 'Find me a hosting plan')
    w.say(w.chat.id, 'tool', 'Plans: Basic, Pro, Ultra (from acme.example)', { untrusted: true })
    w.say(w.chat.id, 'assistant', 'From their pricing page:\n1. Basic\n2. Pro\n3. Ultra\n\nWhich one?')
    w.rec.userMessage(w.chat.id, w.say(w.chat.id, 'user', '2').id)
    expect(w.decisions()).toHaveLength(0)
    const other = w.db.createThread(w.main.id, 'auto', null)
    const relayed = w.say(other.id, 'user', 'never use em dashes', { handoff: { from: 'Scout' } })
    w.rec.userMessage(other.id, relayed.id)
    const app = w.say(other.id, 'user', 'from now on always reply in French', { fromApp: 'Claude' })
    w.rec.userMessage(other.id, app.id)
    expect(w.decisions()).toHaveLength(0)
  })

  test('respects the memory switch and "Remember things automatically"', () => {
    const w = world({ auto: false })
    w.rec.answers(w.chat.id, [{ question: 'Formal or casual?' }], ['casual'])
    w.flags.auto = true
    w.memory.setEnabled(false)
    w.rec.answers(w.chat.id, [{ question: 'Formal or casual?' }], ['casual'])
    for (let i = 0; i < 3; i++) w.rec.approval(w.chat.id, { tool: 'mail', args: { action: 'send' }, answer: 'deny' })
    expect(w.memory.list()).toHaveLength(0)
  })

  test('approval patterns: a streak becomes one shared preference, a change of heart supersedes it', () => {
    const w = world()
    const deny = (): unknown => w.rec.approval(w.chat.id, { tool: 'mail', label: 'Mail', args: { action: 'send', to: 'sam@x.example' }, answer: 'deny' })
    deny(); deny()
    expect(w.decisions()).toHaveLength(0)
    deny()
    expect(w.decisions().map((m) => [m.spaceId, m.content])).toEqual([[null, 'When the agent wants to send an email → usually declines; wants to review emails before they\'re sent (declined 3 times in a row)']])
    for (let i = 0; i < 3; i++) w.rec.approval(w.chat.id, { tool: 'mail', args: { action: 'send' }, answer: 'once' })
    const flipped = w.decisions()
    expect(flipped).toHaveLength(1)
    expect(flipped[0].content).toMatch(/^When the agent wants to send an email → usually approves \(approved 3 times in a row\) \(earlier: usually declines; wants to review/)
    // Saving files in a folder, by folder.
    for (let i = 0; i < 3; i++) w.rec.approval(w.botChat.id, { tool: 'file_write', args: { path: '~/Documents/notes/n.md' }, answer: 'always' })
    expect(w.decisions().some((m) => m.content.startsWith('When the agent wants to save files in ~/Documents → usually approves') && m.spaceId === null)).toBe(true)
  })

  test('approval patterns are never rules or permissions; money approvals and tainted runs aren\'t counted', () => {
    const w = world()
    for (let i = 0; i < 5; i++) w.rec.approval(w.chat.id, { tool: 'browser', args: { action: 'checkout' }, summary: 'Buy now: 1 item, $40', answer: 'once' })
    for (let i = 0; i < 5; i++) w.rec.approval(w.chat.id, { tool: 'mail', args: { action: 'send' }, answer: 'deny', tainted: true })
    expect(w.decisions()).toHaveLength(0)
    // Declining purchases is remembered (a preference to be careful), approving them never is.
    for (let i = 0; i < 3; i++) w.rec.approval(w.chat.id, { tool: 'browser', args: { action: 'checkout' }, summary: 'Buy now: 1 item, $40', answer: 'deny' })
    expect(w.decisions().map((m) => m.content)).toEqual(['When the agent wants to use browser (checkout) → usually declines; wants to review this kind of action first (declined 3 times in a row)'])
    expect(w.memory.list().some((m) => m.category === 'rule')).toBe(false)
    // The permission engine never reads memories or decisions.
    const perms = readFileSync(join(__dirname, '../../src/main/agent/permissions.ts'), 'utf8')
    expect(perms).not.toMatch(/from '\.\.\/(memory|decisions|learning\/decisions)'/)
    expect(perms).not.toMatch(/\bdecisions?\.ts\b|MemoryStore/)
  })

  test('deleting an approval pattern starts its count over', () => {
    const w = world()
    for (let i = 0; i < 3; i++) w.rec.approval(w.chat.id, { tool: 'mail', args: { action: 'send' }, answer: 'deny' })
    const [m] = w.decisions()
    w.memory.remove(m.id)
    w.rec.approval(w.chat.id, { tool: 'mail', args: { action: 'send' }, answer: 'deny' })
    expect(w.decisions()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- recall

const mem = (id: string, content: string, at: number, category: Memory['category'] = 'decision', spaceId: string | null = null): Memory =>
  ({ id, category, content, spaceId, projectId: spaceId, source: 'chat', provenance: 'trusted', createdAt: at, updatedAt: at })

describe('recall', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  const all = [
    mem('d1', 'Use Stripe or Paddle? → Stripe (over Paddle)', now - 30 * 86_400_000),
    mem('d2', 'Which format for the weekly report? → PDF (over Word)', now - 20 * 86_400_000),
    mem('d3', 'Tone of drafts and replies → more casual and friendly', now - 86_400_000),
    mem('d4', 'Length of drafts and replies → shorter and more concise', now - 2 * 86_400_000),
    mem('p1', 'Prefers metric units.', now, 'preference'),
    ...Array.from({ length: 10 }, (_, i) => mem(`x${i}`, `Old choice number ${i} → option ${i}`, now - (60 + i) * 86_400_000))
  ]

  test('relevant past decisions first, under their own header, capped', () => {
    const block = renderBlock(all, { query: 'set up payments with stripe for the shop', now })
    const lines = block.split('\n')
    const h = lines.indexOf(DECISION_HEADER)
    expect(h).toBeGreaterThan(-1)
    const decided = lines.slice(h + 1).filter((l) => l.startsWith('- ['))
    const header = lines.slice(h + 1, h + 1 + decided.length)
    expect(header[0]).toBe('- [d1] (2026-10-17) Use Stripe or Paddle? → Stripe (over Paddle)')
    // The latest couple come along; never more than six.
    expect(header.some((l) => l.includes('[d3]'))).toBe(true)
    expect(lines.filter((l) => /^- \[(d|x)\d+\]/.test(l)).length).toBeLessThanOrEqual(6)
    expect(lines).toContain('- [p1] (pref) Prefers metric units.')
    expect(block).toMatch(/more saved; memory\(action="search"\) finds them/)
  })

  test('the header reaches the run\'s <context> block, and the guidance says to act as the user would', () => {
    const block = renderBlock(all.slice(0, 3), { query: 'which format should the weekly report be', now })
    const ctx = contextBlock(contextSections({ date: new Date(now), memories: block }), new Set())
    expect(ctx).toContain(DECISION_HEADER)
    expect(ctx).toContain('Which format for the weekly report? → PDF (over Word)')
    // (The compact prompt for tiny windows has no room to spare: the header itself says to follow them.)
    for (const form of ['full', 'chat'] as const) expect(memoryGuidance(form)).toMatch(/Past decisions by the user/)
    expect(memoryGuidance('full')).toMatch(/follow it without asking again/)
  })

  test('the memory block\'s decision share stays small on a tiny budget', () => {
    const block = renderBlock(all, { query: 'stripe', now, maxTokens: 120 })
    const n = block.split('\n').filter((l) => /^- \[(d|x)\d+\]/.test(l)).length
    expect(n).toBeLessThanOrEqual(2)
  })
})
