import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { GraphStore } from '../../src/main/context-engine/store'
import { BrainReader, type RawCommitment } from '../../src/main/brain-access/reader'

// A fake brain for the brain-access, MCP and Team access tests: a real graph in an in-memory database,
// seeded by hand (people, a client, a partner, a bot-only project, texts, a health fact, an activity fact,
// a secret), with commitments and a vault note's brief.

export const NOW = Date.UTC(2026, 10, 18, 15, 0)
export const DAY = 86_400_000

export function fakeBrain() {
  const db = new Db(':memory:')
  db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' })
  const sales = db.createSpace('Sales', '#123456')
  const g = new GraphStore(db, () => NOW)
  const memory = new MemoryStore(db)
  const priya = g.create('person', 'Priya Shah', { trust: 'observed', confidence: 0.9 })
  const acme = g.create('organization', 'Acme Corp', { trust: 'observed', confidence: 0.9 })
  const partnerB = g.create('organization', 'Partner B', { trust: 'observed', confidence: 0.9 })
  const secretProject = g.create('project', 'Project Falcon', { trust: 'observed', confidence: 0.9, scope: sales.id })
  const email = (id: string, at: number) => ({ kind: 'connector' as const, ref: `brain:gmail:${id}`, label: 'Email · Oct 14', link: `https://mail.google.com/mail/u/0/#all/${id}` })
  g.addAttribute(priya.id, { key: 'role', value: 'Head of Ops', trust: 'observed', confidence: 0.9, source: email('t1', NOW - 5 * DAY), at: NOW - 5 * DAY })
  g.addAttribute(acme.id, { key: 'kind', value: 'client', trust: 'user', confidence: 1, source: { kind: 'you', label: 'you' }, at: NOW - 30 * DAY })
  g.addRelation(priya.id, 'works_at', acme.id, { trust: 'observed', confidence: 0.9, source: email('t1', NOW - 5 * DAY), at: NOW - 5 * DAY })
  g.addMention(priya.id, { at: NOW - 2 * DAY, source: { kind: 'connector', ref: 'brain:zoom:m1', label: 'Meeting notes · Mon' }, snippet: 'Priya: we left it at sending the revised proposal by Friday', trust: 'quoted' })
  g.addAttribute(priya.id, { key: 'note', value: 'running late to dinner tonight', trust: 'quoted', confidence: 0.6, source: { kind: 'connector', ref: 'brain:texts:x1', label: 'Text' }, at: NOW - DAY })
  g.addAttribute(priya.id, { key: 'condition', value: 'has diabetes', trust: 'quoted', confidence: 0.6, source: email('t2', NOW - 3 * DAY), at: NOW - 3 * DAY, category: 'health' })
  g.addAttribute(priya.id, { key: 'app', value: 'uses Figma a lot', trust: 'observed', confidence: 0.6, source: { kind: 'activity', label: 'activity' }, at: NOW - DAY })
  g.addAttribute(partnerB.id, { key: 'payment_terms', value: 'Net 30, promised in the Oct 14 email', trust: 'quoted', confidence: 0.8, source: email('t3', NOW - 35 * DAY), at: NOW - 35 * DAY })
  g.addAttribute(partnerB.id, { key: 'api_key', value: 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234', trust: 'quoted', confidence: 0.5, source: email('t4', NOW - 3 * DAY), at: NOW - 3 * DAY })
  g.addAttribute(secretProject.id, { key: 'status', value: 'pitch deck due Monday', trust: 'quoted', confidence: 0.8, source: email('t5', NOW - DAY), at: NOW - DAY, scope: sales.id })
  g.setVaultPath(acme.id, 'Shared/Organizations/Acme Corp.md')
  memory.save('Acme renews in Q1 every year', 'fact', null, 'chat')
  const commitments: RawCommitment[] = [
    { id: 'c1', entityId: priya.id, who: 'Priya Shah', what: 'send the revised proposal', dueAt: Date.UTC(2026, 10, 20), dueWords: 'by Friday', owner: 'user', ref: 'brain:zoom:m1', status: 'open', createdAt: NOW - 2 * DAY },
    { id: 'c2', entityId: partnerB.id, who: 'Partner B', what: 'pay invoice 1042', dueAt: null, dueWords: 'Friday', owner: 'them', ref: 'brain:texts:x9', status: 'open', createdAt: NOW - DAY },
    { id: 'c3', entityId: priya.id, who: 'Priya Shah', what: 'old thing', dueAt: null, dueWords: '', owner: 'user', ref: 'brain:gmail:t9', status: 'done', createdAt: NOW - 9 * DAY }
  ]
  const secrets = ['hunter2-vault-password']
  const reader = new BrainReader({
    graph: () => g, engineOn: () => true, now: () => NOW, secretValues: () => secrets,
    memory, commitments: () => commitments,
    vault: {
      search: (q) => q.toLowerCase().includes('acme') ? [{ path: 'Shared/Facts/Acme pricing.md', title: 'Acme pricing', type: 'fact', section: 'Shared', snippet: 'Acme pays $4k a month on the retainer', score: 1 }] : [],
      body: (p) => (p === 'Shared/Organizations/Acme Corp.md' ? '# Acme Corp\n\n### Written for you\nRetainer client, renews Q1. Main contact: Priya Shah. She asked for the revised proposal by Friday.\nSources: Email · Oct 14\n' : null),
      sectionFor: (id) => (id === sales.id ? 'Bots/Sales' : null)
    }
  })
  return { db, g, memory, reader, priya, acme, partnerB, secretProject, sales, secrets }
}

