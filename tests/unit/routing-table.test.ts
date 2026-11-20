import { afterEach, describe, expect, test } from 'vitest'
import type { ModelInfo, Tier } from '@shared/types'
import { rankOf, tierOf } from '../../src/main/llm/catalog'
import { routingPrefs } from '../../src/main/llm/router'
import { ROUTING_TABLE, autoPreference, routeTask, routeTier, slotOf, slotPrice, slotsFor, type RouteOptions } from '../../src/main/llm/routing-table'
import { TASK_CATEGORIES, classifyTask, estimateFileTokens, isChatTask, type TaskCategory, type TaskContext } from '../../src/main/llm/task-classifier'

// Auto's evidence-based routing (docs/model-routing.md): classify the request (local rules), then the
// routing table's ordered candidates across Claude and GPT, under the keys, preference and constraints.

const cloudModel = (id: string, o: Partial<ModelInfo> = {}): ModelInfo => ({
  id, provider: id.startsWith('claude') ? 'anthropic' : 'openai', providerName: id.startsWith('claude') ? 'Anthropic' : 'OpenAI',
  enabled: true, installed: true, tier: tierOf(id), rank: rankOf(id), vision: true, tools: true, requiredGB: 0, maxFittingWindow: 131072, fits: true,
  note: 'remote', contextTokens: id.startsWith('claude') ? 1_000_000 : 1_050_000, label: id, ...o
})
const localModel = (id: string, tier: Tier, o: Partial<ModelInfo> = {}): ModelInfo => ({
  id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, tier, rank: rankOf(id), vision: false, tools: true,
  requiredGB: 8, maxFittingWindow: 65536, fits: true, label: id, ...o
})

const CLAUDE = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map((id) => cloudModel(id))
const FABLE = cloudModel('claude-fable-5-1')
const GPT = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra'].map((id) => cloudModel(id))
const LOCAL = [localModel('lfm3:1.7b', 0), localModel('gemma4:12b', 1, { vision: true }), localModel('qwen3.8:27b', 2, { vision: true })]

const SETUPS: Record<string, ModelInfo[]> = {
  claude: CLAUDE,
  openai: GPT,
  both: [...CLAUDE, ...GPT],
  local: LOCAL,
  all: [...LOCAL, ...CLAUDE, ...GPT]
}

/** The model Auto picks for a request text under a key setup. */
function routed(text: string, setup: keyof typeof SETUPS | ModelInfo[], ctx: TaskContext = {}, o: RouteOptions = {}): string | undefined {
  const models = Array.isArray(setup) ? setup : SETUPS[setup]
  return routeTask(models, classifyTask(text, ctx), { preferCloud: true, fableForHardest: false, ...o })?.model.id
}
const cat = (text: string, ctx: TaskContext = {}): TaskCategory => classifyTask(text, ctx).category

afterEach(() => { routingPrefs.preferCloud = false; routingPrefs.fableForHardest = false })

