import { afterAll, describe, expect, test } from 'vitest'
import { HINT_AT, START_AT, teamworkFit } from '../../src/main/agent/max/auto-teamwork'
import { maxDecision } from '../../src/main/agent/max/decide'
import { swarmNote } from '../../src/main/agent/swarm/hosts'
import { classifyTask } from '../../src/main/llm/task-classifier'
import type { MaxStrategy, Settings, Space } from '../../src/shared/types'

// Auto's "does this deserve teamwork?": a simulated prompt set. Small and medium requests stay with one agent;
// big deliverables team up with the right strategy, sized to the task. The rules are general (auto-teamwork.ts):
// nothing here is special-cased.

const fit = (text: string, files = 0, extra: Parameters<typeof teamworkFit>[1] = {}) => {
  const c = classifyTask(text, files ? { attachments: Array.from({ length: files }, (_, i) => ({ kind: 'file', path: `/tmp/f${i}.pdf`, name: `f${i}.pdf` })) as never } : {})
  return teamworkFit(text, { category: c.category, difficulty: c.difficulty, attachments: files, cloud: true, ...extra })
}

// Small and medium: must stay solo.
const SOLO: Array<[string, number?]> = [
  ['hi'],
  ['thanks!'],
  ['what\'s the weather in Austin today?'],
  ['write a quick email to Bob saying I\'ll be late'],
  ['fix this typo: teh quick brown fox'],
  ['summarize this paragraph: The mitochondria is the membrane-bound organelle that generates most of the chemical energy needed to power the cell\'s biochemical reactions. Chemical energy produced by the mitochondria is stored in a small molecule called adenosine triphosphate (ATP). Mitochondria contain their own small chromosomes, and they are thought to have evolved from bacteria, compete for resources, and divide on their own.'],
  ['rename these 3 files to lowercase'],
  ['short tweet ideas for our bakery launch'],
  ['explain recursion briefly'],
  ['fix the off-by-one error in this function: for (let i = 0; i <= n; i++) sum += a[i]'],
  ['what time is it in Tokyo'],
  ['convert 5 miles to km'],
  ['what\'s 15% of 80?'],
  ['translate "good morning" to Spanish'],
  ['write a haiku about autumn'],
  ['give me 5 name ideas for my cat'],
  ['who won the Super Bowl last year?'],
  ['draft a short reply to Sarah thanking her for the meeting'],
  ['add a docstring to this function'],
  ['what does HTTP 404 mean?'],
  ['make this sentence sound more professional: we cant make it friday'],
  ['set a reminder for 3pm to call mom'],
  ['what\'s on my calendar tomorrow?'],
  ['write a one-line commit message for this change'],
  ['tl;dr this article for me'],
  ['rewrite this paragraph to be shorter'],
  ['what\'s the capital of Australia?'],
  ['recommend a good book on habits'],
  ['how do I center a div in CSS?'],
  ['write a regex that matches email addresses'],
  ['compare the iPhone 17 and Pixel 11 cameras quickly'],
  ['write a thank-you note to my teacher'],
  ['list 3 pros and cons of remote work'],
  ['update the README title to SahilBot'],
  ['change the button color to blue in App.tsx'],
  ['what\'s the difference between let and const?'],
  ['give me a brief overview of the French Revolution'],
  ['proofread my cover letter paragraph'],
  ['write a short LinkedIn post about our new hire'],
  ['search the web for the latest iPhone release date'],
  ['make a grocery list for tacos'],
  ['write a SQL query to count users by country'],
  ['explain this error: TypeError: undefined is not a function'],
  ['sort this list alphabetically: pears, apples, kiwis'],
  ['give me a quick summary of today\'s news'],
  ['write a birthday message for my dad'],
  ['open Spotify and play some jazz'],
  ['draft an agenda for tomorrow\'s 30-minute team meeting'],
  ['write a function that reverses a string in Python'],
  ['just give me the answer: is 97 prime?'],
  ['summarize this email thread in 3 bullets'],
  ['what are some good names for a goldfish?'],
  ['check my inbox for anything from Amazon'],
  ['Research the best running shoes for flat feet'],
  ['Write a blog post about spring gardening tips'],
  ['Compare Postgres and MySQL for a small app'],
  ['Explain how transformers work in detail'],
  ['Write a 500-word essay on climate change'],
  ['Refactor this function to use async/await'],
  ['Analyze this spreadsheet and tell me the top 3 products', 1],
  ['Write a short report on today\'s sales numbers'],
  ['Quick competitor check: who are Notion\'s main competitors?'],
  ['Make a brief presentation outline about our Q3 results'],
  ['Debug why my React component re-renders forever when the prop changes'],
  ['Should I lease or buy the new ultrasound machine for the practice?'],
  ['Look over these two PDFs and tell me which offer is better', 2]
]

