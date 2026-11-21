import { expect, test } from 'vitest'
import { resolve } from 'node:path'
import { VIDEO_RE } from '../../src/main/agent/video-intent'
import { classifyTask } from '../../src/main/llm/task-classifier'

test('video requests on any platform are recognized as agent work', () => {
  for (const t of ['Sign in to Vimeo and build a video about our espresso machine', 'Make a hyperrealistic video of a sunrise over Lisbon with Higgsfield', 'Use invideo to make a 30 second ad for the bakery', 'Create a video about the new feature for YouTube']) {
    expect(VIDEO_RE.test(t.toLowerCase()), t).toBe(true)
    expect(classifyTask(t).kind, t).toBe('agent')
  }
  expect(VIDEO_RE.test('what video should i watch tonight')).toBe(false)
})

test('the video-production skill loads and is suggested for a video request', async () => {
  const { SkillStore } = await import('../../src/main/skills')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const store = new SkillStore(mkdtempSync(join(tmpdir(), 'skills-')), resolve('packs/skills'))
  const s = store.list().find((k) => k.name === 'video-production')
  expect(s?.body).toMatch(/Shot list/)
  const hit = store.suggest?.('Sign in to Vimeo and make a hyperrealistic video about our espresso machine', {} as never)
  expect(JSON.stringify(hit ?? '')).toContain('video-production')
})
