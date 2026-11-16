// Dev helper (Settings redesign): every Settings page, light and dark, at 1280 and 900 wide, as tall shots of
// the whole page (closed disclosures stay closed: that's what most people see). Hidden window; no paid calls.
//   npm run build && SHOTS_DIR=<dir> SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/settings-shots.test.ts --silent=false
// Also writes <dir>/counts.json: per page, the rows, switches, buttons, selects and inputs visible by default.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'

const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'settings-shots')
mkdirSync(out, { recursive: true })

async function tall(page: Page, name: string): Promise<void> {
  for (const w of [1280, 900]) {
    await page.setViewportSize({ width: w, height: 800 })
    await page.waitForTimeout(150)
    const h = await page.evaluate(() => {
      const b = document.querySelector('.set-body') as HTMLElement | null
      return b ? b.scrollHeight + 40 : 1600
    })
    await page.setViewportSize({ width: w, height: Math.min(5000, Math.max(800, h)) })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${out}/${name}-${scheme}-${w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1280, height: 800 })
}

/** What a page shows before anything is expanded: rows and controls outside closed <details>. */
const counts = (page: Page) => page.evaluate(() => {
  const body = document.querySelector('.set-body')!
  const visible = (el: Element): boolean => !el.closest('details:not([open]) > :not(summary)') && (el as HTMLElement).offsetParent !== null
  const n = (sel: string): number => [...body.querySelectorAll(sel)].filter(visible).length
  return {
    rows: n('.set-row, .mm-row, .ll-row'),
    switches: n('[role="switch"], .switch, input[type="checkbox"]'),
    buttons: n('button:not([role="switch"]):not(.switch):not(.mm-text):not(.ui-more)'),
    selects: n('select'),
    inputs: n('input:not([type="checkbox"]), textarea'),
    disclosures: n('details > summary')
  }
})

test('settings: every page, light and dark, 1280 and 900', async () => {
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_MODELS_DIR: mkdtempSync(join(tmpdir(), 'shots-models-')) })
  try {
    await page.evaluate(() => window.foreman.memory.add('Prefers metric units', null))
    await page.evaluate(() => window.foreman.memory.add('Sister Alex lives in Austin', null))
    await page.evaluate(() => window.foreman.memory.add('Training for the Boston marathon in April', null))
    await page.keyboard.press('Meta+,')
    await page.locator('[data-testid="settings"]').waitFor()
    const ids = await page.locator('.set-nav .set-nav-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))
    const all: Record<string, unknown> = {}
    for (const id of ids) {
      await page.click(`[data-testid="${id}"]`)
      await page.waitForTimeout(700)
      all[id] = await counts(page)
      await tall(page, id)
    }
    writeFileSync(join(out, 'counts.json'), JSON.stringify(all, null, 2))
    // Search: the results list, then the jump into Models & Keys → Advanced (when this build has search).
    if (await page.locator('[data-testid="settings-search"]').count()) {
      await page.fill('[data-testid="settings-search"]', 'openrouter')
      await page.waitForTimeout(300)
      for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(200); await page.screenshot({ path: `${out}/search-results-${scheme}-1280.png` }) }
      await page.keyboard.press('Enter')
      await page.waitForTimeout(500)
      for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(200); await page.screenshot({ path: `${out}/search-jump-${scheme}-1280.png` }) }
    }
    console.log(JSON.stringify(all, null, 2))
  } finally {
    await app.close()
    await llm.close()
  }
}, 300_000)
