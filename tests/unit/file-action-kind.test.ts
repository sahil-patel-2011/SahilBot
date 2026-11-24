import { expect, test } from 'vitest'
import { classifyTask } from '../../src/main/llm/task-classifier'

// Agent Arena found these sent down the chat path (no file tools): a request that names a file to write or change.
test('a request to write or change a named file is agent work; asking how stays a reply', () => {
  const kind = (t: string): string => classifyTask(t, {}).kind
  expect(kind('How many ERROR lines in logs/app.log mention "timeout"? Write just the number to answer.txt.')).toBe('agent')
  expect(kind('Set the database in config.json to Postgres or SQLite. Ask me which one first.')).toBe('agent')
  expect(kind('Add my phone number to contacts.csv')).toBe('agent')
  expect(kind('How do I set up package.json for a monorepo?')).toBe('chat')
  expect(kind('What does config.json do?')).toBe('chat')
  expect(kind('Write me a haiku about autumn')).toBe('chat')
})
