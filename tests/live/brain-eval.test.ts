import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { acceptBrainModel, brainPrompt, parseBrain } from '../../src/main/llm/auto-brain'
import { collectText, streamChat } from '../../src/main/llm/client'
import { classifyTask } from '../../src/main/llm/task-classifier'
import type { ModelInfo } from '../../src/shared/types'

// How Auto's brain (GPT-6 Luna, no thinking) reads real requests: the difficulty, the model it picks, and whether
// that pick survives the hard limits. A small request should land on a quick model; a real task on a strong one.
// About a cent per run. OPENAI_LIVE_KEY; prints a table.
const KEY = process.env.OPENAI_LIVE_KEY

const m = (id: string, provider: string, tier: 0 | 1 | 2 | 3, input: number, output: number): ModelInfo => ({ id, label: id, provider, providerName: provider, enabled: true, installed: true, vision: true, tools: true, tier, requiredGB: 0, maxFittingWindow: 1_000_000, contextTokens: 1_000_000, fits: true, note: 'remote', price: { input, output } }) as ModelInfo
const MODELS = [
  m('gpt-6-luna', 'openai', 0, 0.1, 0.5), m('gpt-6.1-terra', 'openai', 1, 1, 5), m('gpt-6.1-sol', 'openai', 2, 2, 10), m('gpt-6-astra', 'openai', 3, 10, 50),
  m('claude-haiku-5-5', 'anthropic', 1, 0.1, 0.5), m('claude-sonnet-5-5', 'anthropic', 2, 2, 10), m('claude-opus-5-5', 'anthropic', 3, 4, 20), m('claude-fable-5-2', 'anthropic', 3, 8, 40)
]

// [request, the quickest acceptable tier: 0-1 quick, 2 standard, 3 strongest]
const CASES: Array<[string, number]> = [
  ['What is 17% of 2,340? Just the number and one line of working.', 1],
  ['Write a quick 3-sentence email to my landlord saying rent will be 2 days late this month.', 1],
  ['What did the Federal Reserve decide at its most recent meeting? 3 bullets with sources.', 1],
  ['hi! in two sentences, what can you help me with?', 0],
  ['Translate "where is the train station" into Spanish and French.', 1],
  ['Explain recursion to a 12 year old in one paragraph.', 1],
  ['Convert 72°F to Celsius.', 0],
  ['Give me 5 dinner ideas with chicken and rice.', 1],
  ['Summarize this: The meeting moved to Thursday at 3pm; Ana will present the Q3 numbers and Ben will bring the draft budget.', 1],
  ['Fix the typo in this sentence: "Their going to the store tomorow."', 0],
  ['Compare Notion and Obsidian for a solo student taking class notes: 5 bullet points each, then one recommendation.', 2],
  ['In my workspace, create wordfreq.py with a top_words(text, n) function and a few asserts, run it and show the output.', 2],
  ['Why does this deadlock? Two threads each lock A then B, but one path locks B then A under a timeout.', 2],
  ['Prove that the square root of 2 is irrational.', 2],
  ['Refactor my Electron app to a plugin architecture end to end, with tests, and keep the public API stable.', 3],
  ['Write a comprehensive market research report on AI medical scribes for small practices: top 8 products, pricing, HIPAA, integrations, complaints, and a recommendation. Save it as a PDF.', 3],
  ['Should I lease or buy a $90k ultrasound machine for my practice? I have $40k cash and 8% loan rates.', 2],
  ['Draft a careful reply to this patient complaint about a billing error, apologetic but not admitting liability.', 2]
]

const cost = (x: ModelInfo): number => (x.price ? (3 * x.price.input + x.price.output) / 4 : 0)

describe.skipIf(!KEY)('live: the brain reads requests at the right size', () => {
  test('difficulty and model per request', async () => {
    const rows: string[] = []
    let quickOk = 0, quickN = 0, over = 0
    for (const [text, want] of CASES) {
      const rules = classifyTask(text)
      const { system, user } = brainPrompt({ text, history: [], attachments: [], images: 0, preference: 'balanced', models: MODELS, rules })
      const t0 = Date.now()
      const reply = await collectText(streamChat({ baseUrl: 'https://api.openai.com/v1', apiKey: KEY!, model: 'gpt-6-luna', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 500, effort: 'low', noThinking: true, signal: AbortSignal.timeout(20_000) } as never)).catch((e) => `ERR ${(e as Error).message}`)
      const ms = Date.now() - t0
      const a = parseBrain(reply, MODELS)
      if (!a) { rows.push(`?? ${ms}ms ${text.slice(0, 60)} → ${reply.replace(/\s+/g, " ").slice(0, 700)}`); continue }
      // The table's pick for a light request is the quick model; the hard limit compares against it.
      const table = a.difficulty <= 1 ? MODELS[0] : MODELS.find((x) => x.id === 'claude-sonnet-5-5')!
      const used = acceptBrainModel(a.model, { allowed: MODELS, tablePick: table, preference: 'balanced', difficulty: a.difficulty, fableOn: false }) ?? table
      const tier = MODELS.find((x) => x.id === used.id)!.tier
      if (want <= 1) { quickN++; if (cost(used) <= 1) quickOk++ }
      if (tier > Math.max(want, 1) + 1 || (want <= 1 && cost(used) > 1)) over++
      rows.push(`${want <= 1 && cost(used) > 1 ? 'OVER' : 'ok  '} want ${want} · d${a.difficulty} ${a.effort.padEnd(6)} ${a.model.padEnd(18)} → ${used.id.padEnd(18)} ${a.team}${a.fanout ? ` fan${a.fanout}` : ''} ${ms}ms · ${text.slice(0, 70)}`)
    }
    writeFileSync(process.env.EVAL_OUT ?? join(tmpdir(), "brain-eval.txt"), `\n${rows.join('\n')}\n\nquick requests on a quick model: ${quickOk}/${quickN} · oversized picks: ${over}/${CASES.length}\n`)
  }, 300_000)
})
