import { describe, expect, test } from 'vitest'
import { intentTools } from '../../src/main/agent/intent'
import { classifyTask } from '../../src/main/llm/task-classifier'

// "Draw me…" runs as agent work with the image tool already loaded, so the picture gets made on the first step.

describe('image requests', () => {
  const known = new Set(['image', 'code', 'doc_create'])
  test.each([
    'Draw me a cat wearing a space helmet',
    'make a logo for my robotics team',
    'Generate a picture of a sunset over the ocean',
    'Can you create an illustration of the water cycle for my poster?',
    'an image of a red panda reading a book'
  ])('"%s" loads the image tool and runs as the agent', (text) => {
    expect(intentTools(text, known)).toContain('image')
    expect(classifyTask(text).kind).toBe('agent')
  })
  test.each(['What is in this picture?', 'Explain photosynthesis', 'Write a haiku about rain'])('"%s" does not', (text) => {
    expect(intentTools(text, known)).not.toContain('image')
  })
})
