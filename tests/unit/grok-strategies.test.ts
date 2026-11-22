import { expect, test } from 'vitest'
import { LoopGuard, canonicalArgs } from '../../src/main/agent/recover'
import { taskBrief } from '../../src/main/agent/context'
import type { Message } from '../../src/shared/types'

const call = (name: string, args: Record<string, unknown>) => ({ id: Math.random().toString(36), name, arguments: JSON.stringify(args) })

test('a polling loop is nudged, then stopped, even when its results change (Grok Build strategy)', () => {
  const g = new LoopGuard()
  const isRead = (c: { name: string }): boolean => c.name === 'job_status'
  const results: Array<ReturnType<LoopGuard['step']>> = []
  for (let i = 0; i < 8; i++) results.push(g.step([call('job_status', { id: 'j1', verbose: true })], isRead))
  expect(results.slice(0, 3)).toEqual([{}, {}, {}])
  expect(results[3].nudge).toMatch(/polling loop/)
  expect(results[7].stop).toMatch(/ran 8 times/)
  // Key order and call order don't make it a different step.
  const h = new LoopGuard()
  h.step([call('a', { x: 1, y: 2 }), call('b', {})], () => true)
  expect(canonicalArgs('{"y":2,"x":1}')).toBe(canonicalArgs('{"x":1,"y":2}'))
  for (let i = 0; i < 2; i++) h.step([call('b', {}), call('a', { y: 2, x: 1 })], () => true)
  expect(h.step([call('a', { x: 1, y: 2 }), call('b', {})], () => true).nudge).toMatch(/4 times/)
  // A different step resets the count; writes get more room before a nudge.
  const w = new LoopGuard()
  for (let i = 0; i < 7; i++) expect(w.step([call('file_write', { path: 'a' })], () => false)).toEqual({})
  expect(w.step([call('file_write', { path: 'a' })], () => false).nudge).toBeDefined()
  expect(w.step([call('file_write', { path: 'b' })], () => false)).toEqual({})
})

test('the compaction brief lists the files the task changed, from the tool record', () => {
  const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ id: Math.random().toString(36), threadId: 't', role, content, kind: 'normal', status: 'done', createdAt: 0, ...extra } as Message)
  const ms = [
    m('user', 'Fix the parser and update the docs.'),
    m('tool', 'ok', { toolName: 'file_read', meta: { status: 'ok', path: '/repo/src/lexer.ts' } }),
    m('tool', 'ok', { toolName: 'file_write', meta: { status: 'ok', path: '/repo/src/parser.ts' } }),
    m('tool', 'ok', { toolName: 'code', meta: { status: 'ok', path: '/repo/docs/parser.md' } }),
    m('tool', 'failed', { toolName: 'file_write', meta: { status: 'error', path: '/repo/x.ts' } })
  ]
  const brief = taskBrief(ms, { todos: [], notes: undefined, taskNotes: undefined } as never, { window: 64_000 })!
  expect(brief).toContain('- /repo/src/parser.ts')
  expect(brief).toContain('- /repo/docs/parser.md')
  expect(brief).not.toContain('lexer.ts')
  expect(brief).not.toContain('/repo/x.ts')
})

test('benchmark-based rows: business writing and electrical engineering get their own evidence, creative writing keeps its row', async () => {
  const { classifyTask, writingVoice } = await import('../../src/main/llm/task-classifier')
  const { routeFor, PROFESSIONAL_WRITING, ELECTRICAL_ENGINEERING, ROUTING_TABLE, slotsFor } = await import('../../src/main/llm/routing-table')
  expect(writingVoice('draft an email to the client about the delay')).toBe('professional')
  expect(writingVoice('write a poem for my boss')).toBe('creative')
  const email = classifyTask('Write a follow-up email to the client about the delayed shipment')
  expect(email).toMatchObject({ category: 'writing', voice: 'professional' })
  expect(routeFor(email.category, email)).toBe(PROFESSIONAL_WRITING)
  expect(slotsFor(email.category, 2, 'balanced', false, email)[0]).toBe('sonnet')
  const circuit = classifyTask('Pick a pull-up resistor value for this I2C bus and check the voltage divider on the sensor')
  expect(circuit.domain).toBe('electrical')
  expect(routeFor(circuit.category, circuit)).toBe(ELECTRICAL_ENGINEERING)
  expect(slotsFor(circuit.category, 3, 'best', false, circuit).slice(0, 2)).toEqual(['opus', 'astra'])
  const poem = classifyTask('Write a short poem about autumn in Vermont')
  expect(routeFor(poem.category, poem)).toBe(ROUTING_TABLE.writing)
})

