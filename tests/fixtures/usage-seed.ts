import { join } from 'node:path'
import { Db } from '../../src/main/db'
import { Budget } from '../../src/main/llm/budget'

// Seeds a profile's database with usage rows (Settings → Usage acceptance and screenshot tests): 12 weeks of
// cloud requests across Anthropic, OpenAI and xAI (with cached, reasoning and fast-tier detail), two bots, an
// older month and some local replies. Deterministic: the same rows every run, relative to `now`.

const DAY = 86_400_000

export function seedUsage(dataDir: string, now = Date.now()): { bots: string[] } {
  const db = new Db(join(dataDir, 'foreman.db'))
  const budget = new Budget(db, () => 200, () => 'amount')
  const main = db.mainSpace()?.id ?? db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' }).id
  const research = db.createSpace('Research', '#2a78d6').id
  const writer = db.createSpace('Writer', '#7C5CFF').id
  const thread = db.createThread(research, 'auto', null).id
  const models: Array<[string, string, string, number, number, number, number, string | undefined]> = [
    // model, host, provider, prompt, cached share, output, reasoning, tier
    ['claude-opus-5-5', 'api.anthropic.com', 'anthropic', 60_000, 0.85, 3000, 0, undefined],
    ['claude-sonnet-5-5', 'api.anthropic.com', 'anthropic', 40_000, 0.8, 2500, 0, undefined],
    ['gpt-6.1-sol', 'api.openai.com', 'openai', 30_000, 0.6, 4000, 2500, 'fast'],
    ['grok-4.7', 'api.x.ai', 'xai', 20_000, 0.5, 2000, 1500, undefined],
    ['claude-haiku-5-5', 'api.anthropic.com', 'anthropic', 8000, 0.5, 600, 0, undefined]
  ]
  for (let d = 0; d < 84; d++) {
    // A steady rhythm with busier weekdays; some quiet days.
    const day = new Date(now - d * DAY)
    const wd = day.getDay()
    const n = wd === 0 || wd === 6 ? (d % 3) : 2 + ((d * 7) % 4)
    for (let i = 0; i < n; i++) {
      const [model, host, provider, prompt, share, out, reasoning, tier] = models[(d + i) % models.length]
      const scale = 0.6 + ((d * 13 + i * 7) % 10) / 10
      const p = Math.round(prompt * scale)
      const cached = Math.round(p * share)
      const output = Math.round(out * scale)
      const plain = p - cached
      const factor = tier ? 2 : 1
      const read = provider === 'anthropic' ? (model.includes('opus') ? 0.05 : 0.1) : provider === 'openai' ? 0.05 : 0.25
      budget.record(host, model, Math.round((plain + cached * read) * factor), Math.round(output * factor), [research, writer, null][(d + i) % 3], { provider, prompt: p, cached, cacheWrite: 0, output, reasoning: Math.round(reasoning * scale), tier: tier as 'fast' | undefined }, now - d * DAY - i * 3_600_000)
    }
  }
  // Local replies.
  for (let d = 0; d < 20; d += 2) {
    const m = db.insertMessage({ threadId: thread, role: 'assistant', content: 'local', kind: 'normal', status: 'done', model: 'qwen3.8:27b', meta: { promptTokens: 6000, completionTokens: 700 } })
    db.sql.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(now - d * DAY, m.id)
  }
  db.sql.close()
  return { bots: [main, research, writer] }
}
