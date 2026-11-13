import { describe, test } from 'vitest'
import { launch, tempProfile } from '../accept/app'

// What's really on this Mac: model servers, models, what fits, setup picks. No AI calls.
describe.skipIf(!process.env.LIVE_LOCAL)('live: local environment', () => {
  test('list real providers and models', async () => {
    const { app, page } = await launch(tempProfile(), '', { FOREMAN_BASE_URL: '' })
    const r = await page.evaluate(async () => {
      const list = await window.foreman.models.list()
      const picks = await window.foreman.models.setupPicks()
      const found = await window.foreman.detectProviders()
      const gpu = await window.foreman.models.gpu()
      return { providers: list.providers, totalGB: list.totalGB, budgetGB: list.budgetGB, models: list.models.map((m) => `${m.id} [${m.providerName}] installed=${m.installed} enabled=${m.enabled} fits=${m.fits} ${m.requiredGB}GB tier=${m.tier}`), picks: picks.map((p) => `${p.pull} (${p.role}) installed=${p.installed}`), found, gpu }
    })
    console.log('LOCALENV ' + JSON.stringify(r, null, 1))
    await app.close()
  }, 60_000)
})
