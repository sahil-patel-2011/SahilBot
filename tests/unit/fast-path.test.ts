import { describe, expect, test } from 'vitest'
import { classifyTask } from '../../src/main/llm/task-classifier'
import { skipBrain } from '../../src/main/llm/auto-brain'
import { chatEligible } from '../../src/main/agent/registry'
import { intentTools } from '../../src/main/agent/intent'

// The head-to-head report's fast path (PCA-02, ALA-02, ALC-07, BTA-01): quick asks answer at once, the trip plan is
// real work, short writing thinks at Medium, and "make me a bot called X" is one create_bot, not code.

describe('routing', () => {
  test('a trip to plan with its specifics is agent work (a plan, an opening line, the maps tool)', () => {
    for (const q of [
      'Plan a 3-day trip to Savannah for 4 people with a $1,500 budget, with hotels and restaurants.',
      'Plan a weekend trip to Savannah for 4 people, $1,500 total.',
      'Make me a 3-day Savannah itinerary for 4 people under $1,500.'
    ]) {
      const d = classifyTask(q)
      expect(d.kind, q).toBe('agent')
      expect(d.rule, q).toBe('research:travel')
      expect(d.difficulty, q).toBe(2)
    }
    // A question about a trip stays a chat.
    expect(classifyTask('Should I plan a trip to Japan in April?').kind).toBe('chat')
  })

  test('"make me a bot called X" is a SahilBot bot (one create_bot), a Discord bot is still code', () => {
    for (const q of ['Make me a bot called Study Pal', 'Make me a bot called Homework Helper 2 for chemistry and algebra', 'Create a new bot named Coach']) {
      const d = classifyTask(q)
      expect(d.category, q).toBe('agent-tools')
      expect(d.rule, q).toBe('agent-tools:bot')
      expect(d.difficulty, q).toBe(1)
      expect(d.effort, q).toBe('medium')
    }
    for (const q of ['build a Discord bot in Python', 'Make a bot for my Discord server', 'Make me a Telegram bot that posts the weather']) expect(classifyTask(q).category, q).toBe('coding')
  })

  test('a bot named before the word "bot" is a SahilBot bot too; "with its own icon" loads no image generator', () => {
    for (const q of ['Make me a Homework Helper bot for chemistry', 'Can you make me a chemistry tutor bot?', 'Make me a bot called Homework Helper 2 with its own icon']) {
      const d = classifyTask(q)
      expect(d.rule, q).toBe('agent-tools:bot')
      expect(d.kind, q).toBe('agent')
    }
    expect(intentTools('Make me a bot called Homework Helper 2 with its own icon', new Set(['image', 'create_bot']))).not.toContain('image')
    expect(intentTools('Make me a logo image for my bakery', new Set(['image']))).toContain('image')
    for (const q of ['Make me a chat bot for my website', 'build a web app bot']) expect(classifyTask(q).category, q).toBe('coding')
  })

  test('short orders about a bot just made ("Delete it", "undo", "Bring it back", "Give it a 🧪 icon") are agent work, not a quick chat', () => {
    for (const q of ['Delete it', 'Delete it.', 'undo', 'Undo that', 'Bring it back', 'Give it a 🧪 icon', 'Hide it', 'Delete Quizzy']) {
      for (const ctx of [{}, { previousCategory: 'agent-tools' as const, previousKind: 'agent' as const }, { previousCategory: 'chat' as const, previousKind: 'chat' as const }]) {
        const d = classifyTask(q, ctx)
        expect(d.kind, q).toBe('agent')
        expect(d.category, q).toBe('agent-tools')
      }
    }
    // A question about it, or a writing follow-up, is not.
    expect(classifyTask('What does undo do?').kind).toBe('chat')
    expect(classifyTask('Give it a title').kind).toBe('chat')
  })

  test('short writing (a two-line email, a thank-you note, 150 words) is light: Medium, not High', () => {
    for (const q of ['Write a two-line email to my teacher saying I will be late.', 'Write exactly 150 words on why sleep matters.', 'Write a short thank-you note to my neighbor.']) {
      const d = classifyTask(q)
      expect(d.category, q).toBe('writing')
      expect(d.difficulty, q).toBe(1)
      expect(d.effort, q).toBe('medium')
    }
    expect(classifyTask('Write an essay on the causes of WW1').difficulty).toBe(2)
  })
})

describe('no brain read for quick asks', () => {
  test('quiz questions, format asks and short writing start at once; advice and study still get the read', () => {
    for (const q of [
      'What is the boiling point of water in °F?', 'Who wrote Pride and Prejudice?', 'What is the capital of Australia?',
      'Give me 3 bullet points on why exercise matters.', 'Write a tweet under 280 characters about coffee.',
      'Return valid JSON with keys name and age for a fictional person.', 'Write exactly 150 words on why sleep matters.',
      'Write a two-line email to my teacher saying I will be late.'
    ]) expect(skipBrain(q, classifyTask(q), 0), q).toBe(true)
    for (const q of ['Help me study for my chem quiz', 'Explain how vaccines train the immune system', 'What would you call a shop that sells sourdough in the morning?', 'Plan a 3-day trip to Savannah for 4 people with a $1,500 budget']) {
      expect(skipBrain(q, classifyTask(q), 0), q).toBe(false)
    }
    // Something attached: always read.
    expect(skipBrain('What is the capital of Australia?', classifyTask('What is the capital of Australia?'), 1)).toBe(false)
  })

  test('short puzzles and logic, "What year did…" and "Explain … simply" start at once too (PCA-02)', () => {
    for (const q of [
      'Is 97 prime?', 'If a train leaves at 3pm going 60 mph, how far by 5:30pm?',
      'Solve: all bloops are razzies and all razzies are lazzies. Are all bloops lazzies?',
      'What year did WW2 end?', 'Explain photosynthesis simply'
    ]) expect(skipBrain(q, classifyTask(q), 0), q).toBe(true)
  })
})

describe('the chat path in a bot', () => {
  test('a chat whose replies used no tools (a greeting, an intro) is still new', () => {
    expect(chatEligible({ chat: true, state: { todos: [], toolMode: undefined }, newChat: true })).toBe(true)
    expect(chatEligible({ chat: true, state: { todos: [], toolMode: 'full' }, newChat: true })).toBe(false)
  })
})

// PCA-03 / PCA-04: where the one file goes (", save it to Downloads", ", then open it") is part of making it, not a
// second step: an invoice, a budget or a script stays tier 2 (High, no forced double-check round).
describe('a destination is not another step', () => {
  test('save it to Downloads / open it keeps a one-file task at d2, High', () => {
    for (const q of [
      'Make me an invoice PDF for 3 hours of tutoring at $40/hr for Jane Doe, save it to Downloads',
      'Make a Sep–Dec budget in Excel with rent $900, food $300 and a SUM total, save it to my Downloads',
      'Write a Python script that renames my photos by date taken, save it to Downloads as rename_photos.py',
      'Make me an invoice PDF for Jane, then open it'
    ]) {
      const d = classifyTask(q)
      expect(d.difficulty, q).toBe(2)
      expect(d.effort, q).toBe('high')
    }
    // A real second step still counts.
    expect(classifyTask('Make the invoice, then email it to Jane').difficulty).toBe(3)
    expect(classifyTask('Make the invoice PDF, save it to Downloads, then email it to Jane').difficulty).toBe(3)
  })
})