test('a pasted API key with a well-known prefix knows its site, so it saves to the vault without asking', async () => {
  const { keySite, savesWithoutAsking } = await import('../../src/main/secure/offers')
  expect(keySite('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('https://console.anthropic.com')
  expect(keySite('sk-proj-abcdefghijklmnopqrstuvwxyz012345')).toBe('https://platform.openai.com')
  expect(keySite('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('https://github.com')
  expect(keySite('xai-abcdefghijklmnopqrstuvwxyz')).toBe('https://console.x.ai')
  expect(keySite('totally-unknown-token')).toBe('')
  const base = { id: 'o', source: 'chat' as const, kind: 'api_key' as const, title: '', site: '', origin: '', name: 'k', label: 'API key', status: 'pending' as const }
  expect(savesWithoutAsking({ ...base })).toBe(true)
  expect(savesWithoutAsking({ ...base, needs: ['site'] })).toBe(false)
  expect(savesWithoutAsking({ ...base, kind: 'card', needs: ['holder'] })).toBe(true)
})

test('a reply that announces an action without doing it is caught; finished work and questions are not', async () => {
  const { promisesAction } = await import('../../src/main/agent/loop')
  expect(promisesAction("Publishing the clicks post now. I'll send you the live link once it's up.")).toBe(true)
  expect(promisesAction("Got it. I'll deploy it to Vercel and send you the URL.")).toBe(true)
  expect(promisesAction('Let me create the presentation for you.')).toBe(true)
  expect(promisesAction('I published the post: https://example.com/clicks')).toBe(false)
  expect(promisesAction('Done. The deck is saved to ~/SahilBot/Decks/q4.pptx.')).toBe(false)
  expect(promisesAction('Want me to publish it?')).toBe(false)
  expect(promisesAction('Here is the summary of the article you asked about.')).toBe(false)
  // Ordinary closers the independent review flagged: not promises of work to do now.
  expect(promisesAction('All three reports are attached. I\'ll update you if anything changes.')).toBe(false)
  expect(promisesAction('Let me run through what I found: the costs are within budget.')).toBe(false)
  expect(promisesAction('Done for today. I\'ll check in tomorrow.')).toBe(false)
  // The gerund forms it used to miss.
  expect(promisesAction('Running the migration now.')).toBe(true)
  expect(promisesAction('Submitting the form now.')).toBe(true)
  // Everyday edits it used to miss (Agent Arena: a changelog entry announced and never written).
  expect(promisesAction("I'll add the 1.2.0 entry to CHANGELOG.md now.")).toBe(true)
  expect(promisesAction('Updating the three config files now.')).toBe(true)
  expect(promisesAction('Let me rename the function across the project.')).toBe(true)
  expect(promisesAction('Let me summarize what I found: revenue is up 12%.')).toBe(false)
  expect(promisesAction('I updated CHANGELOG.md with the 1.2.0 entry.')).toBe(false)
})

test('review fixes: masking keeps whole words, recall widens only on real back-references', async () => {
  const { maskText, emptyPrivacy } = await import('../../src/main/privacy/gate')
  const st = emptyPrivacy()
  st.items.push({ value: 'Ann', label: 'private_person', placeholder: '[PERSON_1]', share: false })
  expect(maskText('Ann asked about annual revenue; ANN agreed.', st)).toBe('[PERSON_1] asked about annual revenue; [PERSON_1] agreed.')
  st.items.push({ value: 'ann@x.io', label: 'private_email', placeholder: '[EMAIL_1]', share: false })
  expect(maskText('Mail ann@x.io today', st)).toBe('Mail [EMAIL_1] today')
  const { recallQuery } = await import('../../src/main/agent/loop')
  const history = [{ id: '1', role: 'user' as const, content: 'Our tax filing for the LLC', meta: {} }, { id: '2', role: 'user' as const, content: 'Write a cover letter for it, I want something warm and short', meta: {} }]
  expect(recallQuery(history[1], history)).toBe(history[1].content)
  const back = { id: '3', role: 'user' as const, content: 'Do it the same way as last time', meta: {} }
  expect(recallQuery(back, [...history, back])).toContain('Our tax filing')
})
