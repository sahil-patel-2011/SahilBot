import { describe, expect, test } from 'vitest'
import { businessJob, businessMethod, businessNote, withBusinessMethod } from '../../src/main/agent/max/business-method'
import { maxNote } from '../../src/main/agent/max/decide'
import { planMax } from '../../src/main/agent/max/planner'

// Max's idea swarm and research team carry the business skills' method when the request is ideation or
// validation (helpers can't see the chat or its skill suggestions).

describe('business ideation and validation in Max', () => {
  test('which requests are ideation, validation, or neither', () => {
    expect(businessJob('give me 20 novel startup ideas for urologists that nobody has built')).toBe('ideate')
    expect(businessJob('brainstorm side hustle ideas I could start with $2k')).toBe('ideate')
    expect(businessJob('validate my idea for a dog walking app: would people pay?')).toBe('validate')
    expect(businessJob('what are people complaining about with dental scheduling software')).toBe('validate')
    expect(businessJob('does this business idea already exist?')).toBe('validate')
    expect(businessJob('brainstorm names for my podcast')).toBeNull()
    expect(businessJob('fix the failing login test')).toBeNull()
  })

  test('the method covers complaints, the novelty check against existing products, scores and the next step', () => {
    const m = businessMethod('new business ideas for dentists')!
    expect(m.skills).toEqual(['ideas-new-business', 'business-complaint-mining', 'ideas-novelty-check'])
    for (const w of ['Reddit', 'Product Hunt', 'GitHub', 'Patents', 'already exists as-is', 'Go / Reshape / Kill', 'landing-page', 'interviews', 'pre-sale', 'under ~25 words']) expect(m.method).toContain(w)
  })

  test('swarm context and each team task get the method once', () => {
    const r = withBusinessMethod('startup ideas for vets', { context: 'User is a vet.', tasks: [{ title: 'A', task: 'Mine vet forums' }, { title: 'B', task: 'Check app stores' }] })
    expect(r.context).toMatch(/^User is a vet\.\n\n## Method/)
    expect(r.tasks!.every((t) => t.task.includes('## Method ('))).toBe(true)
    const again = withBusinessMethod('startup ideas for vets', r)
    expect(again.context!.match(/## Method \(/g)!.length).toBe(1)
    expect(withBusinessMethod('write a poem', { context: 'x' })).toEqual({ context: 'x' })
  })

  test('the lead is told to use the skills (idea swarm and research team notes)', () => {
    const p = planMax('brainstorm 30 business ideas for a solo founder', { category: 'chat', difficulty: 2 })
    const note = maxNote(p, { teamMin: 3, teamMax: 6, maxHelpers: 6, text: 'brainstorm 30 business ideas for a solo founder' })
    expect(note).toContain('ideas-new-business')
    expect(note).toContain('novelty check')
    expect(maxNote(p, { teamMin: 3, teamMax: 6, maxHelpers: 6, text: 'write a poem' })).not.toContain('ideas-new-business')
    expect(businessNote('validate my SaaS idea')).toContain('ideas-validate-business')
  })
})
