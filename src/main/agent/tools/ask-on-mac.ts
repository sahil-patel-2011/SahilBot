import type { PrivacySpan } from '@shared/privacy'
import { applyAnswer, emptyPrivacy, findings, maskText, type Segment } from '../../privacy/gate'
import type { ToolDef } from '../types'

// Privacy Gate, split mode: the cloud model plans with stand-ins ([PERSON_1]) and asks the local model on
// this Mac about the details it can't see. The local model reads the real conversation; its answer is
// checked by PII-Tracer and masked before it goes back to the cloud model.

type Args = { question: string }

export interface AskOnMacDeps {
  /** The Privacy Gate is on. */
  active(): boolean
  /** The strongest local model, if any. */
  localModel(): string | undefined
  /** Is this a cloud model? */
  isCloud(model: string): boolean
  /** The chat's recent conversation as plain text, unmasked (on this Mac only). */
  transcript(threadId: string): string
  ask(model: string, system: string, user: string, signal: AbortSignal): Promise<string>
  detect(text: string, signal: AbortSignal): Promise<{ spans: PrivacySpan[] }>
}

const SYSTEM = `You run on the user's Mac and help a cloud assistant that cannot see the user's personal details. The conversation below has the real details.
Answer the assistant's question from it: work things out with the real details, but never write a personal detail in your answer (names, emails, phone numbers, addresses, account or ID numbers, dates of birth, passwords or keys, private links). Refer to people and things by role or by the stand-in the assistant used (like [PERSON_1]).
Be concise and factual. If the conversation doesn't contain the answer, say so.`

export function askOnMacTool(d: AskOnMacDeps): ToolDef<Args> {
  return {
    name: 'ask_on_mac',
    label: 'Ask the model on this Mac',
    core: true,
    effect: 'read',
    available: (state) => d.active() && !!d.localModel() && !!state.privacy && (state.privacy.items.some((i) => !i.share) || state.privacy.skipped.length > 0),
    description: 'The Privacy Gate keeps some personal details on the user\'s Mac: you see stand-ins like [PERSON_1] or a withheld note. Ask the local model on the Mac a question about that content (summarize the withheld file, which [PERSON_1] is the client, what the dates in the contract are). It reads the real details and answers without revealing them. Use stand-ins as they are in tool calls and replies: SahilBot puts the real values back on the Mac.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'What you need to know about the private content. Use the stand-ins you see.' } },
      required: ['question'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const local = d.localModel()
      if (!local) throw new Error('No local model is set up on this Mac.')
      if (ctx.model && !d.isCloud(ctx.model)) throw new Error('You already run on this Mac and see the real details: read them in the conversation.')
      const record = ctx.state.privacy ?? emptyPrivacy()
      ctx.state.privacy = record
      // The question may name stand-ins: the local model sees the real values.
      const question = a.question.replace(/\[([A-Z]+)_(\d+)\]/g, (w) => record.items.find((i) => i.placeholder === w)?.value ?? w)
      const answer = (await d.ask(local, SYSTEM, `Conversation:\n${d.transcript(ctx.threadId).slice(-60_000)}\n\nThe assistant asks: ${question}`, ctx.signal)).trim()
      // Anything personal the local model let slip is masked like the rest (and kept on this Mac).
      const segment: Segment = { key: 'ask_on_mac', text: answer, source: 'ask_on_mac answer', index: 0 }
      const slipped = findings(record, [{ segment, spans: (await d.detect(answer, ctx.signal)).spans }])
      if (slipped.length) applyAnswer(record, slipped, { action: 'split', notPersonal: [], remember: false })
      return { text: `The model on the Mac (${local}) says:\n${maskText(answer, record)}`, display: 'asked the model on this Mac' }
    }
  }
}
