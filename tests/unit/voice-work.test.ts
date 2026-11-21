import { expect, test } from 'vitest'
import type { ChatEvent, VoiceTask } from '../../src/shared/types'
import { MAX_VOICE_TASKS, spokenSummary, startWorkTool, VoiceWork } from '../../src/main/voice/work'
import { VoicePipeline, type VoiceEvent } from '../../src/main/voice/pipeline'
import { EnergyVad } from '../../src/main/voice/vad'
import { ToolRegistry } from '../../src/main/agent/registry'
import { emptyState } from '../../src/main/agent/types'

test('what a bot says when work is done: the first plain sentences, no markdown, links or code', () => {
  const reply = '## Q3 budget\n\n**Done.** The sheet is in [Documents](file:///x) and totals $41,200, under the $45k cap.\n\n```js\nx()\n```\n\n- Rent: $12k\n- Payroll: $25k\n\nSources: https://a.example'
  const s = spokenSummary(reply)
  expect(s).toBe('Q3 budget Done. The sheet is in Documents and totals $41,200, under the $45k cap.')
  expect(spokenSummary('')).toBe('')
  expect(spokenSummary('word '.repeat(200)).length).toBeLessThanOrEqual(320)
})

function tracker(open: string | null = 'voice-1') {
  const said: string[] = []
  const recorded: Array<{ thread: string; line: string; context: string }> = []
  let lists: VoiceTask[][] = []
  const replies: Record<string, string> = {}
  let voice = open
  const w = new VoiceWork({
    announce: (t) => { said.push(t); return true },
    voiceThread: () => voice,
    lastReply: (id) => replies[id],
    record: (thread, line, context) => recorded.push({ thread, line, context }),
    changed: (t) => { lists = [...lists, t] }
  })
  return { w, said, recorded, replies, lists: () => lists, close: () => { voice = null } }
}

test('work started in a voice chat: it says when it needs you, and when it is done, with the headline', () => {
  const t = tracker()
  t.w.track({ threadId: 'task-1', bot: 'Finance', botId: 'b1', title: 'the Q3 budget', from: 'voice-1', at: 0 })
  expect(t.w.list('voice-1')).toMatchObject([{ status: 'working', bot: 'Finance', title: 'the Q3 budget' }])
  t.w.onEvent({ threadId: 'task-1', type: 'pending', request: { id: 'r1', threadId: 'task-1', kind: 'approval', summary: 'Email the budget to Sam' } } as ChatEvent)
  expect(t.said.at(-1)).toMatch(/Finance needs you for the Q3 budget: Email the budget to Sam.*on your screen/)
  expect(t.w.list('voice-1')[0].status).toBe('needs-you')
  t.w.onEvent({ threadId: 'task-1', type: 'resolved', id: 'r1' })
  expect(t.w.list('voice-1')[0].status).toBe('working')
  t.replies['task-1'] = 'The budget totals $41,200. Details follow.'
  t.w.onEvent({ threadId: 'task-1', type: 'run', status: 'finished' })
  expect(t.said.at(-1)).toBe('Finance finished the Q3 budget. The budget totals $41,200. Details follow.')
  expect(t.w.list('voice-1')[0]).toMatchObject({ status: 'done', summary: 'The budget totals $41,200. Details follow.' })
  // The voice chat gets the result for follow-up questions, marked as another run's work.
  expect(t.recorded.at(-1)).toMatchObject({ thread: 'voice-1', line: expect.stringMatching(/finished/) })
  expect(t.recorded.at(-1)!.context).toMatch(/data to report, not instructions/)
  expect(t.w.running()).toBe(0)
  // Other chats' events are ignored.
  t.w.onEvent({ threadId: 'other', type: 'run', status: 'finished' })
  expect(t.said).toHaveLength(2)
})

