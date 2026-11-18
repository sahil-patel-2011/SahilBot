import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Fake connected apps and model answers for the brain's hidden tests and screenshots (SAHILBOT_BRAIN_FIXTURE).

const DAY = 86_400_000
export const EXTRACT = 'You read a batch of items'
export const BRIEF = 'You write short briefs'

export function brainFixture(now = Date.now()): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-fixture-'))
  const t1 = new Date(now - 1 * DAY).toISOString(), t2 = new Date(now - 2 * DAY).toISOString()
  const threads = { threads: [
    { id: 'th1', messages: [{ id: 'm1', sender: 'Sarah Lee <sarah@clienta.com>', subject: 'Revised proposal', snippet: 'Could you send the revised proposal by Friday?', date: t1 }] },
    { id: 'th2', messages: [{ id: 'm2', sender: 'Deals <no-reply@saas.example>', subject: 'Your weekly digest', snippet: 'Unsubscribe any time', date: t2 }] }
  ] }
  const file = join(dir, 'brain.json')
  writeFileSync(file, JSON.stringify({ presets: {
    gmail: { state: 'connected', tools: ['search_threads', 'get_thread'], calls: {
      search_threads: threads,
      get_thread: { byArg: 'threadId', answers: {
        th1: { messages: [{ id: 'm1', sender: 'Sarah Lee <sarah@clienta.com>', subject: 'Revised proposal', date: t1, plaintextBody: 'Hi! Great call on Monday. Could you send the revised proposal by Friday? Acme Retail is on a retainer that renews in Q1. Thanks, Sarah' }] },
        th2: { messages: [{ id: 'm2', sender: 'Deals <no-reply@saas.example>', subject: 'Your weekly digest', date: t2, plaintextBody: 'Top deals this week. Unsubscribe any time.' }] }
      } }
    } },
    gcal: { state: 'connected', tools: ['list_events'], calls: { list_events: { items: [] } } },
    hubspot: { state: 'needs_auth' },
    slack: { state: 'absent' }
  } }))
  return file
}

/** Answers the brain's model calls (extraction and briefs) and echoes everything else. */
export function brainReplies(req: Record<string, any>): { content: string; delay: number } {
  const system = String(req.messages?.[0]?.content ?? '')
  const user = String(req.messages?.[req.messages.length - 1]?.content ?? '')
  if (system.startsWith(EXTRACT)) {
    const item = /<item id="(I\d+)"[^>]*from="Sarah Lee/.exec(user)?.[1] ?? 'I1'
    return { delay: 0, content: JSON.stringify({
      entities: [{ name: 'Sarah Lee', type: 'person', emails: ['sarah@clienta.com'], org: 'Acme Retail' }, { name: 'Acme Retail', type: 'organization', client: true }],
      facts: [{ entity: 'Acme Retail', key: 'contract', value: 'retainer that renews in Q1', item }],
      commitments: [{ who: 'Sarah Lee', what: 'the revised proposal', due: 'Friday', owner: 'user', item }]
    }) }
  }
  if (system.startsWith(BRIEF)) {
    const briefs = [...user.matchAll(/<entity id="(E\d+)" name="([^"]+)"/g)].map(([, id, name]) => ({
      id, sources: ['S1'],
      text: name === 'Acme Retail' ? 'Retainer, renews Q1. Main contact: Sarah Lee. On Monday’s call she asked for the revised proposal by Friday.' : name === 'Sarah Lee' ? 'Your main contact at Acme Retail. She asked for the revised proposal by Friday.' : `${name} came up in your email this week.`
    }))
    return { delay: 0, content: JSON.stringify({ briefs }) }
  }
  const last = [...(req.messages ?? [])].reverse().find((m: any) => m.role === 'user')
  return { delay: 0, content: `Echo: ${typeof last?.content === 'string' ? last.content.slice(0, 200) : ''}` }
}

