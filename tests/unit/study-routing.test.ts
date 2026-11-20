import { afterEach, describe, expect, test } from 'vitest'
import { autoRoute } from '../../src/main/llm/auto-route'
import { autoPreference, isStudy } from '../../src/main/llm/routing-table'
import { classifyTask } from '../../src/main/llm/task-classifier'
import { CLAUDE_MODELS, GROK_MODELS, OPENAI_MODELS, resetPrefs } from '../fixtures/auto-sim'

// School work goes to fast, low-cost models (Haiku 5.5, GPT-6 Luna / Terra), and only the biggest assignments
// to a mid-tier one (Sonnet 5.5 / GPT-6.1 Sol): never Opus or Astra.

afterEach(() => resetPrefs())

const ALL = [...CLAUDE_MODELS, ...OPENAI_MODELS, ...GROK_MODELS]
const LIGHT = new Set(['claude-haiku-5-5', 'gpt-6-luna', 'gpt-6.1-terra'])
const MID = new Set([...LIGHT, 'claude-sonnet-5-5', 'gpt-6.1-sol'])

const route = (text: string, usable = ALL, previousStudy = false) => {
  const task = classifyTask(text, { previousStudy, previousCategory: previousStudy ? 'chat' : undefined })
  return { task, pick: autoRoute({ requested: 'auto', usable, task, preference: 'balanced', budgetTight: false, voice: false }) }
}

describe('school work', () => {
  test.each([
    'Help me study for my chem quiz on stoichiometry',
    'Balance this chemical equation: H2 + O2 -> H2O',
    'Calculate the molar mass of CaCO3',
    'What is the mole ratio of H2O to H2 in 2H2 + O2 -> 2H2O?',
    'Explain mitosis vs meiosis for my bio test',
    'Can you check my algebra homework? 3x + 5 = 20',
    'Make me practice problems for percent composition'
  ])('"%s" is school work on a light model', (text) => {
    for (const usable of [ALL, CLAUDE_MODELS, OPENAI_MODELS]) {
      const { task, pick } = route(text, usable)
      expect(task.signals.study, text).toBe(true)
      // "mole" here is chemistry, not a medical worry.
      expect(task.signals.stakes, text).toBe(false)
      expect(LIGHT.has(pick.model), `${text} → ${pick.model}`).toBe(true)
    }
  })

  test('a big assignment gets a mid-tier model, never the most expensive one', () => {
    const { pick } = route('Write my 2000 word history paper for class on the causes of World War I, thorough and well cited')
    expect(MID.has(pick.model), pick.model).toBe(true)
  })

  test('a follow-up in a school conversation stays on a light model', () => {
    const { task, pick } = route('explain it again but simpler', ALL, true)
    expect(task.signals.study).toBe(true)
    expect(LIGHT.has(pick.model), pick.model).toBe(true)
  })

  test('code is never school work, and real stakes keep their routing', () => {
    expect(route('Fix the failing test in my React app').task.signals.study).toBeFalsy()
    expect(route('I found a new mole on my arm, should I be worried?').task.signals.stakes).toBe(true)
  })

  test.each([
    'I found a new mole on my arm, what could it be?',
    'css selector for class names that start with btn',
    'how do I use ionic with react?',
    'my next.js page fails when it hydrates',
    'write a unit test for my class in TypeScript',
    'write me a LinkedIn bio',
    'build a physics engine in Unity',
    'help me pick a school for my kid'
  ])('"%s" is not school work', (text) => {
    expect(isStudy(route(text).task), text).toBe(false)
  })

  test('Auto defaults to quality and preserves an explicit balanced preference', () => {
    expect(autoPreference({})).toBe('best')
    expect(autoPreference({ cloud: { autoPrefers: 'balanced' } })).toBe('balanced')
    expect(autoPreference({ cloud: { autoPrefers: 'best' } })).toBe('best')
  })
})
