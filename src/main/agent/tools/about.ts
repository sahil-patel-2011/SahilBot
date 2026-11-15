import type { EntityType } from '@shared/context-engine'
import { ENTITY_TYPES } from '@shared/context-engine'
import type { Db } from '../../db'
import type { ContextEngine } from '../../context-engine/service'
import type { ToolDef } from '../types'

// about: the user's world as SahilBot knows it (src/main/context-engine): people, places, organizations,
// projects, events, dates, things, preferences, routines and goals, each fact with where it came from
// and when. lookup answers "who is Priya" / "what do I know about Lisbon"; remember saves a fact the
// user just stated (their word wins over anything learned); forget removes everything about someone or
// something (the user can Undo it in Vault → People & Places). After the run read outside content, a
// remembered fact is kept as quoted (unverified) with this bot only, and forget is refused.

type Args = { action: 'lookup' | 'remember' | 'forget'; query?: string; name?: string; type?: EntityType; key?: string; value?: string; correct?: boolean }

export function aboutTool(deps: { engine: ContextEngine; db: Db }): ToolDef<Args> {
  const botOf = (threadId: string, speakerId?: string): string | null => {
    const sp = deps.db.getSpace(speakerId ?? deps.db.getThread(threadId)?.spaceId ?? '')
    return sp && sp.kind !== 'group' ? sp.id : null
  }
  return {
    name: 'about',
    label: 'People & places',
    group: 'Memory',
    effect: (a) => (a.action === 'lookup' ? 'read' : 'write_local'),
    describe: (a) => a.action === 'remember' ? `Remember about ${a.name}: ${a.key} ${a.value}` : a.action === 'forget' ? `Forget everything about ${a.name ?? a.query}` : `Look up ${a.query ?? a.name}`,
    description: 'What you know about the people, places and things in the user\'s life (people, places, organizations, projects, events, dates, possessions, preferences, routines, goals), each fact with its source and date. ' +
      'The most relevant cards are already in the <context> block. lookup: full cards for a name or topic ("Priya", "Lisbon", "restaurants in Lisbon"). ' +
      'remember: save one fact the user just told you (name, key such as birthday, likes, relationship, role, email, when, where; value); correct=true when they are correcting a wrong fact. ' +
      'forget: everything about someone or something, only when the user asks (they can undo it in Vault → People & Places). Never save passwords, account or ID numbers, or health, money, religion, politics or sexuality details unless the user turned that on.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lookup', 'remember', 'forget'] },
        query: { type: 'string', description: 'For lookup: a name or topic' },
        name: { type: 'string', description: 'For remember and forget: who or what, e.g. "Priya Patel"; "me" for the user' },
        type: { type: 'string', enum: ENTITY_TYPES, description: 'For remember: what it is (default person)' },
        key: { type: 'string', description: 'For remember: e.g. birthday, likes, dislikes, relationship, role, email, phone, when, where, note' },
        value: { type: 'string', description: 'For remember: the fact, e.g. "March 3" or "peonies"' },
        correct: { type: 'boolean', description: 'For remember: the user is correcting a wrong fact (their value replaces it and is never overridden)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const botId = botOf(ctx.threadId, ctx.speakerId)
      const tainted = !!ctx.tainted || ctx.provenance === 'web-tainted'
      if (a.action === 'lookup') {
        const q = (a.query ?? a.name ?? '').trim()
        if (!q) throw new Error('lookup needs a query (a name or topic).')
        const text = deps.engine.about(q, botId)
        return { text, display: `looked up ${q.slice(0, 40)}` }
      }
      if (a.action === 'remember') {
        if (!a.name?.trim() || !a.key?.trim() || !a.value?.trim()) throw new Error('remember needs name, key and value.')
        const text = deps.engine.remember({ name: a.name, type: a.type, key: a.key, value: a.value, spaceId: botId, tainted, threadId: ctx.threadId, correct: a.correct })
        return { text: `${text} Mention it briefly in your reply.`, display: `remembered ${a.name.slice(0, 30)}` }
      }
      const name = (a.name ?? a.query ?? '').trim()
      if (!name) throw new Error('forget needs the name.')
      if (tainted) throw new Error('This run read outside content, so it can\'t forget things on its own. Ask the user to confirm, or they can forget it in Vault → People & Places.')
      const r = deps.engine.forgetByName(name, botId)
      if (r.removed) return { text: `Forgot everything about ${r.removed} (its facts, links and vault note). The user can undo it in Vault → People & Places. Confirm to the user exactly what was removed.`, display: `forgot ${r.removed}` }
      if (r.candidates.length) return { text: `Not sure which one; nothing removed. Candidates: ${r.candidates.join(', ')}. Ask the user which they meant.`, display: 'several matches' }
      return { text: `Nothing saved about "${name}". Nothing was removed.`, display: 'no match' }
    }
  }
}