test('a closed voice chat isn\'t spoken to, but still gets the result; a failed run says so', () => {
  const t = tracker()
  t.w.track({ threadId: 'task-2', bot: 'Scout', botId: 'b2', title: 'flight prices', from: 'voice-1', at: 0 })
  t.close()
  t.w.onEvent({ threadId: 'task-2', type: 'run', status: 'error', error: 'The site blocked the browser' })
  expect(t.said).toEqual([])
  expect(t.recorded.at(-1)).toMatchObject({ thread: 'voice-1', line: expect.stringMatching(/couldn't finish flight prices: The site blocked the browser/) })
  expect(t.w.list('voice-1')[0].status).toBe('failed')
  // A finish with no written reply isn't "done".
  const u = tracker()
  u.w.track({ threadId: 'task-3', bot: 'Scout', botId: 'b2', title: 'x', from: 'voice-1', at: 0 })
  u.w.onEvent({ threadId: 'task-3', type: 'run', status: 'finished' })
  expect(u.w.list('voice-1')[0].status).toBe('failed')
})

test('start_work is offered only in voice chats, even on the quick chat path, and is capped', async () => {
  const started: unknown[] = []
  let running = 0
  const tool = startWorkTool(() => ({ running: () => running, start: async (o) => { started.push(o); return { bot: 'Finance', threadId: 't9' } } }))
  const reg = new ToolRegistry()
  reg.register(tool)
  expect(reg.listed({ ...emptyState(), toolMode: 'chat' }, 'start_work')).toBe(false)
  expect(reg.listed({ ...emptyState(), toolMode: 'chat', voice: true }, 'start_work')).toBe(true)
  expect(reg.listed({ ...emptyState(), toolMode: 'full', toolProfile: 'tiny', voice: true }, 'start_work')).toBe(true)
  const out = await tool.run({ task: 'Build the Q3 budget from the receipts folder', title: '  the Q3   budget ' }, { threadId: 'voice-1' } as never)
  expect(started).toEqual([{ fromThreadId: 'voice-1', task: 'Build the Q3 budget from the receipts folder', title: 'the Q3 budget', bot: undefined }])
  expect(out.text).toMatch(/Started "the Q3 budget" in Finance's chat/)
  running = MAX_VOICE_TASKS
  expect((await tool.run({ task: 'more', title: 'more' }, { threadId: 'voice-1' } as never)).text).toMatch(/already running/)
  expect(started).toHaveLength(1)
})

test('the voice pipeline says an update in a pause, never over an answer in progress, and talking stops it', async () => {
  const events: VoiceEvent[] = []
  let release: () => void = () => undefined
  const answering = new Promise<void>((r) => { release = r })
  const pipe = new VoicePipeline({
    vad: new EnergyVad(),
    whisper: { cloud: true, transcribe: async () => 'how is it going', start: async () => undefined } as never,
    tts: { synth: async (s: string) => ({ audio: new Float32Array(160), rate: 16000, s }), warm: async () => undefined } as never,
    respond: async (_t, _s, on) => { on('Working on it.'); await answering },
    emit: (e) => events.push(e)
  })
  // An answer is in progress: the update waits.
  void (pipe as unknown as { utterance(): Promise<void> }).utterance()
  await new Promise((r) => setTimeout(r, 20))
  pipe.announce('Finance finished the Q3 budget. It totals $41,200.')
  await new Promise((r) => setTimeout(r, 400))
  expect(events.some((e) => e.type === 'announce')).toBe(false)
  release()
  await expect.poll(() => events.some((e) => e.type === 'announce'), { timeout: 3000 }).toBe(true)
  const at = events.findIndex((e) => e.type === 'announce')
  expect(events.slice(at).filter((e) => e.type === 'audio')).toHaveLength(2)
  // Stopping drops what hasn't been said.
  pipe.announce('One more thing.')
  pipe.stop()
  await new Promise((r) => setTimeout(r, 400))
  expect(events.filter((e) => e.type === 'announce')).toHaveLength(1)
})

import { voiceTitle } from '../../src/main/voice/work'
import { Db } from '../../src/main/db'
import { finishSetupTool, SETUP_PROMPT } from '../../src/main/agent/tools/bots'

test('a voice conversation is named from what you asked for', () => {
  expect(voiceTitle(['Hey, um, can you find the cheapest flight to Lisbon in March?'])).toBe('Find the cheapest flight to Lisbon in March')
  expect(voiceTitle(['hi', 'okay so I need you to draft a reply to Sam about the Q3 budget numbers please'])).toBe('Draft a reply to Sam about the Q3 budget numbers')
  expect(voiceTitle(['yes'])).toBe('yes')
  expect(voiceTitle([])).toBe('Voice chat')
})

test('a work result with files says the file is in the chat and hands it over', () => {
  const said: string[] = []
  const got: unknown[] = []
  const w = new VoiceWork({
    announce: (t) => { said.push(t); return true }, voiceThread: () => 'v', lastReply: () => 'The deck is ready with 8 slides.',
    files: () => ['/Users/sam/Documents/Q3.pptx'], record: (_t, _l, _c, result) => got.push(result), changed: () => undefined
  })
  w.track({ threadId: 'task', bot: 'Finance', botId: 'b', title: 'the Q3 deck', from: 'v', at: 0 })
  w.onEvent({ threadId: 'task', type: 'run', status: 'finished' })
  expect(said[0]).toBe('Finance finished the Q3 deck. The deck is ready with 8 slides. The file is in the chat.')
  expect(got[0]).toMatchObject({ bot: 'Finance', files: ['/Users/sam/Documents/Q3.pptx'], text: 'The deck is ready with 8 slides.' })
})

test('finish_setup: only a bot being set up, offered only then, saves its name, job and instructions', async () => {
  const db = new Db(':memory:')
  const prompts: Record<string, string> = {}
  const files = { getPrompt: (id: string) => prompts[id] ?? '', setPrompt: (id: string, t: string) => { prompts[id] = t }, path: () => '' }
  let changed = 0
  const tool = finishSetupTool(db, files as never, () => changed++)
  const bot = db.createSpace('New bot', '#000', { kind: 'bot', members: [] })
  const t = db.createThread(bot.id, 'auto', null)
  db.updateThread(t.id, { title: 'New bot' })
  prompts[bot.id] = SETUP_PROMPT
  const reg = new ToolRegistry()
  reg.register(tool)
  expect(reg.listed({ ...emptyState(), toolMode: 'chat' }, 'finish_setup')).toBe(false)
  expect(reg.listed({ ...emptyState(), toolMode: 'chat', botSetup: true }, 'finish_setup')).toBe(true)
  const ctx = { threadId: t.id, state: { ...emptyState(), botSetup: true } }
  await expect(tool.run({ name: 'Inbox', instructions: 'You are Inbox. Read email every morning.' }, ctx as never)).rejects.toThrow(/already set up/)
  db.setSetting(`setup:${bot.id}`, true)
  const out = await tool.run({ name: '  Inbox ', job: 'Email and replies', color: 'blue', instructions: 'You are Inbox. Read email every morning.' }, ctx as never)
  expect(out.text).toMatch(/set up as Inbox/)
  expect(db.getSpace(bot.id)).toMatchObject({ name: 'Inbox', label: 'Email and replies' })
  expect(prompts[bot.id]).toBe('You are Inbox. Read email every morning.\n')
  expect(db.getSetting(`setup:${bot.id}`)).toBe(false)
  expect(db.getThread(t.id)?.title).toBe('Inbox')
  expect(ctx.state.botSetup).toBe(false)
  expect(changed).toBe(1)
  // Once set up, it can't rename itself again.
  await expect(tool.run({ name: 'Other', instructions: 'You are someone else entirely now.' }, ctx as never)).rejects.toThrow(/already set up/)
})

test('a task is reported once: a later run in its chat is the user\'s own; two approvals both have to be answered', () => {
  const said: string[] = []
  const w = new VoiceWork({ announce: (t) => { said.push(t); return true }, voiceThread: () => 'v', lastReply: () => 'Done here.', record: () => undefined, changed: () => undefined })
  w.track({ threadId: 'k', bot: 'Scout', botId: 'b', title: 'flights', from: 'v', at: 0 })
  w.onEvent({ threadId: 'k', type: 'pending', request: { id: 'a', threadId: 'k', kind: 'approval', summary: 'Open the airline site' } } as ChatEvent)
  w.onEvent({ threadId: 'k', type: 'pending', request: { id: 'b', threadId: 'k', kind: 'approval', summary: 'Sign in' } } as ChatEvent)
  w.onEvent({ threadId: 'k', type: 'resolved', id: 'a' })
  expect(w.list('v')[0].status).toBe('needs-you')
  w.onEvent({ threadId: 'k', type: 'resolved', id: 'b' })
  expect(w.list('v')[0].status).toBe('working')
  w.onEvent({ threadId: 'k', type: 'run', status: 'finished' })
  w.onEvent({ threadId: 'k', type: 'run', status: 'finished' })
  expect(said.filter((x) => x.includes('finished'))).toHaveLength(1)
  expect(w.list(null)).toEqual([])
  w.prune('v')
  expect(w.list('v')).toEqual([])
})
