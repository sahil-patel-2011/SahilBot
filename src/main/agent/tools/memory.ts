import type { Db } from '../../db'
import type { MemoryCategory, MemoryStore } from '../../memory'
import type { SkillStore } from '../../skills'
import type { RuleStore } from '../../rules'
import type { ToolDef } from '../types'

type Args = {
  action: 'save' | 'search' | 'forget' | 'read_skill' | 'save_skill' | 'save_rule'
  fact?: string; category?: MemoryCategory; query?: string; id?: string; about?: 'user' | 'project'
  name?: string; description?: string; steps?: string; rule?: string; applies?: 'everywhere' | 'this_bot' | 'this_project'
}

const SECRETISH = /\b(password|passcode|pin|ssn|social security|credit card|cvv|api key|token|secret)\b/i
const SECRET_VALUE = /\b(password|passcode|api key|secret|token)\s*[:=]\s*\S+/i

export function memoryTool(memory: MemoryStore, db: Db, skills?: SkillStore, rules?: RuleStore): ToolDef<Args> {
  return {
    name: 'memory',
    label: 'Memory',
    core: true,
    effect: (a) => (a.action === 'search' || a.action === 'read_skill' ? 'read' : 'write_local'),
    description: 'Long-term memory shared across chats. save: store a lasting fact as one short sentence: about the user (name, role, location, preferences, people, dates), or, in a project, about the project (decisions, conventions, status) with about="project" so every chat in the project knows it. search: look up saved facts and past conversations (in a project: its chats first). forget: delete a fact by id. read_skill: the full steps of a saved skill (a procedure that worked before) by name. save_skill: write or improve a skill after a task that needed a non-obvious procedure: name (short, dashes), description (when to use it), steps (numbered, exact tools, arguments, gotchas). save_rule: when the user says how they always want something done, save it as a standing rule (name, rule, applies) that every future chat follows. Never save passwords or other secrets.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'search', 'forget', 'read_skill', 'save_skill', 'save_rule'] },
        fact: { type: 'string', description: 'For save: one self-contained sentence with the specifics, e.g. "Works at Urology of Greater Atlanta as marketing lead." or "Alex Chen is the user\'s sister; lives in Austin; alex@example.com."' },
        category: { type: 'string', enum: ['profile', 'work', 'preference', 'location', 'person', 'project', 'trip', 'link', 'date', 'other'], description: 'profile: about the user; person: someone in their life (name, relation, contact, where they live); location: places and addresses; project; trip; link: a URL worth remembering; date: birthdays, deadlines' },
        query: { type: 'string', description: 'For search' },
        id: { type: 'string', description: 'For forget' },
        about: { type: 'string', enum: ['user', 'project'], description: 'For save inside a project: "project" shares it with the project\'s chats; default "user".' },
        name: { type: 'string', description: 'For read_skill and save_skill, e.g. "export-gmail-invoices"' },
        description: { type: 'string', description: 'For save_skill: when to use it, one sentence' },
        steps: { type: 'string', description: 'For save_skill: numbered Markdown steps' },
        rule: { type: 'string', description: 'For save_rule: the instruction to always follow, one or two sentences' },
        applies: { type: 'string', enum: ['everywhere', 'this_bot', 'this_project'], description: 'For save_rule (default everywhere)' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'save' } } }, then: { required: ['fact'] } },
        { if: { properties: { action: { const: 'search' } } }, then: { required: ['query'] } },
        { if: { properties: { action: { const: 'forget' } } }, then: { required: ['id'] } },
        { if: { properties: { action: { const: 'read_skill' } } }, then: { required: ['name'] } },
        { if: { properties: { action: { const: 'save_skill' } } }, then: { required: ['name', 'description', 'steps'] } },
        { if: { properties: { action: { const: 'save_rule' } } }, then: { required: ['name', 'rule'] } }
      ]
    },
    async run(a, ctx) {
      const thread = db.getThread(ctx.threadId)
      const space = thread ? db.getSpace(thread.spaceId) : undefined
      const projectId = space?.kind === 'project' ? space.id : null
      if (a.action === 'save_rule') {
        if (!rules) throw new Error('Rules are not available.')
        if (SECRETISH.test(a.rule!)) throw new Error('Rules never hold secrets.')
        const scope = a.applies === 'this_project' && projectId ? `project:${projectId}` : a.applies === 'this_bot' && space && !space.isMain ? `bot:${space.id}` : 'everywhere'
        const r = rules.save({ name: a.name!, text: a.rule!, scope, category: 'Learned', source: 'learned' })
        return { text: `Saved rule "${r.name}" (${scope === 'everywhere' ? 'all chats' : scope.startsWith('bot') ? 'this bot' : 'this project'}). It applies from the next new chat.`, display: `saved rule "${r.name}"` }
      }
      if (a.action === 'read_skill' || a.action === 'save_skill') {
        if (!skills) throw new Error('Skills are not available.')
        if (a.action === 'read_skill') {
          const sk = skills.get(a.name!)
          if (!sk) return { text: `No skill named "${a.name}". Saved skills:\n${skills.index(100) || '(none)'}`, display: `no skill "${a.name}"` }
          skills.used(sk.name)
          return { text: `# ${sk.name}\n${sk.description}\n\n${sk.body}`, display: `read skill "${sk.name}"` }
        }
        if (SECRET_VALUE.test(a.steps!)) throw new Error('Skills never hold passwords, keys or tokens. Refer to saved logins by name instead.')
        const existing = skills.get(a.name!)
        // Skills the user wrote are theirs: save an improvement under a new name.
        if (existing?.source === 'you') throw new Error(`"${existing.name}" was written by the user; save an improved version under a new name instead.`)
        const sk = skills.save({ name: a.name!, description: a.description!, body: a.steps!, source: 'learned' })
        return { text: `${existing ? 'Updated' : 'Saved'} skill "${sk.name}".`, display: `${existing ? 'updated' : 'saved'} skill "${sk.name}"` }
      }
      if (a.action === 'save') {
        if (SECRETISH.test(a.fact!)) throw new Error('That looks like a secret. Secrets are never stored in memory; saved logins belong in the password vault.')
        const { memory: m, replaced } = memory.save(a.fact!, a.category, a.about === 'project' ? projectId : null)
        return { text: replaced ? `Updated memory ${m.id} (was: "${replaced}").` : `Saved memory ${m.id}.`, display: `saved "${m.content.slice(0, 60)}"` }
      }
      if (a.action === 'forget') {
        return { text: memory.remove(a.id!) ? `Forgot ${a.id}.` : `No memory with id ${a.id}.`, display: `forgot ${a.id}` }
      }
      const facts = memory.search(a.query!, projectId).slice(0, 10)
      const all = db.searchThreads(a.query!).filter((t) => t.id !== ctx.threadId)
      // In a project, its own chats come first.
      const threads = [...all.filter((t) => projectId && t.spaceId === projectId), ...all.filter((t) => !projectId || t.spaceId !== projectId)].slice(0, 5)
      const parts: string[] = []
      parts.push(facts.length ? `Saved facts:\n${facts.map((m) => `- [${m.id}] ${m.content}`).join('\n')}` : 'No saved facts match.')
      if (threads.length) {
        parts.push(`Past conversations:\n${threads.map((t) => {
          const hits = db.listMessages(t.id).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.toLowerCase().includes(a.query!.toLowerCase().split(/\s+/)[0]))
          const snippet = (hits[0]?.content ?? t.lastPreview ?? '').replace(/\s+/g, ' ').slice(0, 300)
          return `- "${t.title}" (${new Date(t.updatedAt).toISOString().slice(0, 10)}): ${snippet}`
        }).join('\n')}`)
      }
      return { text: parts.join('\n\n'), display: `searched "${a.query}"` }
    }
  }
}
