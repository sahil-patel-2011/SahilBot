import { describe, expect, test } from 'vitest'
import { planMax, strategyTitle } from '../../src/main/agent/max/planner'
import { maxFit } from '../../src/main/agent/max/auto-teamwork'
import { classifyTask } from '../../src/main/llm/task-classifier'

// Max's strategy planner: which orchestration fits each request (local rules + the task classifier).
const plan = (text: string, attachments?: number) => {
  const c = classifyTask(text, attachments ? { attachments: Array.from({ length: attachments }, (_, i) => ({ kind: 'file', path: `/tmp/f${i}.pdf`, name: `f${i}.pdf` })) as never } : {})
  return planMax(text, { category: c.category, difficulty: c.difficulty, attachments })
}

const CASES: Array<[string, 'team' | 'swarm' | 'heavy' | 'hybrid', number?]> = [
  // Idea swarms: divergent options.
  ['Brainstorm ways to grow my bakery', 'swarm'],
  ['Give me 30 name ideas for a dog-walking startup', 'swarm'],
  ['Come up with slogans for our spring sale', 'swarm'],
  ['What are some creative ways to celebrate a 10 year work anniversary?', 'swarm'],
  ['Brainstorm 20 blog post ideas about urology for patients', 'swarm'],
  ['I need taglines for a coffee shop called Ember', 'swarm'],
  ['Ideas for a science fair project about magnets', 'swarm'],
  ['Give me some gift ideas for my dad who loves fishing', 'swarm'],
  ['Strategy alternatives for entering the Canadian market', 'swarm'],
  ['Think of different approaches to reduce no-shows at the clinic', 'swarm'],
  ['Headlines for a landing page that sells a CAD course', 'swarm'],
  // Research teams: breadth across sources and items.
  ['Research the competitive landscape for AI note-taking apps', 'team'],
  ['Compare the pricing of the top 15 CRM tools for small businesses', 'team'],
  ['Find all the urology practices in Austin and their review scores', 'team'],
  ['Do a comprehensive review of the literature on GLP-1 and kidney stones', 'team'],
  ['Research every state\'s rules on telehealth prescribing', 'team'],
  ['Go through all these documents and summarize the key risks', 'team', 8],
  ['What is the latest research on solid-state batteries? Cite sources.', 'team'],
  ['Market sizing for at-home lab testing in the US', 'team'],
  ['Investigate which FRC teams used swerve drive in 2025 and how they did', 'team'],
  ['Summarize these PDFs', 'team', 6],
  ['Compare 20 vendors for surgical scheduling software across features and price', 'team'],
  // Judged attempts: one hard answer.
  ['Prove that the square root of 2 is irrational', 'heavy'],
  ['Solve this integral: the integral of x^2 e^x dx', 'heavy'],
  ['Debug why my React component re-renders forever when the prop changes', 'heavy'],
  ['There is a race condition in our job queue, find the root cause', 'heavy'],
  ['Should I lease or buy the new ultrasound machine for the practice?', 'heavy'],
  ['Review this contract clause and tell me if it is safe to sign', 'heavy'],
  ['Write my cover letter for the Stanford research internship. It has to be perfect.', 'heavy'],
  ['What is the probability of drawing two aces from a shuffled deck?', 'heavy'],
  ['Optimize this SQL query, it times out on 10M rows', 'heavy'],
  ['Which one should we choose: Postgres or DynamoDB for the new billing service?', 'heavy'],
  ['Draft the investor update for November, get the numbers exactly right', 'heavy'],
  ['Implement a lock-free ring buffer in Rust', 'heavy'],
  ['Fix the bug where the gyro drifts on our FRC robot after 30 seconds', 'heavy'],
  ['How many weighings do you need to find the fake coin among 12?', 'heavy'],
  // Hybrids: explore first, then one judged deliverable.
  ['Brainstorm names for my podcast, then pick the best one', 'hybrid'],
  ['Come up with 20 campaign ideas and then write the launch plan for the strongest', 'hybrid'],
  ['Research the market for home EV chargers and write a recommendation memo', 'hybrid'],
  ['Research the top 10 competitors and then draft our positioning strategy', 'hybrid'],
  ['Give me slogan ideas and choose the single best one for the billboard', 'hybrid'],
  ['Investigate the options for clinic EHR systems and finish with a final recommendation', 'hybrid'],
  ['Brainstorm product ideas for teens, narrow them down to the top one and write a one-pager', 'hybrid'],
  ['Research what other schools do for robotics fundraising, then write a proposal for ours', 'hybrid']
]

describe('Max strategy planner', () => {
  test.each(CASES)('%s → %s', (text, want, files) => {
    const p = plan(text, files)
    expect(p.strategy, `${text} (${JSON.stringify(p.scores)} · ${p.why})`).toBe(want)
    expect(p.title).toBe(strategyTitle(p.strategy, p.phases, p.pattern))
    expect(p.why.length).toBeGreaterThan(3)
  })

  test('covers 40+ requests across all four strategies', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40)
    expect(new Set(CASES.map((c) => c[1]))).toEqual(new Set(['team', 'swarm', 'heavy', 'hybrid']))
  })

  test('hybrids explore first, then judged attempts; titles read as the plan', () => {
    const a = plan('Brainstorm names for my podcast, then pick the best one')
    expect(a.phases).toEqual(['swarm', 'heavy'])
    expect(a.title).toBe('idea swarm → judged final draft')
    const b = plan('Research the market for home EV chargers and write a recommendation memo')
    expect(b.phases).toEqual(['team', 'heavy'])
    expect(b.title).toBe('research team → judged write-up')
    expect(plan('Brainstorm ways to grow my bakery').title).toBe('idea swarm')
    expect(plan('Prove that the square root of 2 is irrational').title).toBe('competing attempts + judge')
  })

  test('a forced strategy wins; nothing stands out → judged attempts', () => {
    expect(planMax('Brainstorm ways to grow my bakery', { forced: 'heavy' }).strategy).toBe('heavy')
    expect(planMax('hello there', {}).strategy).toBe('heavy')
    expect(planMax('tell me about tides', { category: 'research' }).strategy).toBe('team')
  })

  test('Auto (bots and every chat) needs a strong signal: big work only (auto-teamwork.ts)', () => {
    expect(maxFit('thanks!').fit).toBe(false)
    expect(maxFit('what time is it in Tokyo').fit).toBe(false)
    expect(maxFit('fix the typo in my email').fit).toBe(false)
    expect(maxFit('Brainstorm 20 names for my bakery').fit).toBe(true)
    // A small brainstorm with a pick is one agent's work now; a big one is still a hybrid.
    expect(maxFit('Brainstorm names for my podcast, then pick the best one').fit).toBe(false)
    expect(maxFit('Brainstorm 40 names for my podcast, then pick the best one').plan?.strategy).toBe('hybrid')
    expect(maxFit('Compare the pricing of all the CRM tools on the market').plan?.strategy).toBe('team')
  })
})
