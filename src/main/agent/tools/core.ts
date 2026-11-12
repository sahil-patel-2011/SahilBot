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

  const todo: ToolDef<{ items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }> }> = {
    name: 'todo',
    label: 'Plan',
    core: true,
    effect: 'read',
    description: 'Write or update your task plan. Send the full list every time. Use it for any task with 3 or more steps; mark exactly one item in_progress while you work on it. Never mark an item done while it still has errors, and never re-check work you already marked done.',
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
        }
      },
      required: ['items'],
      additionalProperties: false
    },
    async run({ items }, ctx) {
      ctx.state.todos = items
      const mark = { pending: '[ ]', in_progress: '[>]', done: '[x]' } as const
      const done = items.filter((i) => i.status === 'done').length
      return { text: items.map((i) => `${mark[i.status]} ${i.text}`).join('\n'), display: `${done}/${items.length} done` }
    }
  }

  const askUser: ToolDef<{ question: string; options?: string[] }> = {
    name: 'ask_user',
    label: 'Question',
    core: true,
    effect: 'read',
    description: 'Ask the user a question and wait for the answer. Only when you are blocked on a decision or information you cannot find yourself. Offer 2-4 short options when the choice is clear-cut.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4 }
      },
      required: ['question'],
      additionalProperties: false
    },
    async run({ question, options }, ctx) {
      const answer = await ctx.askUser(question, options)
      return { text: `User answered: ${answer}`, display: question }
    }
  }

  return [findTools, readResult, todo, askUser]
}
