import { describe, expect, test } from 'vitest'
import { classifyTask, requestShape } from '../../src/main/llm/task-classifier'

// Auto's fallback (no LLM read available) also reads how much a request asks, not only its topic words.
describe('request shape', () => {
  test('several asks and constraints make a request harder than its words suggest', () => {
    const s = requestShape('Plan a 5 day trip to Japan for my family of 4 under $6000, with kid-friendly stuff, no more than 2 hours of travel a day, and book the hotels')
    expect(s.constraints).toBeGreaterThanOrEqual(2)
    expect(s.acts).toBe(true)
    expect(requestShape('what is 2+2').tier).toBe(1)
  })

  test('a later step done with tools runs as the agent', () => {
    const trip = classifyTask('Plan a 5 day trip to Japan for my family of 4 under $6000, with kid-friendly stuff, no more than 2 hours of travel a day, and book the hotels')
    expect(trip.kind).toBe('agent')
    expect(trip.difficulty).toBeGreaterThanOrEqual(2)
    const compare = classifyTask('compare the iPhone 18 and Pixel 11 cameras, battery and price, then make me a table and email it to my dad')
    expect(compare.kind).toBe('agent')
    expect(compare.difficulty).toBe(3)
  })

  test('a field list is not a step ("name, email and age")', () => {
    const c = classifyTask('Write a Kotlin data class for a User with name, email and age')
    expect(c.category).toBe('code-quick')
    expect(c.kind).toBe('chat')
    expect(requestShape('Write a Kotlin data class for a User with name, email and age').acts).toBe(false)
  })

  test('pasted material after "…:" is not more asks', () => {
    const text = `Edit this for clarity and cut it to 100 words:\n${'Our quarterly results reflect a period of steady growth. '.repeat(12)}`
    expect(requestShape(text).asks).toBe(1)
    expect(classifyTask(text).difficulty).toBe(1)
  })

  test('small talk and follow-ups keep their own reading', () => {
    expect(classifyTask('thanks!').difficulty).toBe(0)
    expect(classifyTask('yes, do it, then send it', { previousCategory: 'writing', previousTier: 1 }).rule).toMatch(/follow-up/)
  })
})