describe('classifyTask: which kind of task', () => {
  const cases: Record<TaskCategory, string[]> = {
    coding: [
      'Fix the TypeError in src/app.ts where user is undefined',
      'Refactor the auth module to use the new session API and update the tests',
      'Implement pagination for the /users endpoint in our Express backend',
      'The build is failing with a webpack error, can you debug it?',
      'Add a dark mode toggle to the React settings page'
    ],
    'code-quick': [
      'What does git rebase do?',
      'How do I reverse a list in python?',
      'What is the difference between let and const in javascript?',
      'Is SQL case sensitive?'
    ],
    'computer-use': [
      'Open Safari and log in to my bank site',
      'Click the blue button on my screen',
      'Fill out the form on this website with my address',
      'Go to the website amazon.com and add the cheapest HDMI cable to my cart'
    ],
    research: [
      'Research the best CRM tools for small clinics with sources',
      'Do a deep dive on solid-state battery startups and cite your sources',
      'What are the latest developments in fusion energy? Give me a briefing with citations'
    ],
    'long-context': [],
    writing: [
      'Write a cover letter for a product manager role at a startup',
      'Proofread my essay and polish the tone',
      'Draft a heartfelt wedding toast for my brother',
      'Rewrite this paragraph to sound more confident'
    ],
    office: [
      'Make a spreadsheet tracking my monthly budget with formulas',
      'Create a 10 slide deck about our Q3 results',
      'Analyze the data in this CSV and build a chart of sales by region',
      'Build a financial model for a coffee shop in Excel'
    ],
    math: [
      'Prove that there are infinitely many primes',
      'Solve for x: 3x^2 + 5x - 2 = 0 and explain each step',
      'What is the probability of getting two sixes in three dice rolls?',
      'Compute the integral of x*e^x from 0 to 1'
    ],
    vision: [],
    'agent-tools': [
      'Check my inbox and reply to anything urgent from Sam',
      'Schedule a meeting with the design team next Tuesday on my calendar',
      'Remind me to call mom tomorrow at 9',
      'Find the invoice email from Stripe and forward it to accounting'
    ],
    chat: ['hi', 'thanks!', 'good morning', 'What does a VPN do?', 'Tell me a fun fact about otters'],
    voice: [],
    cad: ['Model a 40mm cube with a 10mm through hole in Onshape', 'Export the bracket part as an STL for printing', 'In FreeCAD, add a 2mm fillet to all the outside edges']
  }
  for (const [category, texts] of Object.entries(cases)) {
    for (const text of texts) test(`${category}: ${text}`, () => expect(cat(text)).toBe(category))
  }

  test('images: vision; voice: voice; huge files: long document', () => {
    expect(cat('what is in this picture?', { images: 1 })).toBe('vision')
    expect(cat('describe this screenshot', { attachments: [{ kind: 'image', path: '/x.png', name: 'x.png' }] })).toBe('vision')
    expect(classifyTask('describe it', { images: 1 }).needsVision).toBe(true)
    expect(cat('what is the weather like', { voice: true })).toBe('voice')
    expect(classifyTask('hi', { voice: true }).lowLatency).toBe(true)
    expect(cat('Summarize the key risks in this contract', { inputTokens: 600_000 })).toBe('long-context')
    // A long chat history alone doesn't make a coding request a long-document one; it only needs a big window.
    const c = classifyTask('Fix the failing test in parser.ts', { contextTokens: 600_000 })
    expect(c.category).toBe('coding')
    expect(c.contextTokens).toBe(600_000)
  })

  test('a code project makes "change X" coding; follow-ups keep the kind of task', () => {
    expect(cat('Add a logout button to the header', { codeProject: true })).toBe('coding')
    expect(cat('yes do it', { previousCategory: 'coding', previousTier: 3 })).toBe('coding')
    expect(cat('continue', { previousCategory: 'office', previousTier: 2 })).toBe('office')
  })

  test('modes set the difficulty floor; coding and computer use are never light', () => {
    expect(classifyTask('hi', { heavy: true }).difficulty).toBe(3)
    expect(classifyTask('look into vector databases', { deepResearch: true })).toMatchObject({ category: 'research' })
    expect(classifyTask('what about rust?', { team: true }).difficulty).toBeGreaterThanOrEqual(2)
    expect(classifyTask('rename the variable foo to bar in utils.ts').difficulty).toBeGreaterThanOrEqual(2)
    expect(classifyTask('click the OK button on my screen').difficulty).toBeGreaterThanOrEqual(2)
  })

  test('the routed why names the category (coding runs keep "coding" for their effort)', () => {
    expect(classifyTask('Refactor the whole codebase to a plugin architecture, end to end').why).toMatch(/^coding · /)
    expect(classifyTask('hi').why).toMatch(/^chat/)
  })

  test('chat-mode helper: small talk and quick questions only', () => {
    expect(isChatTask(classifyTask('hi'))).toBe(true)
    expect(isChatTask(classifyTask('What does a VPN do?'))).toBe(true)
    expect(isChatTask(classifyTask('Fix the bug in main.py'))).toBe(false)
    expect(isChatTask(classifyTask('Research the history of the Roman empire with sources'))).toBe(false)
  })

  test('file sizes estimate tokens without reading them', () => {
    expect(estimateFileTokens([{ path: '/a.txt', size: 4000 }])).toBe(1000)
    expect(estimateFileTokens([{ path: '/a.pdf', size: 12_000 }])).toBe(1000)
    expect(estimateFileTokens([{ path: '/a.png', size: 1e6 }])).toBe(0)
  })
})

