import type { BrainScope, BrainSourceRef, TeamQuestion } from '@shared/brain-access'
import { composeAnswer } from './answer'
import { scrubText, type BrainReader } from './reader'

// A teammate's question, answered on the Mac: the brain reader returns only the facts the teammate's
// scope allows, and the answer is written from those alone (answer.ts). What the brain can't answer is
// routed to the owner (Needs you) by the caller; the teammate sees the owner's reply later.

export interface TeamAskDeps {
  reader: Pick<BrainReader, 'search'>
  /** One model call for the wording (local first), or undefined: the facts themselves are the answer. */
  compose?: () => ((system: string, user: string, maxTokens: number) => Promise<string>) | undefined
  secretValues: () => string[]
  owner: () => string
}

export class TeamAsk {
  constructor(private d: TeamAskDeps) {}

  async ask(member: { name: string; scope: BrainScope }, question: string): Promise<{ answer: string; chips: BrainSourceRef[]; status: TeamQuestion['status'] }> {
    const owner = this.d.owner() || 'the owner'
    if (!member.scope.sources.length || (Array.isArray(member.scope.entities) && !member.scope.entities.length)) {
      return { answer: `${owner} hasn’t shared anything with you yet. I’ve passed your question on.`, chips: [], status: 'routed' }
    }
    const found = this.d.reader.search(question, member.scope, 14)
    const a = await composeAnswer({ question, facts: found.facts, commitments: found.commitments, ask: this.d.compose?.(), scrub: (s) => scrubText(s, this.d.secretValues()) })
    if (a.answered) return { answer: a.answer, chips: a.chips, status: 'answered' }
    return { answer: `I couldn’t find that in what ${owner} shared with you, so I’ve asked ${owner}. Their answer will show up here.`, chips: [], status: 'routed' }
  }
}
