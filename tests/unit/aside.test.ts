import { expect, test } from 'vitest'
import { asideSystem, isAside } from '../../src/main/agent/aside'

test('quick side questions are asides; anything that changes the job is steering', () => {
  for (const t of ['What is 9 squared?', '17 × 23', 'how is it going?', "what's the capital of Peru?", 'when will you be done?', '2+2', "what's 9 squared?", "how's it going?", 'can you tell me what time it is?'])
    expect(isAside(t), t).toBe(true)
  for (const t of ['make it 4 printers instead of 3', 'also add prices', 'stop', "don't send the summary", 'what about the HP one?', 'use metric units', 'Research five EVs and compare them', 'thanks!', 'a\nb?', 'Can you save it as a PDF?', 'Could you put it on my Desktop?', 'Can you email it to Sam when done?', 'Will you send it to Bob too?', 'Can you do the report in Spanish?', 'Can you name it budget.xlsx?', 'please make the title bigger?', 'should it be in USD?'])
    expect(isAside(t), t).toBe(false)
})

test('the side answer stays honest about the running job', () => {
  const s = asideSystem({ who: 'Sahil', job: 'Research 3 printers under $1,000', step: 'Reading reviews' })
  expect(s).toContain('Research 3 printers')
  expect(s).toContain('Reading reviews')
  expect(s).toMatch(/never claim results/)
})