describe('the routing table', () => {
  test('every category has four tiers of known slots', () => {
    for (const c of TASK_CATEGORIES) {
      expect(ROUTING_TABLE[c].tiers).toHaveLength(4)
      for (const row of ROUTING_TABLE[c].tiers) expect(row.length).toBeGreaterThan(0)
    }
  })
  test('slots: Claude by family, GPT by role; pro and non-chat models have none', () => {
    expect(slotOf('claude-opus-5-5')).toBe('opus')
    expect(slotOf('claude-fable-5-2')).toBe('fable')
    expect(slotOf('claude-mythos-5-1')).toBe('fable')
    expect(slotOf('gpt-6.2-sol')).toBe('sol')
    expect(slotOf('gpt-6.2-astra')).toBe('astra')
    expect(slotOf('openai/gpt-6.1-terra')).toBe('terra')
    expect(slotOf('anthropic/claude-sonnet-5.5')).toBe('sonnet')
    expect(slotOf('gpt-5.5-pro')).toBeUndefined()
    expect(slotOf('qwen3.8:27b')).toBeUndefined()
  })
  test('preferences shift the tier; chat and voice stay quick on Best result', () => {
    expect(routeTier('coding', 2, 'best')).toBe(3)
    expect(routeTier('coding', 2, 'balanced')).toBe(2)
    expect(routeTier('coding', 2, 'cheapest')).toBe(1)
    expect(routeTier('chat', 2, 'best')).toBe(2)
    expect(routeTier('voice', 0, 'best')).toBe(1)
    expect(routeTier('voice', 1, 'best')).toBe(1)
    expect(routeTier('chat', 0, 'cheapest')).toBe(0)
  })
  test('Cheapest orders a row by price; Fable leads only where the evidence puts it first', () => {
    expect(slotsFor('coding', 3, 'cheapest', false).slice(0, 2)).toEqual(['sonnet', 'sol'])
    expect(slotsFor('math', 3, 'balanced', false)[0]).toBe('sol')
    expect(slotsFor('math', 3, 'best', false)[0]).toBe('astra')
    expect(slotsFor('coding', 3, 'best', true)[0]).toBe('fable')
    expect(slotsFor('writing', 3, 'best', true)).not.toContain('fable')
    expect(slotsFor('office', 3, 'best', true)).not.toContain('fable')
    expect(slotsFor('coding', 3, 'cheapest', true)).not.toContain('fable')
  })
  test('the setting: Balanced by default', () => {
    expect(autoPreference({})).toBe('best')
    expect(autoPreference({ cloud: { autoPrefers: 'best' } })).toBe('best')
    expect(autoPreference({ cloud: { autoPrefers: 'nonsense' } })).toBe('best')
  })
})

