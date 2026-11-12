---
name: playwright-testing
description: Write and run end-to-end browser tests with Microsoft Playwright.
source: you
uses: 0
category: Coding
---

1. In the project: `npm i -D @playwright/test && npx playwright install chromium` (asks: it downloads).
2. Create `tests/<feature>.spec.ts` using `test` and `expect` from '@playwright/test'. Prefer role and label locators (`page.getByRole('button', { name: 'Save' })`) over CSS selectors; use web-first assertions (`await expect(locator).toBeVisible()`), never fixed sleeps.
3. Configure `playwright.config.ts` with `webServer` to start the app, and `use: { baseURL }`.
4. Run `npx playwright test --reporter=line`. On failure, read the error and `test-results/`; rerun a single test with `-g "<name>"`.
5. Keep tests independent (each sets up its own data). Report how to run them.
