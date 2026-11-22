import { expect, test } from 'vitest'
import { asideSystem, isAside } from '../../src/main/agent/aside'

test('quick side questions are asides; anything that changes the job is steering', () => {
  for (const t of ['What is 9 squared?', '17 × 23', 'how is it going?', "what's the capital of Peru?", 'when will you be done?', '2+2'])
    expect(isAside(t), t).toBe(true)
  for (const t of ['make it 4 printers instead of 3', 'also add prices', 'stop', "don't send the summary", 'what about the HP one?', 'use metric units', 'Research five EVs and compare them', 'thanks!', 'a\nb?'])
    expect(isAside(t), t).toBe(false)
})

test('the side answer stays honest about the running job', () => {
  const s = asideSystem({ who: 'Sahil', job: 'Research 3 printers under $1,000', step: 'Reading reviews' })
  expect(s).toContain('Research 3 printers')
  expect(s).toContain('Reading reviews')
  expect(s).toMatch(/never claim results/)
})