// Big: must team up, with the strategy that fits. 'start' = Auto turns Max on itself; 'hint' = at least a hint.
const TEAM: Array<[string, MaxStrategy, 'hint' | 'start', number?]> = [
  ['Write a comprehensive market research report on the US at-home lab testing market with competitors and pricing', 'team', 'start'],
  ['Research the competitive landscape for AI note-taking apps and write a detailed report', 'hybrid', 'start'],
  ['Compare the pricing, features and reviews of the top 20 CRM tools for small businesses', 'team', 'start'],
  ['Go through all these documents and summarize the key risks', 'team', 'start', 8],
  ['Summarize these PDFs', 'team', 'start', 12],
  ['Brainstorm 50 names for my coffee brand, then pick the best one', 'hybrid', 'start'],
  ['Prove that there are infinitely many primes of the form 4k+3', 'heavy', 'hint'],
  ['Prove rigorously that every planar graph is 5-colorable', 'heavy', 'start'],
  ['Research every state\'s rules on telehealth prescribing for controlled substances and put them in a table', 'team', 'hint'],
  ['Do a due diligence report on Acme Robotics: team, funding, competitors, market, risks and valuation', 'team', 'start'],
  ['Write a detailed 10-page whitepaper on zero-trust security for hospitals, with sources', 'team', 'start'],
  ['Do a comprehensive literature review on GLP-1 agonists and kidney stones', 'team', 'start'],
  ['Brainstorm 100 blog post ideas for a urology practice', 'swarm', 'start'],
  ['Give me 40 tagline ideas for our spring campaign', 'swarm', 'hint'],
  ['Analyze the competitive landscape of the EV charging industry: key players, market share, pricing and trends', 'team', 'start'],
  ['Write a business plan for a mobile coffee truck: market analysis, competitors, pricing, marketing, and 3-year financials', 'team', 'start'],
  ['Research the top 10 competitors and then draft our positioning strategy', 'hybrid', 'start'],
  ['Find all the urology practices in Austin and compare their review scores, services and prices', 'team', 'hint'],
  ['Compare 25 project management tools across price, integrations and ease of use, then recommend the best one for a 10-person team', 'hybrid', 'start'],
  ['Prepare a thorough market analysis of plant-based protein in Europe with market size, growth, key brands and regulations', 'team', 'start'],
  ['Review all 15 attached contracts and flag unusual clauses', 'team', 'start', 15],
  ['Research the market for home EV chargers and write a recommendation memo', 'hybrid', 'hint'],
  ['Write an in-depth report on the state of solid-state batteries: technology, companies, timelines and investment outlook, with citations', 'team', 'start'],
  ['Solve this carefully, it has to be exactly right: how many ways can 10 people sit around a round table so that no two of 3 given people sit next to each other? Prove the count.', 'heavy', 'start'],
  ['Create a comprehensive onboarding guide for new clinic staff covering scheduling, the EHR, billing, compliance and patient communication', 'team', 'start'],
  ['Build a detailed comparison of every major cloud provider\'s GPU pricing (AWS, GCP, Azure, Oracle, CoreWeave, Lambda)', 'team', 'start'],
  ['Come up with 30 startup ideas in healthcare AI and rank them by feasibility', 'swarm', 'hint'],
  ['Investigate the options for clinic EHR systems across 12 vendors and finish with a final recommendation', 'hybrid', 'start'],
  ['Do a deep dive into the history, current state and future of quantum computing companies: a long report with sources', 'team', 'start'],
  ['Convert the whole codebase from JavaScript to TypeScript across all 40 files in src/', 'team', 'hint'],
  ['Write a 20-page grant proposal for our robotics program with budget, timeline, impact and references', 'team', 'start'],
  ['Create a 15-slide investor deck for our telehealth startup with market size, competitors, traction and financials', 'team', 'start']
]