describe('routeTask: Claude and OpenAI keys', () => {
  const coding = 'Fix the TypeError in src/app.ts where user is undefined'
  test('coding: Claude first (Opus on Best result, Sonnet on Balanced); GPT-only gets Astra / Sol', () => {
    expect(routed(coding, 'both')).toBe('claude-opus-5-5')
    expect(routed(coding, 'both', {}, { preference: 'balanced' })).toBe('claude-sonnet-5-5')
    expect(routed(coding, 'both', {}, { preference: 'cheapest' })).toBe('claude-haiku-5-5')
    // A refactor that also updates the tests is the hardest tier (the difficulty rubric): Opus even on Balanced.
    expect(routed('Refactor the payment service to support refunds and update the unit tests', 'both', {}, { preference: 'balanced' })).toBe('claude-opus-5-5')
    expect(routed(coding, 'claude')).toBe('claude-opus-5-5')
    expect(routed(coding, 'openai')).toBe('gpt-6.2-astra')
    expect(routed(coding, 'openai', {}, { preference: 'balanced' })).toBe('gpt-6.2-sol')
  })
  test('quick code questions: fast models', () => {
    expect(routed('What does git rebase do?', 'both')).toBe('claude-sonnet-5-5')
    expect(routed('What does git rebase do?', 'both', {}, { preference: 'balanced' })).toBe('gpt-6.1-terra')
    expect(routed('What does git rebase do?', 'claude', {}, { preference: 'balanced' })).toBe('claude-haiku-5-5')
  })
  test('computer use: Claude', () => {
    expect(routed('Open Safari and log in to my bank site', 'both')).toBe('claude-opus-5-5')
    expect(routed('Open Safari and click the blue Download button on the page', 'both', {}, { preference: 'balanced' })).toBe('claude-sonnet-5-5')
    // A bank site has stakes: a Balanced close call takes Best result's pick (Opus at 2x Sonnet's price, +2.8 s to
    // the first token, within the 3 s allowance); on GPT, Astra is 5x Sol's price, so Sol stays.
    expect(routed('Open Safari and log in to my bank site', 'both', {}, { preference: 'balanced' })).toBe('claude-opus-5-5')
    expect(routed('Open Safari and log in to my bank site', 'openai', {}, { preference: 'balanced' })).toBe('gpt-6.2-sol')
  })
  test('research: GPT-6.2 Sol for everyday research (even on Best result), GPT-6.2 Astra only for the hardest, Opus with only Claude', () => {
    const text = 'Research the best CRM tools for small clinics with sources'
    expect(classifyTask(text).difficulty).toBe(2)
    expect(routed(text, 'both')).toBe('gpt-6.2-sol')
    expect(routed(text, 'both', {}, { preference: 'balanced' })).toBe('gpt-6.2-sol')
    expect(routed(text, 'openai')).toBe('gpt-6.2-sol')
    expect(routed(text, 'claude')).toBe('claude-opus-5-5')
    // Difficulty 3: Astra on Best result; Balanced keeps Sol (a quarter of the price).
    const deep = 'Do a deep dive on solid-state battery startups and cite your sources'
    expect(classifyTask(deep).difficulty).toBe(3)
    expect(routed(deep, 'both')).toBe('gpt-6.2-astra')
    expect(routed(deep, 'both', {}, { preference: 'balanced' })).toBe('gpt-6.2-sol')
    // Best result lifts research and math to tier 2 at most: Astra's row only at difficulty 3.
    expect(routeTier('research', 2, 'best')).toBe(2)
    expect(routeTier('math', 2, 'best')).toBe(2)
    expect(routeTier('research', 3, 'best')).toBe(3)
    expect(routeTier('research', 1, 'best')).toBe(2)
  })
  test('writing and office work: Claude', () => {
    expect(routed('Write a cover letter for a product manager role at a startup', 'both')).toMatch(/^claude-(opus|sonnet)-5-5$/)
    expect(routed('Proofread my essay and polish the tone', 'openai')).toMatch(/^gpt-/)
    expect(routed('Make a spreadsheet tracking my monthly budget with formulas', 'both')).toBe('claude-opus-5-5')
    expect(routed('Make a spreadsheet tracking my monthly budget with formulas', 'both', {}, { preference: 'balanced' })).toBe('claude-sonnet-5-5')
  })
  test('math and reasoning: GPT (Astra on Best result for the hardest, Sol for the rest); Claude-only gets Opus', () => {
    expect(routed('Prove that there are infinitely many primes', 'both')).toBe('gpt-6.2-astra')
    // Routine math (difficulty 2) is Sol's on Best result too.
    expect(routed('Solve for x: 3x^2 + 5x - 2 = 0 and explain each step', 'both')).toBe('gpt-6.2-sol')
    expect(routed('What is the probability of getting two sixes in three dice rolls?', 'both', {}, { preference: 'balanced' })).toBe('gpt-6.2-sol')
    expect(routed('Prove that there are infinitely many primes', 'claude')).toBe('claude-opus-5-5')
  })
  test('images: GPT-6.1 Sol / Terra or Opus', () => {
    // Analysing an image is standard work (difficulty 2); describing one is light (1).
    expect(routed("What's wrong with my wiring here?", 'both', { images: 1 })).toBe('claude-opus-5-5')
    expect(routed("What's wrong with my wiring here?", 'both', { images: 1 }, { preference: 'balanced' })).toBe('gpt-6.2-sol')
    expect(routed("What's wrong with my wiring here?", 'claude', { images: 1 }, { preference: 'balanced' })).toBe('claude-opus-5-5')
    expect(routed("What's wrong with my wiring here?", 'openai', { images: 1 })).toBe('gpt-6.2-sol')
    expect(routed('what is in this picture?', 'both', { images: 1 }, { preference: 'balanced' })).toBe('gpt-6.1-terra')
  })
  test('tool-heavy connector work: Claude', () => {
    expect(routed('Check my inbox and reply to anything urgent from Sam', 'both')).toBe('claude-opus-5-5')
    expect(routed('Check my inbox and reply to anything urgent from Sam', 'both', {}, { preference: 'balanced' })).toBe('claude-sonnet-5-5')
  })
  test('small talk: fast and cheap', () => {
    expect(routed('hi', 'both')).toBe('claude-sonnet-5-5')
    expect(routed('hi', 'both', {}, { preference: 'balanced' })).toBe('gpt-6-luna')
    expect(routed('hi', 'claude', {}, { preference: 'balanced' })).toBe('claude-haiku-5-5')
    expect(routed('hi', 'both', {}, { preference: 'cheapest' })).toBe('gpt-6-luna')
  })
  test('voice: the quickest first token', () => {
    expect(routed('what time is it in Tokyo', 'both', { voice: true })).toBe('gpt-6.1-terra')
    expect(routed('what time is it in Tokyo', 'claude', { voice: true })).toBe('claude-sonnet-5-5')
    expect(routed('hi', 'both', { voice: true }, { preference: 'balanced' })).toBe('gpt-6-luna')
  })
  test('the routed label says why', () => {
    const p = routeTask(SETUPS.both, classifyTask('Fix the failing test in parser.ts'), { preferCloud: true, preference: 'balanced' })!
    expect(p.label).toBe('claude-sonnet-5-5 · coding')
    expect(p).toMatchObject({ category: 'coding', source: 'table', preference: 'balanced' })
    expect(p.why).toMatch(/coding/)
  })
})

