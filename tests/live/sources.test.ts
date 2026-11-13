import { describe, expect, test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'

// Real calls to PubMed, ClinicalTrials.gov, openFDA, Wikipedia, arXiv and Crossref, driven by the mock
// model (no AI costs). Proves each source works from the app over the internet.
describe.skipIf(!process.env.LIVE_SOURCES)('live: research sources', () => {
  test('every source returns real results', async () => {
    const llm = await startMockLlm()
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    const call = (args: object) => ({ toolCalls: [{ name: 'research', arguments: JSON.stringify(args) }] })
    llm.script.push(
      call({ source: 'pubmed', query: 'tamsulosin benign prostatic hyperplasia', max: 3 }),
      (req) => {
        const pmid = String([...req.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '').match(/PMID (\d+)/)?.[1] ?? '0'
        return call({ source: 'pubmed_abstract', ids: [pmid] })
      },
      call({ source: 'clinical_trials', query: 'kidney stones', max: 2 }),
      call({ source: 'drug_label', query: 'tamsulosin' }),
      call({ source: 'wikipedia', query: 'Ohm\'s law' }),
      call({ source: 'arxiv', query: 'printed circuit board routing', max: 2 }),
      call({ source: 'doi', ids: ['10.1038/nature14539'] }),
      { content: 'done' }
    )
    await page.fill('[data-testid="composer-input"]', 'test the sources')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 90_000 }).toContain('done')
    const outs = llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))
    const show = outs.map((o: string) => o.replace(/<[^>]+>/g, '').slice(0, 220).replace(/\s+/g, ' '))
    console.log(show.join('\n---\n'))
    expect(outs[0]).toMatch(/PMID \d+/)
    expect(outs[1].length).toBeGreaterThan(300)
    expect(outs[2]).toMatch(/NCT\d+/)
    expect(outs[3]).toMatch(/FDA label: .*tamsulosin/i)
    expect(outs[4]).toMatch(/Ohm/)
    expect(outs[5]).toMatch(/arxiv\.org\/abs/)
    expect(outs[6]).toMatch(/Deep learning/i)
    await app.close()
    await llm.close()
  }, 150_000)
})
