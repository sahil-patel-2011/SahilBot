import type { ToolDef } from '../types'
import type { ResultStore } from '../context'

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
      if (!hits.length && ctx.offerConnect) {
        // An app that isn't connected yet: the user gets a one-click Connect card right in the chat.
        const added = await ctx.offerConnect(query)
        if (added.length) hits = ctx.searchTools(query)
        else return { text: `No connected tools match "${query}". The user chose not to connect an app for this (or none matched). Continue another way: the browser tool works with any website the user is signed into.`, display: `nothing for "${query}"` }
      }
      if (!hits.length) return { text: `No tools match "${query}". Connectors are added under Connect apps; the browser tool works with any website.`, display: `nothing for "${query}"` }
      const toLoad = hits.filter((h) => !h.loaded).slice(0, 8).map((h) => h.name)
      const added = ctx.loadTools(toLoad)
      const lines = hits.slice(0, 8).map((h) => `- ${h.name}: ${h.description.split('\n')[0]}${added.includes(h.name) ? ' (loaded now)' : h.loaded ? ' (already loaded)' : ' (not loaded: tool limit reached)'}`)
      return { text: `Tools matching "${query}":\n${lines.join('\n')}`, display: added.length ? `loaded ${added.join(', ')}` : `searched "${query}"` }
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
    async run({ id, start, end }) {
      return { text: results.read(id, start, end), display: `${id}${start ? ` from line ${start}` : ''}` }
    }
  }

  const todo: ToolDef<{ items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }>; notes?: string }> = {
    name: 'todo',
    label: 'Plan',
    core: true,
    effect: 'read',
    description: 'Write or update your task plan. Send the full list every time. Use it for any task with 3 or more steps; mark exactly one item in_progress while you work on it. Never mark an item done while it still has errors, and never re-check work you already marked done. notes: your working notes for a long task (key facts, decisions, file paths, IDs, numbers you\'ll need later). They replace the previous notes and are kept even when older messages get summarized, so put anything there you must not lose.',
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
      ctx.state.todos = items
      if (notes !== undefined) ctx.state.notes = notes.slice(0, 3000)
      const mark = { pending: '[ ]', in_progress: '[>]', done: '[x]' } as const
      const done = items.filter((i) => i.status === 'done').length
      return { text: items.map((i) => `${mark[i.status]} ${i.text}`).join('\n'), display: `${done}/${items.length} done` }
    }
  }

  const askUser: ToolDef<{ question?: string; options?: string[]; questions?: Array<{ question: string; options?: string[] }> }> = {
    name: 'ask_user',
    label: 'Question',
    core: true,
    effect: 'read',
    description: 'Ask the user and wait for the answer. Use it for decisions that are theirs to make or information you can\'t find. For a big or unclear task, ask everything you need at once with questions (up to 4, each with 2-4 short options when the choice is clear-cut); don\'t drip questions one at a time.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One question' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        questions: {
          type: 'array', minItems: 1, maxItems: 4, description: 'Several clarifying questions answered together',
          items: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, maxItems: 4 } }, required: ['question'], additionalProperties: false }
        }
      },
      additionalProperties: false
    },
    async run({ question, options, questions }, ctx) {
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
    description: 'Show the user your plan and wait for approval before executing. Use it for big, multi-step, risky or ambiguous tasks (and always when Plan first is on): investigate first with read-only tools, ask clarifying questions if needed, then propose. steps: the concrete steps you will take, in order, in plain words (3-15). assumptions: what you assumed. risks: anything irreversible or costly. If approved, execute it right away; if the user asks for changes, revise and propose again.',
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

  return [findTools, readResult, todo, askUser, proposePlan]
}
