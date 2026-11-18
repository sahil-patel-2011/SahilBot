import type { BrainCommitmentOut, BrainEntityOut, BrainFact, BrainScope, BrainScopeSource, BrainSourceRef } from '@shared/brain-access'
import type { FactSource, SensitiveCategory, Trust } from '@shared/context-engine'
import type { VaultSearchHit } from '@shared/vault'
import { lookup } from '../context-engine/assemble'
import { categoriesOf } from '../context-engine/sensitive'
import type { GraphStore, StoredAttribute, StoredEntity } from '../context-engine/store'
import { hasSecret } from '../learning/extract'
import { SECRETISH, type Memory } from '../memory'
import { redactSecrets as redactTokens } from '../knowledge/ignore'
import { redactSecrets } from '../secure/redact'

// Read-only access to the user's brain for someone outside SahilBot: a connected AI app (the MCP
// server's brain tools) or a teammate (Team access). Every fact goes through the same checks, in order:
//   1. its source is one the scope allows (texts and activity never unless allowed; activity never at all);
//   2. its entity is in scope (shared entities, or the listed ones), and bot-only facts only for the bots named;
//   3. its topic, when the scope limits topics;
//   4. nothing sensitive (health, money, …) unless that category is allowed, judged on the stored category
//      AND on the text itself;
//   5. never a secret: vault values, token-shaped strings, key=value passwords (dropped, then redacted).
// It only reads (the graph, the vault's search, shared memories, the brain's commitments and briefs).

export interface RawCommitment {
  id: string
  entityId: string | null
  who: string
  what: string
  dueAt: number | null
  dueWords: string
  /** Who owes it: the user or them. */
  owner: 'user' | 'them'
  ref: string
  status: string
  createdAt: number
}