describe('Auto teamwork: a simulated prompt set', () => {
  // TEAMWORK_REPORT=1 prints every prompt's level, score and label (for calibrating the thresholds).
  afterAll(() => {
    if (!process.env.TEAMWORK_REPORT) return
    for (const [text, files] of [...SOLO, ...TEAM.map((x) => [x[0], x[3]] as [string, number?])]) {
      const f = fit(text, files)
      console.log(`${f.level.padEnd(5)} ${String(f.size).padStart(3)}  ${f.plan?.strategy ?? '-'}  ${f.level === 'solo' ? '' : f.why}  | ${text.slice(0, 70)}`)
    }
  })

  test.each(SOLO)('solo: %s', (text, files) => {
    const f = fit(text, files)
    expect(f.level, `${text} → ${f.level} (${f.size}: ${f.signals.join(', ')})`).toBe('solo')
  })

  test.each(TEAM)('team up: %s → %s (%s)', (text, strategy, level, files) => {
    const f = fit(text, files)
    expect(f.level, `${text} → ${f.level} (${f.size}: ${f.signals.join(', ')})`).not.toBe('solo')
    if (level === 'start') expect(f.level, `${text} (${f.size}: ${f.signals.join(', ')})`).toBe('start')
    expect(f.plan?.strategy, `${text} (${f.plan?.why}; ${JSON.stringify(f.plan?.scores)})`).toBe(strategy)
    // The card's few words: what made it big → who works on it.
    expect(f.why).toMatch(/ → /)
    expect(f.helpers).toBeGreaterThanOrEqual(2)
  })

  test('the set is big enough and covers every strategy', () => {
    expect(SOLO.length + TEAM.length).toBeGreaterThanOrEqual(80)
    expect(SOLO.length).toBeGreaterThanOrEqual(50)
    expect(TEAM.length).toBeGreaterThanOrEqual(30)
    expect(new Set(TEAM.map((t) => t[1]))).toEqual(new Set(['team', 'swarm', 'heavy', 'hybrid']))
    expect(HINT_AT).toBeLessThan(START_AT)
  })

  test('helpers scale with the size of the task, never maxing out', () => {
    const medium = fit('Research the market for home EV chargers and write a recommendation memo')
    const broad = fit('Write a comprehensive market research report on the US at-home lab testing market with competitors and pricing')
    const items = fit('Compare the pricing, features and reviews of the top 20 CRM tools for small businesses')
    const files = fit('Summarize these PDFs', 12)
    expect(medium.helpers).toBe(3)
    expect(broad.helpers!).toBeGreaterThanOrEqual(medium.helpers!)
    expect(items.helpers).toBe(7)
    expect(files.helpers).toBe(4)
    for (const [text, , , n] of TEAM) expect(fit(text, n).helpers!).toBeLessThanOrEqual(10)
    expect(fit('Brainstorm 100 blog post ideas for a urology practice').helpers).toBeLessThanOrEqual(13)
    // The bot's Max helpers caps it.
    expect(fit('Compare the pricing, features and reviews of the top 20 CRM tools for small businesses', 0, { maxHelpers: 4 }).helpers).toBe(4)
    expect(broad.why).toMatch(/^market research → research team of \d+$/)
    expect(fit('Write a detailed 10-page whitepaper on zero-trust security for hospitals, with sources').why).toMatch(/^big whitepaper → research team of \d+$/)
    expect(items.why).toBe('20-item comparison → research team of 7')
    expect(files.why).toBe('12 files → research team of 4')
  })

  test('cost: a tight or nearly spent monthly budget stays solo; under one team\'s cap, only a small hint', () => {
    const big = 'Write a comprehensive market research report on the US at-home lab testing market with competitors and pricing'
    expect(fit(big, 0, { budget: { tight: true } }).level).toBe('solo')
    expect(fit(big, 0, { budget: { leftUsd: 0.5 } }).level).toBe('solo')
    const low = fit(big, 0, { budget: { leftUsd: 3 }, teamCapUsd: 5 })
    expect(low.level).toBe('hint')
    expect(low.helpers).toBeLessThanOrEqual(3)
    expect(fit(big, 0, { budget: { leftUsd: 150 }, teamCapUsd: 5 }).level).toBe('start')
  })

  test('only cloud, attended, non-code work starts by itself; the rest is at most a hint', () => {
    const big = 'Write a comprehensive market research report on the US at-home lab testing market with competitors and pricing'
    expect(fit(big, 0, { cloud: false }).level).toBe('hint')
    expect(fit(big, 0, { unattended: true }).level).toBe('hint')
    expect(fit(big, 0, { planFirst: true }).level).toBe('hint')
    expect(fit('Convert the whole codebase from JavaScript to TypeScript across all 40 files in src/').level).toBe('hint')
  })
})

