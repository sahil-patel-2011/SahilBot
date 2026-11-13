import type { Db } from '../../db'
import { MEMORY_KINDS, SECRETISH, isBotKind, normalizeKind, type Memory, type MemoryKind, type MemoryStore } from '../../memory'
import type { SkillStore } from '../../skills'
import type { RuleStore } from '../../rules'
import type { ToolDef } from '../types'

type Args = {
  action: 'save' | 'list' | 'search' | 'forget' | 'read_skill' | 'save_skill' | 'save_rule'
  fact?: string; category?: string; scope?: 'me' | 'bot'; query?: string; id?: string; all?: boolean
  /** Older name for scope: 'user' = me, 'project' = bot. */
  about?: 'user' | 'project'
  name?: string; description?: string; steps?: string; rule?: string; applies?: 'everywhere' | 'this_bot' | 'this_project'
}

const SECRET_VALUE = /\b(password|passcode|api key|secret|token)\s*[:=]\s*\S+/i

const KIND_TITLE: Record<MemoryKind, string> = {
  profile: 'About you', preference: 'Preferences', rule: 'Rules', person: 'People', location: 'Places', work: 'Work',
  project: 'Projects', trip: 'Trips', date: 'Dates', link: 'Links', fact: 'Other facts', worklog: 'Work log'
}

const quote = (s: string): string => `"${s.length > 140 ? `${s.slice(0, 137)}…` : s}"`

