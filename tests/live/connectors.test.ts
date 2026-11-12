import { describe, expect, test } from 'vitest'
import { launch, tempProfile } from '../accept/app'

// Real connections to public MCP servers that need no sign-in (no model calls, free).
// Proves the Connect apps flow works end to end over the internet: connect and list tools.
describe.skipIf(!process.env.LIVE_CONNECTORS)('live: Connect apps', () => {
  test('one-click connect to DeepWiki and Microsoft Learn lists their real tools', async () => {
    const { app, page } = await launch(tempProfile(), 'http://127.0.0.1:9/v1')
    const results = await page.evaluate(async () => {
      const out: Record<string, unknown> = {}
      for (const id of ['deepwiki', 'mslearn']) {
        try { out[id] = await window.foreman.connectors.connectPreset(id) } catch (e) { out[id] = { error: String(e) } }
      }
      return out
    })
    console.log(JSON.stringify(results, null, 2))
    for (const r of Object.values(results) as Array<{ state?: string; tools?: number }>) {
      expect(r.state).toBe('connected')
      expect(r.tools).toBeGreaterThan(0)
    }
    await app.close()
  }, 120_000)
})