describe('routeTask: constraints and fallbacks', () => {
  test('Fable only with "Use Fable for the hardest tasks", and not where Opus is better', () => {
    const models = [...CLAUDE, FABLE]
    const hard = 'Refactor the whole app architecture to a plugin system, end to end'
    expect(routed(hard, models)).toBe('claude-opus-5-5')
    expect(routed(hard, models, {}, { fableForHardest: true })).toBe('claude-fable-5-1')
    expect(routed('Write a heartfelt wedding toast for my brother, make it perfect', models, {}, { fableForHardest: true })).toBe('claude-opus-5-5')
    // Only Fable on: Auto still uses it rather than nothing.
    expect(routed(hard, [FABLE])).toBe('claude-fable-5-1')
  })
  test('local only: never a cloud model', () => {
    expect(routed('Fix the TypeError in src/app.ts', 'local')).toBe('qwen3.8:27b')
    expect(routed('hi', 'local')).toBe('gemma4:12b')
    expect(routed('hi', 'local', {}, { preference: 'balanced' })).toBe('lfm3:1.7b')
    expect(routed('Fix the TypeError in src/app.ts', 'all', {}, { variant: 'auto:local' })).toBe('qwen3.8:27b')
  })
  test('auto:cloud ignores local models; Local first keeps local for light work, agent work goes to the cloud', () => {
    expect(routed('hi', 'all', {}, { variant: 'auto:cloud', preferCloud: false })).toBe('claude-sonnet-5-5')
    expect(routed('What does a VPN do?', 'all', {}, { preferCloud: false, preference: 'balanced' })).toBe('gemma4:12b')
    expect(routed('What does a VPN do?', 'all', {}, { preferCloud: false })).toBe('qwen3.8:27b')
    // Heavy cloud agent work: the strongest suitable cloud model even on Local first.
    expect(routed('Fix the TypeError in src/app.ts', 'all', {}, { preferCloud: false, preference: 'balanced' })).toBe('claude-sonnet-5-5')
    expect(routed('Fix the TypeError in src/app.ts', 'all', {}, { preferCloud: false })).toBe('claude-opus-5-5')
    expect(routed('Check my inbox and reply to anything urgent from Sam', 'all', {}, { preferCloud: false })).toBe('claude-opus-5-5')
    // No cloud model on: local does the work.
    expect(routed('Fix the TypeError in src/app.ts', 'local', {}, { preferCloud: false })).toBe('qwen3.8:27b')
    // Too hard for the local models: the cloud table.
    expect(routed('Refactor the whole app architecture to a plugin system, end to end', 'all', {}, { preferCloud: false })).toBe('claude-opus-5-5')
  })
  test('Cheapest and a nearly spent budget: free local models first when strong enough', () => {
    expect(routed('Fix the TypeError in src/app.ts', 'all', {}, { preference: 'cheapest' })).toBe('gemma4:12b')
    expect(routed('Fix the TypeError in src/app.ts', 'all', {}, { budgetTight: true })).toBe('gemma4:12b')
    expect(routed('hi', 'all', {}, { preference: 'cheapest' })).toBe('lfm3:1.7b')
    expect(routed('Fix the TypeError in src/app.ts', 'both', {}, { budgetTight: true })).toBe('claude-haiku-5-5')
  })
  test('the first choice switched off: the next candidate', () => {
    const noOpus = [...CLAUDE.filter((m) => !m.id.includes('opus')), ...GPT]
    expect(routed('Refactor the whole app architecture to a plugin system, end to end', noOpus)).toBe('claude-sonnet-5-5')
    const onlyHaiku = [CLAUDE[0]]
    expect(routed('Refactor the whole app architecture to a plugin system, end to end', onlyHaiku)).toBe('claude-haiku-5-5')
  })
  test('images need a model that sees', () => {
    const models = [...LOCAL.map((m) => ({ ...m, vision: false })), localModel('qwen3.5:9b', 1, { vision: true })]
    expect(routed('what is in this picture?', models, { images: 1 })).toBe('qwen3.5:9b')
  })
  test('a close call is priced at the prompt\'s own size: GPT past 272K, Haiku past 100K; Opus flat', () => {
    const astra = cloudModel('gpt-6.2-astra'), opus = cloudModel('claude-opus-5-5'), haiku = cloudModel('claude-haiku-5-5')
    expect(slotPrice(astra)).toBe((3 * 8 + 40) / 4)
    expect(slotPrice(astra, 272_000)).toBe((3 * 8 + 40) / 4)
    expect(slotPrice(astra, 600_000)).toBe((3 * 16 + 60) / 4)
    expect(slotPrice(opus, 600_000)).toBe(slotPrice(opus))
    expect(slotPrice(haiku, 150_000)).toBe((3 * 0.5 + 2.5) / 4)
  })
  test('a huge prompt needs a window that fits it', () => {
    const small = cloudModel('claude-sonnet-5-5', { contextTokens: 200_000 })
    expect(routed('Summarize the key risks in this contract', [small, ...GPT], { inputTokens: 600_000 })).toBe('gpt-6.2-astra')
    // A long document is the hardest tier (the difficulty rubric): Balanced takes the table's hardest row (Opus, else Astra).
    expect(routed('Summarize the key risks in this contract', [small, ...GPT], { inputTokens: 600_000 }, { preference: 'balanced' })).toBe('gpt-6.2-astra')
    // Balanced keeps Opus: past 272K GPT-6.2 Astra bills $16 / $60 per M against Opus's flat $4 / $20, far over a close call's 2x.
    expect(routed('Summarize the key risks in this contract', SETUPS.both, { inputTokens: 600_000 }, { preference: 'balanced' })).toBe('claude-opus-5-5')
    // Local windows (64K here) can't take it: a cloud model, even on Local first.
    expect(routed('Summarize the key risks in this contract', 'all', { inputTokens: 600_000 }, { preferCloud: false })).toBe('gpt-6.2-astra')
    // Nothing fits: the biggest window there is.
    expect(routed('Summarize this', [...LOCAL, localModel('big:32b', 2, { maxFittingWindow: 131072 })], { inputTokens: 600_000 })).toBe('big:32b')
  })
  test('models the table doesn\'t name (OpenRouter by name, older GPT): the tier pick', () => {
    const or = cloudModel('qwen/qwen3.8-max', { provider: 'openrouter', tier: 3, rank: 1 })
    expect(routed('Refactor the whole app architecture to a plugin system, end to end', [or])).toBe('qwen/qwen3.8-max')
    const p = routeTask([or], classifyTask('hi'), { preferCloud: true })!
    expect(p.source).toBe('fallback')
  })
  test('OpenRouter ids of Claude and GPT fill their slots', () => {
    const or = [cloudModel('anthropic/claude-opus-5.5', { provider: 'openrouter', tier: 3 }), cloudModel('openai/gpt-6.2-astra', { provider: 'openrouter', tier: 3 })]
    expect(routed('Refactor the whole app architecture to a plugin system, end to end', or)).toBe('anthropic/claude-opus-5.5')
  })
  test('nothing to route to', () => {
    expect(routeTask([], classifyTask('hi'))).toBeUndefined()
  })
})
