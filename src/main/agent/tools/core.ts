import type { ToolDef } from '../types'
import type { ResultStore } from '../context'
import { milestoneHint, notesTool } from '../notes'
import { isServer, serverToolsNote } from '../../runtime'

export function coreTools(results: ResultStore): ToolDef[] {
  const findTools: ToolDef<{ query: string }> = {
    name: 'find_tools',
    label: 'Tools',
    core: true,
    effect: 'read',
    description: 'Find and load more tools (browser, Gmail, Google Calendar, Google Drive, Semrush and other connectors). Describe what you need, e.g. "browser" or "send email". Matching tools become callable on your next step.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What you need to do or which app' } },
      required: ['query'],
      additionalProperties: false
    },
    async run({ query }, ctx) {
      let hits = ctx.searchTools(query)
      let connected = false
      // An app that isn't connected yet: the user gets a one-click Connect card right in the chat. When
      // built-in tools matched too, only for an app the query names in full ("acme tasks", "google calendar").
      if (ctx.offerConnect) {
        const app = await ctx.offerConnect(query, hits.length ? { fullName: true } : undefined)
        if (app.length) {
          // The app just connected: its tools that match the request, else all of them (the request's words
          // picked the app, e.g. "seo" → Semrush, but needn't appear in its tools' descriptions).
          const own = new Set(app.map((h) => h.name))
          const matching = ctx.searchTools(query).filter((h) => own.has(h.name))
          hits = matching.length ? matching : app
          connected = true
        } else if (!hits.length) return { text: `No connected tools match "${query}". The user chose not to connect an app for this (or none matched). Continue another way${isServer() ? '.' : ': the browser tool works with any website the user is signed into.'}${serverToolsNote()}`, display: `nothing for "${query}"` }
      }
      if (!hits.length) return { text: `No tools match "${query}". Connectors are added under Connect apps${isServer() ? '.' : '; the browser tool works with any website.'}${serverToolsNote()}`, display: `nothing for "${query}"` }
      const toLoad = hits.filter((h) => !h.loaded).slice(0, 8).map((h) => h.name)
      const added = ctx.loadTools(toLoad)
      const lines = hits.slice(0, 8).map((h) => `- ${h.name}: ${h.description.split('\n')[0]}${added.includes(h.name) ? ' (loaded now)' : h.loaded ? ' (already loaded)' : ' (not loaded: tool limit reached)'}`)
      return { text: `${connected ? 'The app is connected now. ' : ''}Tools matching "${query}":\n${lines.join('\n')}${connected && added.length ? '\nThey are callable from your next step: use them now to answer.' : ''}`, display: added.length ? `loaded ${added.join(', ')}` : `searched "${query}"` }
    }
  }

  const connectApp: ToolDef<{ app: string; reason: string }> = {
    name: 'connect_app', label: 'Connect an app', group: 'Connectors', effect: 'read',
    available: (state) => !state.depth,
    description: 'Show a connector tile with a Connect / Sign in button when the app you need is not connected or its login expired. Give the full app name and why this task needs it. The user signs up/signs in on the provider’s page; never ask for passwords in chat. After the tile connects, use its tools. Respect a skip.',
    parameters: { type: 'object', properties: { app: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['app', 'reason'], additionalProperties: false },
    async run({ app, reason }, ctx) {
      if (!ctx.offerConnect) throw new Error('Connectors are unavailable in this session.')
      const ready = ctx.searchTools(app).filter((t) => t.connector)
      const tools = ready.length ? ready : await ctx.offerConnect(app, { reason })
      const added = ctx.loadTools(tools.map((t) => t.name))
      return { text: tools.length ? `${app} is connected. Use these tools now:\n${tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')}` : `No connection to ${app} was established. Continue without it; the user can connect later from Connect apps.`, data: { connected: tools.length > 0, tools: tools.map((t) => t.name), loaded: added }, display: tools.length ? `${app} connected` : `${app} not connected` }
    }
  }

  const readResult: ToolDef<{ id: string; start?: number; end?: number }> = {
    name: 'read_result',
    label: 'Read result',
    // Not in the tool list by default: the truncation note tells the model the exact call, and calling
    // a known tool loads it. That keeps a core slot free.
    group: 'Context',
    effect: 'read',
    description: 'Read part of a long tool result that was cut short. Use the id from the truncation note and a 1-based line range.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        start: { type: 'integer', minimum: 1, description: 'First line (default 1)' },
        end: { type: 'integer', minimum: 1, description: 'Last line (default: as many as fit)' }
      },
      required: ['id'],
      additionalProperties: false
    },
    // outputBudget: a bigger page on a big cloud window (the loop sets it from the window).
    async run({ id, start, end }, ctx) {
      return { text: results.read(id, start, end, ctx.outputBudget), display: `${id}${start ? ` from line ${start}` : ''}` }
    }
  }

  const todo: ToolDef<{ items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }>; notes?: string }> = {
    name: 'todo',
    label: 'Plan',
    core: true,
    effect: 'read',
    description: 'Write or update your task plan. Send the full list every time. Use it for any task with 3 or more steps; mark exactly one item in_progress while you work on it. Never mark an item done while it still has errors, and never re-check work you already marked done. notes: a scratch line of working notes (replaces the previous scratch; up to ~3,000 characters). For facts you must not lose (decisions and why, files, IDs, partial results, open questions, what failed) use the notes tool: its sections are kept word for word when older messages get summarized.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] }
            },
            required: ['text', 'status'],
            additionalProperties: false
          }
        },
        notes: { type: 'string', description: 'Working notes to keep (replaces the previous notes; up to ~3,000 characters)' }
      },
      required: ['items'],
      additionalProperties: false
    },
    async run({ items, notes }, ctx) {
      // Items that just became done: a milestone, where the result says what to record in the notes.
      const wasDone = new Set(ctx.state.todos.filter((t) => t.status === 'done').map((t) => t.text))
      const doneNow = items.filter((i) => i.status === 'done' && !wasDone.has(i.text)).map((i) => i.text)
      ctx.state.todos = items
      if (notes !== undefined) ctx.state.notes = notes.slice(0, 3000)
      const mark = { pending: '[ ]', in_progress: '[>]', done: '[x]' } as const
      const done = items.filter((i) => i.status === 'done').length
      // (Not on the first plan, or when the whole plan is written done at once.)
      const hint = wasDone.size || doneNow.length < items.length ? milestoneHint(doneNow) : ''
      return { text: items.map((i) => `${mark[i.status]} ${i.text}`).join('\n') + hint, display: `${done}/${items.length} done` }
    }
  }

  const askUser: ToolDef<{ question?: string; options?: string[]; default?: string; preference?: boolean; safe?: boolean; questions?: Array<{ question: string; options?: string[]; default?: string }> }> = {
    name: 'ask_user',
    label: 'Question',
    core: true,
    effect: 'read',
    description: 'Ask the user only what blocks progress or is their preference, after researching (memory, notes, files, apps). Up to 3 short options, recommended first ("Weekly (recommended)"); a "type your own" field is added, so never add "Other". Ask everything at once with questions (up to 4).',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One question' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        default: { type: 'string', description: 'Used if no answer in time' },
        preference: { type: 'boolean', description: 'Taste: remembered' },
        safe: { type: 'boolean', description: 'false: risky default' },
        questions: {
          type: 'array', minItems: 1, maxItems: 4, description: 'Several, answered together',
          items: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, maxItems: 3 }, default: { type: 'string' } }, required: ['question'], additionalProperties: false }
        }
      },
      additionalProperties: false
    },
    async run({ question, options, questions, default: dflt, preference, safe }, ctx) {
      // An always-on bot: saved preferences, then the card or the Needs-you queue (it keeps working).
      if (ctx.queueQuestions && (questions?.length || question)) {
        // preference and safe apply to every question of a batch.
        const qs = (questions?.length ? questions : [{ question: question!, options, default: dflt }]).map((q) => ({ ...q, ...(preference !== undefined ? { preference } : {}), ...(safe !== undefined ? { safe } : {}) }))
        const out = await ctx.queueQuestions(qs)
        if (out) return out
      }
      if (questions?.length && ctx.askMany) {
        const raw = await ctx.askMany(questions)
        let answers: string[] = []
        try { answers = JSON.parse(raw) as string[] } catch { answers = questions.map(() => raw) }
        return { text: `User answered:\n${questions.map((q, i) => `${i + 1}. ${q.question}\n   → ${answers[i] || '(no answer: use your best judgment and say what you assumed)'}`).join('\n')}`, display: `${questions.length} questions` }
      }
      if (!question) throw new Error('Give a question, or questions.')
      const answer = await ctx.askUser(question, options)
      return { text: `User answered: ${answer}`, display: question }
    }
  }

  const proposePlan: ToolDef<{ goal: string; steps: string[]; assumptions?: string[]; risks?: string[] }> = {
    name: 'propose_plan',
    label: 'Plan',
    core: true,
    effect: 'read',
    description: 'Show a plan and wait when the user requested plan approval or Plan first is on, or when a consequential choice about the goal genuinely needs their decision. For a clear task, track the work with todo and proceed. Individual actions still use their own approval checks. In the plan, give concrete steps in order (3-15), assumptions, and any irreversible or costly steps. If approved, execute it right away; if the user asks for changes, revise and propose again.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What the finished result will be, in one or two sentences' },
        steps: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 15 },
        assumptions: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        risks: { type: 'array', items: { type: 'string' }, maxItems: 6 }
      },
      required: ['goal', 'steps'],
      additionalProperties: false
    },
    async run(plan, ctx) {
      // Nobody to approve (a schedule or a helper agent): carry on with it.
      const answer = ctx.proposePlan ? await ctx.proposePlan(plan) : 'approve'
      if (/^approve/i.test(answer)) {
        ctx.state.todos = plan.steps.map((text, i) => ({ text, status: i === 0 ? 'in_progress' as const : 'pending' as const }))
        return { text: 'The user approved the plan. It is now your todo list (step 1 in progress). Execute it now, step by step, keeping the todo list updated, without asking again unless something truly needs their decision.', display: 'Plan approved' }
      }
      return { text: `The user wants changes to the plan:\n${answer.replace(/^revise:\s*/i, '')}\nRevise the plan to match and call propose_plan again.`, display: 'Changes requested' }
    }
  }

  return [findTools, connectApp, readResult, todo, notesTool(), askUser, proposePlan]
}
