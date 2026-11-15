// Dev helper (performance): time from launching SahilBot to the home screen being usable (composer on
// screen), median of RUNS cold launches with a fresh profile each, plus the main process's own phase log
// (SAHILBOT_TIMING=1, src/main/timing.ts) from the last run. Hidden window.
//   npm run build && SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/startup-timing.test.ts --silent=false
// MAIN=<path to a built out/main/index.js> compares another build (e.g. a copy of out/ from before a change;
// keep the copy inside the project, e.g. node_modules/.cache/, so it still finds node_modules).
import { _electron as electron } from 'playwright'
import { resolve } from 'node:path'
import { test } from 'vitest'
import { tempProfile } from '../accept/app'

const RUNS = Number(process.env.RUNS ?? 5)
const MAIN = resolve(process.env.MAIN ?? 'out/main/index.js')

test('time to a usable window', async () => {
  const times: number[] = []
  /** Renderer: page start → composer on screen (its JS parse, React's first render, the first IPC round trips). */
  const pageTimes: number[] = []
  let log: string[] = []
  for (let i = 0; i < RUNS; i++) {
    const lines: string[] = []
    const t0 = performance.now()
    const app = await electron.launch({
      args: [MAIN],
      env: { ...process.env, FOREMAN_DATA_DIR: tempProfile(), FOREMAN_BASE_URL: 'http://127.0.0.1:9', FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', SAHILBOT_HIDDEN: '1', SAHILBOT_TIMING: '1' } as Record<string, string>
    })
    app.process().stdout?.on('data', (b: Buffer) => lines.push(...String(b).split('\n').filter((l) => l.startsWith('[timing]'))))
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid="composer-input"]')
    times.push(performance.now() - t0)
    pageTimes.push(await page.evaluate(() => performance.now()))
    await page.waitForTimeout(400)
    await app.close()
    log = lines
  }
  const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  console.log(`${MAIN}\nlaunch → composer usable: median ${med(times).toFixed(0)} ms (runs: ${times.map((t) => t.toFixed(0)).join(', ')})`)
  console.log(`renderer page start → composer usable: median ${med(pageTimes).toFixed(0)} ms (runs: ${pageTimes.map((t) => t.toFixed(0)).join(', ')})`)
  if (log.length) console.log(log.join('\n'))
}, 300_000)