export interface BrainReaderDeps {
  graph(): GraphStore | null
  /** People & Places is on (off: no entity facts at all). */
  engineOn(): boolean
  vault?: {
    search(query: string, sections: string[], k: number): VaultSearchHit[]
    /** A note's body by path (for the entity's "Written for you" brief). */
    body(path: string): string | null
    /** A bot's vault area ("Bots/<name>"), or null. */
    sectionFor(spaceId: string): string | null
  }
  memory?: { enabled: boolean; search(query: string, spaceId?: string | null, limit?: number): Memory[] }
  /** The brain's commitments (src/main/brain), when it keeps them. */
  commitments?(): RawCommitment[]
  /** The brain's brief for an entity, when it wrote one. */
  brief?(entityId: string): { text: string; chips?: Array<{ label: string; link?: string; kind?: string; at?: number }> } | null
  secretValues(): string[]
  now?(): number
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY = 86_400_000

/** Connected-app source ids (the brain's, src/main/brain/sources.ts, and connector presets) → scope source. */
const SOURCE_KIND: Record<string, BrainScopeSource> = {
  gmail: 'email', 'gmail-imap': 'email', 'apple-mail': 'email', outlook: 'email', 'outlook-mail': 'email', fastmail: 'email',
  gcal: 'calendar', 'google-calendar': 'calendar', 'apple-calendar': 'calendar', 'outlook-calendar': 'calendar', calendly: 'calendar',
  zoom: 'meetings', granola: 'meetings', fireflies: 'meetings', otter: 'meetings', meet: 'meetings', 'google-meet': 'meetings', gong: 'meetings',
  hubspot: 'crm', salesforce: 'crm', pipedrive: 'crm', attio: 'crm', close: 'crm',
  gdrive: 'docs', 'google-drive': 'docs', notion: 'docs', dropbox: 'docs', box: 'docs', confluence: 'docs', onedrive: 'docs',
  quickbooks: 'accounting', xero: 'accounting', stripe: 'accounting', freshbooks: 'accounting',
  slack: 'chat', teams: 'chat', 'microsoft-teams': 'chat', discord: 'chat',
  texts: 'texts', imessage: 'texts', messages: 'texts', sms: 'texts'
}
const LABEL_KIND: Array<[RegExp, BrainScopeSource]> = [
  [/\b(texts?|imessage|sms)\b/i, 'texts'], [/\b(e-?mail|gmail|outlook mail|apple mail)\b/i, 'email'], [/\b(calendar|event)\b/i, 'calendar'],
  [/\b(zoom|meeting|call notes|granola|fireflies|otter|meet)\b/i, 'meetings'], [/\b(hubspot|salesforce|crm|deal|pipedrive)\b/i, 'crm'],
  [/\b(drive|notion|doc|dropbox|sow|contract)\b/i, 'docs'], [/\b(quickbooks|xero|stripe|invoice|accounting)\b/i, 'accounting'], [/\b(slack|teams|discord)\b/i, 'chat']
]
const CHIP_NOUN: Record<BrainScopeSource, string> = {
  email: 'Email', calendar: 'Calendar', meetings: 'Meeting notes', crm: 'CRM', docs: 'Doc', accounting: 'Accounting', chat: 'Team chat',
  texts: 'Text message', notes: 'Vault note', memories: 'Memory', chats: 'SahilBot chat', files: 'File', apps: 'App'
}

/** The scope source a fact's source counts as ('activity' facts are never shared; 'you' facts are the owner's own). */
export function sourceKindOf(s: FactSource | undefined): BrainScopeSource | 'you' | 'activity' {
  if (!s) return 'apps'
  switch (s.kind) {
    case 'you': return 'you'
    case 'activity': return 'activity'
    case 'memory': return 'memories'
    case 'file': return 'files'
    case 'chat': case 'tool': return 'chats'
    case 'connector': {
      const m = /^brain:([\w-]+):/.exec(s.ref ?? '') ?? /^([\w-]+):/.exec(s.ref ?? '')
      if (m && SOURCE_KIND[m[1].toLowerCase()]) return SOURCE_KIND[m[1].toLowerCase()]
      const hit = LABEL_KIND.find(([rx]) => rx.test(`${s.label ?? ''} ${s.ref ?? ''}`))
      return hit ? hit[1] : 'apps'
    }
    default: return 'apps'
  }
}

export const isoDay = (t: number | undefined): string | undefined => (t && Number.isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : undefined)

/** "Tue" within the last week, "Oct 14" within the year, else "Oct 14, 2025". */
export function chipDate(t: number | undefined, now: number): string {
  if (!t || !Number.isFinite(t)) return ''
  const d = new Date(t)
  const n = new Date(now)
  if (Math.abs(now - t) < 6 * DAY) return WEEKDAY[d.getDay()]
  return d.getFullYear() === n.getFullYear() ? `${MON[d.getMonth()]} ${d.getDate()}` : `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

/** A chip for a fact's source. The brain's labels ("Email · Oct 28", "HubSpot deal") are kept; others are made. */
export function sourceRef(s: FactSource | undefined, at: number | undefined, now: number): BrainSourceRef {
  const k = sourceKindOf(s)
  const kind = k === 'you' ? 'you' : k === 'activity' ? 'app' : k === 'notes' ? 'note' : k === 'memories' ? 'memory' : k === 'chats' ? 'sahilbot-chat' : k === 'files' ? 'file' : k
  const date = chipDate(at, now)
  let label: string
  if (k === 'you') label = 'You said'
  else if (s?.kind === 'connector' && s.label && /·|\bdeal\b|\binvoice\b/i.test(s.label)) label = s.label
  else if (k === 'chats') label = `SahilBot chat${date ? ` · ${date}` : ''}`
  else if (k === 'files') label = s?.label ? `${s.label.slice(0, 60)}` : 'File'
  else label = `${CHIP_NOUN[k as BrainScopeSource] ?? 'Source'}${date ? ` · ${date}` : ''}`
  const link = s?.link && /^(https?:|message:|sahilbot:)/i.test(s.link) ? s.link : undefined
  return { kind, label, ...(s?.label && s.label !== label ? { title: s.label.slice(0, 120) } : {}), ...(isoDay(at) ? { date: isoDay(at) } : {}), ...(link ? { link } : {}) }
}

const STOP = new Set(['what', 'when', 'where', 'who', 'whom', 'which', 'with', 'did', 'does', 'the', 'and', 'for', 'about', 'from', 'that', 'this', 'have', 'has', 'was', 'were', 'are', 'our', 'your', 'you', 'they', 'them', 'their', 'leave', 'left', 'last', 'tell', 'know', 'any', 'how', 'why', 'there', 'into', 'over', 'agree', 'agreed', 'promise', 'promised', 'say', 'said'])
export const terms = (q: string): string[] => [...new Set(q.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))]

const isClientAttr = (a: Pick<StoredAttribute, 'key' | 'value'>): boolean => (a.key === 'kind' || a.key === 'relationship' || a.key === 'role') && /\bclient|customer\b/i.test(a.value)
const COMMIT_KEYS = /^(due|deadline|promised|promise|asked_for|asked|owes|owe|next_step|follow_up|waiting_on|commitment|todo)$/

/** Text that's safe to hand out: secret-shaped strings and vault values cut out. */
export function scrubText(s: string, secrets: string[]): string {
  let out = redactSecrets(s, secrets)
  for (const v of secrets) if (v.length >= 4) out = out.split(v).join('[hidden]')
  return redactTokens(out)
}

export class BrainReader {
  constructor(private d: BrainReaderDeps) {}

  private now(): number { return this.d.now?.() ?? Date.now() }

  // ---------------------------------------------------------------- the checks

  private sourceAllowed(s: FactSource | undefined, scope: BrainScope): boolean {
    const k = sourceKindOf(s)
    if (k === 'activity') return false
    if (k === 'you') return true
    return scope.sources.includes(k)
  }

  /** Sensitive text (a category not allowed) or a secret. */
  private blockedText(text: string, scope: BrainScope, category?: string | null): boolean {
    if (!text.trim()) return true
    if (category && category !== 'activity' && !scope.sensitive.includes(category as SensitiveCategory)) return true
    if (category === 'activity') return true
    if (SECRETISH.test(text) || hasSecret(text, this.d.secretValues())) return true
    return categoriesOf(text).some((c) => !scope.sensitive.includes(c))
  }

  private topicOk(text: string, scope: BrainScope): boolean {
    if (!scope.topics.length) return true
    const t = text.toLowerCase()
    return scope.topics.some((x) => t.includes(x))
  }

  /** An entity in scope: shared ones (or bot-only ones of the bots named), or exactly the listed ones. */
  entityAllowed(e: StoredEntity | undefined, scope: BrainScope): boolean {
    if (!e || e.isUser) return false
    if (e.scope !== null && !scope.bots.includes(e.scope)) return false
    if (scope.entities !== 'shared' && !scope.entities.includes(e.id)) return false
    return true
  }

  private factVisible(scopeOf: string | null, scope: BrainScope): boolean {
    return scopeOf === null || scope.bots.includes(scopeOf)
  }

  private clean(text: string): string {
    return scrubText(text.replace(/\s+/g, ' ').trim(), this.d.secretValues()).slice(0, 600)
  }

  // ---------------------------------------------------------------- facts

  /** An entity's facts the scope allows, best for `query` first. */
  private entityFacts(e: StoredEntity, scope: BrainScope, query = '', max = 12): BrainFact[] {
    const g = this.d.graph()
    if (!g) return []
    const now = this.now()
    const ts = terms(query)
    const scored: Array<{ f: BrainFact; score: number }> = []
    const topicHay = (t: string): string => `${e.name} ${t}`
    for (const a of g.attributes(e.id)) {
      if (!this.factVisible(a.scope, scope) || !this.sourceAllowed(a.source, scope)) continue
      const text = `${e.name}: ${a.key.replace(/_/g, ' ')} ${a.value}`
      if (this.blockedText(text, scope, a.category) || !this.topicOk(topicHay(`${a.key} ${a.value}`), scope)) continue
      const hay = `${a.key} ${a.value}`.toLowerCase()
      const score = ts.filter((w) => hay.includes(w)).length * 2 + (a.trust === 'user' ? 1 : a.trust === 'observed' ? 0.5 : 0) + Math.max(0, 1 - (now - a.at) / (60 * DAY))
      scored.push({ f: { text: this.clean(text), entity: e.name, trust: a.trust as Trust, source: sourceRef(a.source, a.at, now) }, score })
    }
    for (const r of g.relationViews(e.id, null)) {
      if (r.otherName === 'You' || !this.sourceAllowed(r.source, scope)) continue
      const other = g.entity(r.otherId)
      if (other && !other.isUser && !this.entityAllowed(other, scope) && scope.entities !== 'shared') continue
      if (other && other.scope !== null && !scope.bots.includes(other.scope)) continue
      const text = `${r.outgoing ? e.name : r.otherName} ${r.rel.replace(/_/g, ' ')} ${r.outgoing ? r.otherName : e.name}${r.note ? ` (${r.note})` : ''}`
      if (this.blockedText(text, scope) || !this.topicOk(topicHay(text), scope)) continue
      const score = ts.filter((w) => text.toLowerCase().includes(w)).length * 2 + 0.3
      scored.push({ f: { text: this.clean(text), entity: e.name, trust: r.trust, source: sourceRef(r.source, r.at, now) }, score })
    }
    for (const m of g.mentions(e.id, 12)) {
      if (!this.factVisible(m.scope, scope) || !this.sourceAllowed(m.source, scope)) continue
      const text = m.snippet
      if (this.blockedText(text, scope) || !this.topicOk(topicHay(text), scope)) continue
      const score = ts.filter((w) => text.toLowerCase().includes(w)).length * 2 + Math.max(0, 1.5 - (now - m.at) / (30 * DAY))
      scored.push({ f: { text: this.clean(text), entity: e.name, trust: m.trust, source: sourceRef(m.source, m.at, now) }, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const seen = new Set<string>()
    const out: BrainFact[] = []
    for (const s of scored) {
      const k = s.f.text.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(s.f)
      if (out.length >= max) break
    }
    return out
  }

  /** The entities a question is about (names, aliases, then fact values), in scope only. */
  private entitiesFor(query: string, scope: BrainScope, limit = 4): StoredEntity[] {
    const g = this.d.graph()
    if (!g || !this.d.engineOn()) return []
    const out: StoredEntity[] = []
    try {
      for (const c of lookup(g, query, { spaceId: null, limit: limit * 3 }).cards) if (this.entityAllowed(c.entity, scope) && !out.some((x) => x.id === c.entity.id)) out.push(c.entity)
    } catch { /* the graph is busy: fall through */ }
    // Bot-only entities aren't in the shared view: look them up by name when the scope includes their bot.
    if (out.length < limit && scope.bots.length) {
      const ts = terms(query)
      for (const e of g.entities()) {
        if (out.length >= limit) break
        if (e.scope === null || !this.entityAllowed(e, scope) || out.some((x) => x.id === e.id)) continue
        if (ts.some((w) => e.name.toLowerCase().includes(w))) out.push(e)
      }
    }
    return out.slice(0, limit)
  }

  private noteSections(scope: BrainScope): string[] {
    const secs = ['Shared']
    for (const b of scope.bots) { const s = this.d.vault?.sectionFor(b); if (s) secs.push(s) }
    return secs
  }

  private notes(query: string, scope: BrainScope, k: number): BrainFact[] {
    if (!scope.sources.includes('notes') || !this.d.vault) return []
    let hits: VaultSearchHit[] = []
    try { hits = this.d.vault.search(query, this.noteSections(scope), k * 2) } catch { return [] }
    const out: BrainFact[] = []
    for (const h of hits) {
      if (h.type === 'index' || !h.snippet) continue
      const text = `${h.title}: ${h.snippet}`
      if (this.blockedText(text, scope) || !this.topicOk(text, scope)) continue
      // A note about an entity the scope leaves out stays out too (by its title).
      if (scope.entities !== 'shared' && !this.titleInScope(h.title, scope)) continue
      out.push({ text: this.clean(text), trust: 'user', source: { kind: 'note', label: 'Vault note', title: h.title } })
      if (out.length >= k) break
    }
    return out
  }

  private titleInScope(title: string, scope: BrainScope): boolean {
    const g = this.d.graph()
    if (!g || scope.entities === 'shared') return true
    const t = title.toLowerCase()
    return scope.entities.some((id) => { const e = g.entity(id); return !!e && (t.includes(e.name.toLowerCase()) || g.aliases(id).some((a) => a.kind !== 'email' && a.kind !== 'phone' && t.includes(a.value.toLowerCase()))) })
  }

  private memories(query: string, scope: BrainScope, k: number): BrainFact[] {
    const m = this.d.memory
    if (!scope.sources.includes('memories') || !m?.enabled) return []
    const now = this.now()
    const out: BrainFact[] = []
    for (const x of m.search(query, null, 30)) {
      if (x.spaceId !== null && !scope.bots.includes(x.spaceId)) continue
      if (this.blockedText(x.content, scope) || !this.topicOk(x.content, scope)) continue
      if (scope.entities !== 'shared' && !this.titleInScope(x.content, scope)) continue
      out.push({ text: this.clean(x.content), trust: x.provenance === 'untrusted' ? 'quoted' : 'user', source: { kind: 'memory', label: `Memory · ${chipDate(x.updatedAt, now)}`, date: isoDay(x.updatedAt) } })
      if (out.length >= k) break
    }
    return out
  }

  // ---------------------------------------------------------------- commitments

  private commitmentRows(scope: BrainScope): BrainCommitmentOut[] {
    const g = this.d.graph()
    const now = this.now()
    const out: BrainCommitmentOut[] = []
    let rows: RawCommitment[] = []
    try { rows = this.d.commitments?.() ?? [] } catch { rows = [] }
    for (const c of rows) {
      if (c.status !== 'open') continue
      const e = c.entityId && g ? g.entity(c.entityId) : undefined
      if (c.entityId && !this.entityAllowed(e, scope)) continue
      if (!c.entityId && scope.entities !== 'shared') continue
      const src: FactSource = { kind: 'connector', ref: c.ref, label: '' }
      if (!this.sourceAllowed(src, scope)) continue
      const text = `${c.who} ${c.what}`
      if (this.blockedText(text, scope) || !this.topicOk(`${e?.name ?? ''} ${text}`, scope)) continue
      const ref = sourceRef(src, c.createdAt, now)
      out.push({
        what: this.clean(c.what), owedBy: c.owner === 'user' ? 'you' : c.who, owedTo: c.owner === 'user' ? c.who : 'you',
        ...(c.dueAt ? { due: isoDay(c.dueAt) } : {}), ...(c.dueWords ? { dueWords: c.dueWords.slice(0, 60) } : {}), ...(e ? { entity: e.name } : {}), source: ref
      })
    }
    // Facts that read as a commitment ("due", "promised", "asked for", "next step") on entities in scope.
    if (g && this.d.engineOn()) {
      for (const e of g.entities()) {
        if (!this.entityAllowed(e, scope)) continue
        for (const a of g.attributes(e.id)) {
          if (!COMMIT_KEYS.test(a.key) || !this.factVisible(a.scope, scope) || !this.sourceAllowed(a.source, scope)) continue
          const text = `${e.name} ${a.key} ${a.value}`
          if (this.blockedText(text, scope, a.category) || !this.topicOk(text, scope)) continue
          if (out.some((o) => o.entity === e.name && o.what.toLowerCase() === a.value.toLowerCase())) continue
          const ours = /^(promised|promise|owe|todo|follow_up|next_step|commitment)$/.test(a.key)
          out.push({ what: this.clean(a.value), owedBy: ours ? 'you' : e.name, owedTo: ours ? e.name : 'you', entity: e.name, ...(a.key === 'due' || a.key === 'deadline' ? { dueWords: a.value.slice(0, 60) } : {}), source: sourceRef(a.source, a.at, now) })
        }
      }
    }
    return out
  }

  /** What's owed, by whom, by when (soonest first). `who`: a name to narrow to; `owedBy`: 'you' or 'them'. */
  openCommitments(scope: BrainScope, o: { who?: string; owedBy?: 'you' | 'them' | 'any'; limit?: number } = {}): BrainCommitmentOut[] {
    let list = this.commitmentRows(scope)
    if (o.who?.trim()) {
      const w = o.who.trim().toLowerCase()
      list = list.filter((c) => `${c.entity ?? ''} ${c.owedBy} ${c.owedTo}`.toLowerCase().includes(w))
    }
    if (o.owedBy === 'you') list = list.filter((c) => c.owedBy === 'you')
    if (o.owedBy === 'them') list = list.filter((c) => c.owedBy !== 'you')
    list.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
    return list.slice(0, o.limit ?? 20)
  }

  // ---------------------------------------------------------------- the tools

  /** A question → the answer-ready facts in scope, with their sources (best first). */
  search(question: string, scope: BrainScope, k = 12): { facts: BrainFact[]; entities: Array<{ id: string; name: string; type: string }>; commitments: BrainCommitmentOut[] } {
    const q = question.slice(0, 1000)
    const ents = this.entitiesFor(q, scope)
    const facts: BrainFact[] = []
    for (const e of ents) facts.push(...this.entityFacts(e, scope, q, Math.max(4, Math.ceil(k / Math.max(1, ents.length)))))
    facts.push(...this.notes(q, scope, 4), ...this.memories(q, scope, 4))
    const names = new Set(ents.map((e) => e.name.toLowerCase()))
    const commitments = this.openCommitments(scope).filter((c) => c.entity && names.has(c.entity.toLowerCase())).slice(0, 6)
    const seen = new Set<string>()
    const uniq = facts.filter((f) => { const key = f.text.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true })
    return { facts: uniq.slice(0, k), entities: ents.map((e) => ({ id: e.id, name: e.name, type: e.type })), commitments }
  }

  private roleOf(e: StoredEntity): BrainEntityOut['role'] {
    const g = this.d.graph()!
    const attrs = g.attributes(e.id)
    if (attrs.some(isClientAttr)) return 'client'
    if (e.type === 'person') {
      const org = g.relationViews(e.id, null).find((r) => r.outgoing && r.rel === 'works_at')
      if (org && g.attributes(org.otherId).some(isClientAttr)) return 'client'
      return 'person'
    }
    if (e.type === 'project' || e.type === 'goal') return 'project'
    return 'organization'
  }

  /** The brain's brief, else the "Written for you" section of the entity's vault note. */
  private briefFor(e: StoredEntity, scope: BrainScope): string | undefined {
    let text = ''
    try { text = this.d.brief?.(e.id)?.text ?? '' } catch { text = '' }
    if (!text && e.vaultPath && this.d.vault) {
      const body = this.d.vault.body(e.vaultPath) ?? ''
      const m = /###\s*Written for you[^\n]*\n([\s\S]*?)(?:\n\s*Sources:|\n#{2,3}\s|$)/.exec(body)
      text = m?.[1]?.trim() ?? ''
    }
    if (!text || this.blockedText(text, scope)) return undefined
    return this.clean(text)
  }

  /** A person, client or project by name: its card, brief, facts and sources (null when not in scope). */
  entity(kind: 'person' | 'client' | 'project', name: string, scope: BrainScope): BrainEntityOut | null {
    const g = this.d.graph()
    if (!g || !this.d.engineOn() || !name.trim()) return null
    const fits = (e: StoredEntity): boolean => kind === 'person' ? e.type === 'person' : kind === 'project' ? e.type === 'project' || e.type === 'goal' : this.roleOf(e) === 'client' || e.type === 'organization'
    const want = name.trim().toLowerCase()
    let hit = this.entitiesFor(name, scope, 8).find(fits)
    if (!hit) hit = g.entities().filter((e) => this.entityAllowed(e, scope) && fits(e)).find((e) => e.name.toLowerCase() === want || g.aliases(e.id).some((a) => a.value.toLowerCase() === want))
    if (!hit) return null
    const facts = this.entityFacts(hit, scope, '', 20)
    const related: BrainEntityOut['related'] = []
    for (const r of g.relationViews(hit.id, null)) {
      const o = g.entity(r.otherId)
      if (!o || o.isUser || !this.entityAllowed(o, scope) || !this.sourceAllowed(r.source, scope)) continue
      related.push({ name: o.name, type: o.type, relation: r.rel.replace(/_/g, ' ') })
    }
    const commitments = this.openCommitments(scope).filter((c) => c.entity === hit!.name)
    const sources: BrainSourceRef[] = []
    for (const f of [...facts.map((x) => x.source), ...commitments.map((c) => c.source)]) if (!sources.some((s) => s.label === f.label && s.link === f.link)) sources.push(f)
    const attrs = g.attributes(hit.id)
    const pick = (k: string): string | undefined => { const a = attrs.find((x) => x.key === k && this.factVisible(x.scope, scope) && this.sourceAllowed(x.source, scope) && !this.blockedText(x.value, scope, x.category)); return a?.value }
    const subtitle = [pick('relationship'), pick('role'), pick('kind')].filter(Boolean).join(' · ') || hit.type
    const brief = this.briefFor(hit, scope)
    return { id: hit.id, name: hit.name, type: hit.type, role: this.roleOf(hit), subtitle: this.clean(subtitle), ...(brief ? { brief } : {}), facts, related: related.slice(0, 12), commitments, sources: sources.slice(0, 12) }
  }

  /** Names of entities in scope (for pickers and "who can I ask about"). */
  names(scope: BrainScope, limit = 200): Array<{ id: string; name: string; type: string; role: BrainEntityOut['role'] }> {
    const g = this.d.graph()
    if (!g || !this.d.engineOn()) return []
    return g.entities().filter((e) => this.entityAllowed(e, scope) && ['person', 'organization', 'project', 'goal'].includes(e.type))
      .sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit).map((e) => ({ id: e.id, name: e.name, type: e.type, role: this.roleOf(e) }))
  }
}
