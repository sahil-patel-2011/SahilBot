import type { ToolDef } from '../types'

type Args = { question: string; context: string; kind?: 'plan' | 'stuck' | 'review' | 'best_practice' }

export interface ConsultDeps {
  /** The cloud model to ask, if hybrid mode is on and a key is saved. */
  advisor(): string | undefined
  /** Is this model a cloud model? */
  isCloud(model: string): boolean
  /** One request to the advisor (budget-checked like any cloud request). */
  ask(model: string, system: string, user: string, signal: AbortSignal): Promise<string>
  maxPerRequest(): number
}

const SYSTEM = `You are a senior expert advising a smaller AI agent that runs on the user's Mac and does the actual work with tools (web search, browser, files, terminal, apps).
Give it practical, specific guidance it can act on right away: the best approach, concrete steps, exact commands or settings when relevant, pitfalls to avoid, and how to verify the result.
If it's stuck, diagnose the likely cause first. Be concise (under 350 words). Don't ask questions back; state assumptions.`

/** Hybrid mode: a local model asks a cloud model for a plan, best practice, or help when it's stuck. */
export function consultTool(d: ConsultDeps): ToolDef<Args> {
  return {
    name: 'consult',
    label: 'Ask an expert',
    core: true,
    effect: 'read',
    available: () => !!d.advisor(),
    description: 'Ask a stronger cloud model for advice (hybrid mode). Use it before a big or unfamiliar task (a plan), when you are unsure of the best practice, or when you are stuck after two failed attempts. Send a clear question and the context it needs (the goal, what you tried, exact errors). It only advises; you still do the work. Limited per request, so ask well.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        context: { type: 'string', description: 'Goal, constraints, what you tried, exact errors or results (no passwords or personal data beyond what is needed)' },
        kind: { type: 'string', enum: ['plan', 'stuck', 'review', 'best_practice'] }
      },
      required: ['question', 'context'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const advisor = d.advisor()
      if (!advisor) throw new Error('Hybrid mode is off or no cloud key is saved. Continue on your own.')
      if (ctx.model && d.isCloud(ctx.model)) throw new Error('You are already running on a cloud model; think it through yourself.')
      ctx.state.consults = (ctx.state.consults ?? 0) + 1
      if (ctx.state.consults > d.maxPerRequest()) throw new Error(`You already asked the expert ${d.maxPerRequest()} times for this request. Continue with what you have.`)
      const answer = await d.ask(advisor, SYSTEM, `${a.kind ? `[${a.kind}] ` : ''}${a.question}\n\nContext:\n${a.context.slice(0, 12_000)}`, ctx.signal)
      return { text: `Advice from ${advisor}:\n${answer.trim()}`, display: `asked ${advisor}` }
    }
  }
}
