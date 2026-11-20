import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { chatgptPlan, closeAll, CODEX_URL } from '../../src/main/llm/codex'
import { samplingFor } from '../../src/main/llm/catalog'
import { streamChat, collectText, type WireMessage } from '../../src/main/llm/client'
import { AppServer } from '../../src/main/llm/codex/rpc'
import { codexEnv } from '../../src/main/llm/codex/detect'

test.skipIf(!process.env.SAHILBOT_LIVE_CONTINUITY)('ChatGPT recalls a random reference after its process exits using the original provider thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sahilbot-plan-continuity-'))
  const marker = randomUUID().slice(0, 13)
  const conversationKey = randomUUID()
  const messages: WireMessage[] = [{ role: 'system', content: 'This is a short conversation recall test.' }, { role: 'user', content: 'Remember the project reference ' + marker + '. Reply with just OK.' }]
  const read = () => collectText(streamChat({ baseUrl: CODEX_URL, model: 'chatgpt-plan/default', messages, conversationKey, sampling: samplingFor('chatgpt-plan/default', {}), maxTokens: 128 }))
  const saved = () => {
    const folder = join(dir, 'subscription-threads')
    return JSON.parse(readFileSync(join(folder, readdirSync(folder)[0]), 'utf8')).id as string
  }
  let created: string | undefined
  chatgptPlan.configure({ dir })
  try {
    await chatgptPlan.connect()
    const answer = await read()
    created = saved()
    await closeAll()
    messages.push({ role: 'assistant', content: answer }, { role: 'user', content: 'What was the project reference? Reply with just its value.' })
    expect(await read()).toContain(marker)
    expect(saved()).toBe(created)
  } finally {
    await closeAll()
    const bin = chatgptPlan.codexBin()
    if (bin && created) {
      const rpc = new AppServer({ bin, args: ['app-server'], env: codexEnv(bin) })
      try { await rpc.initialize('0.1.0'); await rpc.request('thread/archive', { threadId: created }) } finally { rpc.close() }
    }
    chatgptPlan.reset()
  }
})