describe('Auto teamwork through maxDecision', () => {
  const s = {} as Settings
  const project = { id: 'p', kind: 'project', isMain: false } as Space
  const main = { id: 'm', kind: 'bot', isMain: true } as Space
  const bot = { id: 'b', kind: 'bot', isMain: false } as Space
  const big = 'Write a comprehensive market research report on the US at-home lab testing market with competitors and pricing'

  test('a very big task starts Max itself (source auto) in regular chats and bots alike; the plan is sized', () => {
    for (const space of [project, main, bot, undefined]) {
      const d = maxDecision({ settings: s, space, text: big, cloud: true })
      expect(d.source).toBe('auto')
      expect(d.plan).toMatchObject({ strategy: 'team', helpers: expect.any(Number) })
      expect(d.plan?.why).toMatch(/→ research team of/)
    }
  })

  test('a strong-but-not-huge task gets the hint; small ones get nothing', () => {
    const d = maxDecision({ settings: s, space: project, text: 'Research the market for home EV chargers and write a recommendation memo', cloud: true })
    expect(d.plan).toBeUndefined()
    expect(d.hint).toMatch(/Max could help here \(big report|recommendation|→/)
    expect(d.hint).toMatch(/only if it clearly beats doing it yourself/)
    expect(maxDecision({ settings: s, space: project, text: 'write a quick email to Bob', cloud: true })).toEqual({})
    expect(maxDecision({ settings: s, space: bot, text: 'thanks!', cloud: true })).toEqual({})
  })

  test('the bot\'s Max setting stays: Off never teams up by itself, Always runs Max for everything but small talk', () => {
    const off = { botMax: { b: { mode: 'off' } } } as unknown as Settings
    expect(maxDecision({ settings: off, space: bot, text: big, cloud: true })).toEqual({})
    const always = { botMax: { b: { mode: 'always' } } } as unknown as Settings
    expect(maxDecision({ settings: always, space: bot, text: 'write a quick email to Bob', cloud: true }).source).toBe('bot')
    // Group chats: several bots already answer; Auto adds no team (the composer's toggle still can).
    expect(maxDecision({ settings: s, space: { id: 'g', kind: 'group', isMain: false } as Space, text: big, group: true, cloud: true })).toEqual({})
    expect(maxDecision({ settings: s, space: { id: 'g', kind: 'group', isMain: false } as Space, text: big, group: true, max: true }).source).toBe('composer')
  })

  test('another mode on (Heavy, Team of Experts, Deep Research, Council) keeps Auto out of it', () => {
    expect(maxDecision({ settings: s, space: project, text: big, cloud: true, heavy: true })).toEqual({})
    expect(maxDecision({ settings: s, space: project, text: big, cloud: true, team: true })).toEqual({})
    expect(maxDecision({ settings: s, space: project, text: big, cloud: true, deepResearch: true })).toEqual({})
    expect(maxDecision({ settings: s, space: project, text: big, cloud: true, council: true })).toEqual({})
  })

  test('the monthly limit: nearly spent → solo', () => {
    const tight = { spendingMode: 'amount', cloudBudgetUsd: 100 } as unknown as Settings
    expect(maxDecision({ settings: tight, space: project, text: big, cloud: true, budgetLeftUsd: 5 })).toEqual({})
    expect(maxDecision({ settings: tight, space: project, text: big, cloud: true, budgetLeftUsd: 80 }).source).toBe('auto')
  })

  test('bot swarm hints follow the same gate: no swarm hint for small ideation', () => {
    expect(swarmNote(s, bot, 'short tweet ideas for our bakery launch', {})).toEqual({})
    expect(swarmNote(s, bot, 'give me 5 name ideas for my cat', {})).toEqual({})
    expect(swarmNote(s, bot, 'Brainstorm 30 slogans for our spring sale', {}).meta).toEqual({ swarmHint: true })
  })
})