export function memoryTool(memory: MemoryStore, db: Db, skills?: SkillStore, rules?: RuleStore): ToolDef<Args> {
  return {
    name: 'memory',
    label: 'Memory',
    core: true,
    effect: (a) => (a.action === 'search' || a.action === 'list' || a.action === 'read_skill' ? 'read' : 'write_local'),
    // A standing rule changes what every future chat does: always the user's call, in every mode.
    // (Memories and skills ask only when their text came from a web page or email: see memoryRisk.)
    hardStop: (a) => (a.action === 'save_rule' ? `saving a standing rule every chat will follow: "${String(a.rule ?? '').replace(/\s+/g, ' ').slice(0, 160)}"` : null),
    describe: (a) => a.action === 'save_rule' ? `Save the rule "${a.name}": ${String(a.rule ?? '').slice(0, 200)}`
      : a.action === 'save_skill' ? `Save the skill "${a.name}": ${String(a.description ?? '').slice(0, 160)}`
      : a.action === 'save' ? `Remember: ${String(a.fact ?? '').slice(0, 200)}`
      : a.action === 'forget' ? `Forget ${a.id ?? `"${a.query ?? ''}"`}` : `${a.action} memory`,
    description: 'Long-term memory across chats. Each memory is shared ("me": about the user, every bot sees it) or belongs to this bot ("bot": its job rules, decisions, work log). ' +
      'save: one short self-contained sentence with a category; scope defaults to "me" for facts about the user and "bot" for rule and worklog. After meaningful work, save a worklog entry: what was done and where the output is. ' +
      'list: everything remembered (for "what do you remember about me?"). search: saved memories and past conversations. ' +
      'forget: by id, or by query describing it ("lives in Boston"); it removes the clear match and says what was removed, or lists candidates when unsure (all=true removes every strong match). ' +
      'read_skill / save_skill: procedures that worked before (name, description, numbered steps). save_rule: an app-wide standing instruction every chat follows. Never save passwords or other secrets.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'search', 'forget', 'read_skill', 'save_skill', 'save_rule'] },
        fact: { type: 'string', description: 'For save: one self-contained sentence with the specifics, e.g. "Alex Chen is the user\'s sister; lives in Austin." For worklog: what was done and where the output is, e.g. "Drafted the Q4 board memo → ~/Documents/Q4 memo.docx".' },
        category: { type: 'string', enum: MEMORY_KINDS, description: 'profile: who the user is; preference: how they like things; rule: an instruction to follow ("Always ask before sending email"); person; location (places, addresses, time zone); work; project; trip; date (birthdays, deadlines); link; fact; worklog: a dated entry of work done' },
        scope: { type: 'string', enum: ['me', 'bot'], description: 'For save: "me" = about the user, shared with every bot; "bot" = only this bot. Default: bot for rule and worklog (and project inside a project), otherwise me. For list/search/forget: limit to one scope.' },
        query: { type: 'string', description: 'For search, or for forget: words describing the memory to remove' },
        id: { type: 'string', description: 'For forget: a memory id (or several, comma-separated). For save: replace this memory with the new wording.' },
        all: { type: 'boolean', description: 'For forget with query: remove every strong match, not just the best one' },
        name: { type: 'string', description: 'For read_skill, save_skill and save_rule, e.g. "export-gmail-invoices"' },
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
        { if: { properties: { action: { const: 'read_skill' } } }, then: { required: ['name'] } },
        { if: { properties: { action: { const: 'save_skill' } } }, then: { required: ['name', 'description', 'steps'] } },
        { if: { properties: { action: { const: 'save_rule' } } }, then: { required: ['name', 'rule'] } }
      ]
    },
    async run(a, ctx) {
      const thread = db.getThread(ctx.threadId)
      // The bot (or project) this chat belongs to; in a group chat, the bot speaking right now. A group
      // chat without a speaker has no single bot: its saves are shared.
      const space = (ctx.speakerId ? db.getSpace(ctx.speakerId) : undefined) ?? (thread ? db.getSpace(thread.spaceId) : undefined)
      const botId = space && space.kind !== 'group' ? space.id : null
      const botName = space?.kind === 'project' ? `the ${space.name} project` : space?.name ?? 'this bot'
      const projectId = space?.kind === 'project' ? space.id : null
      const where = (m: Memory): string => (m.spaceId ? (m.spaceId === botId ? 'this bot' : db.getSpace(m.spaceId)?.name ?? 'another bot') : 'shared')
      // A bot may change shared memories and its own, never another bot's.
      const mine = (m: Memory): boolean => !m.spaceId || m.spaceId === botId
      const tainted = ctx.provenance === 'web-tainted'
      const from = tainted ? ' (source: web-tainted: its wording came from, or followed, a web page or email this chat read)' : ''

      if (a.action === 'save_rule') {
        if (!rules) throw new Error('Rules are not available.')
        if (SECRETISH.test(a.rule!)) throw new Error('Rules never hold secrets.')
        const scope = a.applies === 'this_project' && projectId ? `project:${projectId}` : a.applies === 'this_bot' && space && !space.isMain ? `bot:${space.id}` : 'everywhere'
        const r = rules.save({ name: a.name!, text: a.rule!, scope, category: 'Learned', source: 'learned' })
        return { text: `Saved rule "${r.name}" (${scope === 'everywhere' ? 'all chats' : scope.startsWith('bot') ? 'this bot' : 'this project'}). It applies from the next new chat.${from}`, display: `saved rule "${r.name}"` }
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
        return { text: `${existing ? 'Updated' : 'Saved'} skill "${sk.name}".${from}`, display: `${existing ? 'updated' : 'saved'} skill "${sk.name}"` }
      }

      const off = !memory.enabled
      const offText = 'Memory is turned off (Settings → Memory), so nothing is saved or recalled. Tell the user if they asked you to remember something.'

      if (a.action === 'save') {
        if (off) return { text: offText, display: 'memory is off' }
        if (SECRETISH.test(a.fact!)) throw new Error('That looks like a secret. Secrets are never stored in memory; saved logins belong in the password vault.')
        const kind = normalizeKind(a.category)
        // Job rules and the work log belong to the bot; in a project, so do its decisions and status.
        const scope = a.scope ?? (a.about === 'project' ? 'bot' : a.about === 'user' ? 'me' : isBotKind(kind) || (kind === 'project' && projectId) ? 'bot' : 'me')
        const spaceId = scope === 'bot' ? botId : null
        if (a.id) {
          const cur = memory.get(a.id.trim())
          if (cur && !mine(cur)) throw new Error(`Memory ${cur.id} belongs to ${where(cur)}, not to this chat. Save a new memory instead.`)
          if (cur) {
            const m = memory.update(cur.id, a.fact!, { category: a.category ? kind : undefined })!
            return { text: `Updated memory ${m.id} (was: ${quote(cur.content)}; now: ${quote(m.content)}).${from} Mention the change briefly in your reply.`, display: `updated "${m.content.slice(0, 60)}"` }
          }
        }
        const { memory: m, replaced } = memory.save(a.fact!, kind, spaceId, 'chat')
        const whereSaved = spaceId ? `for ${botName} only` : 'shared (about the user)'
        return {
          text: `${replaced ? `Updated memory ${m.id} (was: ${quote(replaced)})` : `Saved memory ${m.id}`} as ${m.category}, ${whereSaved}.${from}${m.category === 'worklog' ? '' : ' Mention it briefly in your reply (e.g. "I\'ll remember that…").'}`,
          display: `${m.category === 'worklog' ? 'logged' : replaced ? 'updated' : 'saved'} "${m.content.slice(0, 60)}"`
        }
      }

      if (a.action === 'list') {
        if (off) return { text: offText, display: 'memory is off' }
        let items = memory.list(botId)
        if (a.scope === 'me') items = items.filter((m) => !m.spaceId)
        if (a.scope === 'bot') items = items.filter((m) => m.spaceId)
        if (a.query?.trim()) {
          const keep = new Set(items.map((m) => m.id))
          items = memory.search(a.query, botId, 100).filter((m) => keep.has(m.id))
        }
        if (!items.length) return { text: 'Nothing saved yet.', display: 'nothing saved' }
        const groups = MEMORY_KINDS.map((k) => ({ k, ms: items.filter((m) => m.category === k) })).filter((g) => g.ms.length)
        const lines: string[] = []
        let shown = 0
        for (const g of groups) {
          const ms = g.k === 'worklog' ? g.ms.slice(0, 8) : g.ms
          lines.push(`${KIND_TITLE[g.k]}:`)
          for (const m of ms.slice(0, 60)) {
            lines.push(`- [${m.id}] ${m.content}${m.spaceId ? ` (${where(m)})` : ''}`)
            shown++
          }
        }
        if (shown < items.length) lines.push(`(${items.length - shown} older entries not shown)`)
        lines.push('', 'Tell the user in plain words, grouped like this, without the ids. They can say "forget …" or edit everything in Settings → Memory.')
        return { text: lines.join('\n'), display: `${items.length} memories` }
      }

      if (a.action === 'forget') {
        if (!a.id && !a.query) throw new Error('Give the id of the memory to forget, or a query describing it.')
        if (a.id) {
          const gone: Memory[] = [], missing: string[] = [], others: Memory[] = []
          for (const id of a.id.split(/[\s,]+/).filter(Boolean)) {
            const m = memory.get(id)
            if (m && !mine(m)) others.push(m)
            else if (m && memory.remove(id)) gone.push(m)
            else missing.push(id)
          }
          if (others.length && !gone.length && !a.query) throw new Error(`${others.map((m) => m.id).join(', ')} belong${others.length === 1 ? 's' : ''} to ${where(others[0])}, not to this chat; nothing was removed. The user can remove it in Settings → Memory.`)
          // Wrong ids but a description too: fall back to matching the description.
          if (gone.length || !a.query) {
            const parts: string[] = []
            if (gone.length) parts.push(`Forgot ${gone.length === 1 ? quote(gone[0].content) : `${gone.length} memories:\n${gone.map((m) => `- ${quote(m.content)}`).join('\n')}`}. Confirm to the user exactly what you removed.`)
            if (missing.length) parts.push(`No memory with id ${missing.join(', ')}. Try forget with a query describing it.`)
            if (others.length) parts.push(`Not removed (another bot's): ${others.map((m) => m.id).join(', ')}.`)
            return { text: parts.join('\n'), display: gone.length ? `forgot ${gone.length === 1 ? `"${gone[0].content.slice(0, 50)}"` : `${gone.length} memories`}` : 'nothing to forget' }
          }
        }
        const { removed: visible, candidates } = memory.forget(a.query!, botId, { all: a.all, only: a.scope === 'me' ? 'shared' : a.scope === 'bot' ? 'space' : undefined })
        if (visible.length) {
          return {
            text: `Forgot ${visible.length === 1 ? quote(visible[0].content) : `${visible.length} memories:\n${visible.map((m) => `- ${quote(m.content)}`).join('\n')}`}. Confirm to the user exactly what you removed.`,
            display: `forgot ${visible.length === 1 ? `"${visible[0].content.slice(0, 50)}"` : `${visible.length} memories`}`
          }
        }
        if (candidates.length) {
          return {
            text: `Several memories could match; nothing removed yet:\n${candidates.map((m) => `- [${m.id}] ${m.content}`).join('\n')}\nForget the right one by id (several ids comma-separated), or ask the user which they meant.`,
            display: `${candidates.length} possible matches`
          }
        }
        return { text: `No saved memory matches "${a.query}". Nothing was removed. (If it was something said earlier in this chat, it was never saved.)`, display: 'no match' }
      }

      // search
      const facts = off ? [] : memory.search(a.query!, a.scope === 'me' ? null : botId, 10).filter((m) => a.scope !== 'bot' || m.spaceId)
      const all = db.searchThreads(a.query!).filter((t) => t.id !== ctx.threadId)
      // This bot's (or project's) own chats come first.
      const threads = [...all.filter((t) => botId && t.spaceId === botId), ...all.filter((t) => !botId || t.spaceId !== botId)].slice(0, 5)
      const parts: string[] = []
      parts.push(off ? 'Memory is turned off; only past conversations were searched.' : facts.length ? `Saved memories:\n${facts.map((m) => `- [${m.id}] (${m.category}${m.spaceId ? `, ${where(m)}` : ''}) ${m.content}`).join('\n')}` : 'No saved memories match.')
      if (threads.length) {
        const first = a.query!.toLowerCase().split(/\s+/)[0]
        parts.push(`Past conversations:\n${threads.map((t) => {
          const hits = db.listMessages(t.id).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.toLowerCase().includes(first))
          const snippet = (hits[0]?.content ?? t.lastPreview ?? '').replace(/\s+/g, ' ').slice(0, 300)
          return `- "${t.title}" (${new Date(t.updatedAt).toISOString().slice(0, 10)}): ${snippet}`
        }).join('\n')}`)
      }
      return { text: parts.join('\n\n'), display: `searched "${a.query}"` }
    }
  }
}
