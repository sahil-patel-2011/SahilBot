// Dev helper: screenshots of the clarifying-questions card and the plan approval card (mock model).
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

test('plan screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
  await page.setViewportSize({ width: 1400, height: 900 })
  llm.script.push(
    { toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: 'Who is this for?', options: ['Patients', 'Referring doctors', 'Staff'] }, { question: 'Which format do you want?', options: ['Email newsletter', 'Blog post', 'PDF handout'] }, { question: 'Anything it must mention?' }] }) }] },
    { toolCalls: [{ name: 'propose_plan', arguments: JSON.stringify({ goal: 'A 300-word patient email newsletter about treating an enlarged prostate, in plain words, ready for Dr. Patel to review.', steps: ['Check the current AUA guidance and MedlinePlus', 'Outline: what BPH is, treatment options, when to call us', 'Write the draft (about 300 words, 7th-grade reading level)', 'Fact-check every claim against the sources', 'Save it as a Word document and summarize the key points'], assumptions: ['Sent by email to existing patients', 'Signed by the practice'], risks: ['Medical claims need a physician\'s review before sending'] }) }] }
  )
  await page.click('[data-testid="plan-toggle"]')
  await page.fill('[data-testid="composer-input"]', 'Write this month\'s patient newsletter')
  await page.keyboard.press('Enter')
  await page.locator('[data-testid="questions-card"]').waitFor()
  await page.locator('[data-testid="qcard-option"]', { hasText: 'Patients' }).click()
  await page.locator('[data-testid="qcard-option"]', { hasText: 'Email newsletter' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/p-questions.png` })
  await page.locator('[data-testid="qcard-send"]').click()
  await page.locator('[data-testid="plan-approval"]').waitFor()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/p-plan.png` })
  await app.close()
  await llm.close()
}, 60_000)
